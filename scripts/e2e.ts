// End-to-end check of the boost engine against testnut.cashu.space (fake Lightning, auto-paid invoices).
// Run: npm run e2e
import { Wallet } from '@cashu/cashu-ts';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import { deleteTemplate, readTokens, signHistoryEvent, signTokenEvent, type Nip60Signer } from '../src/lib/nip60';
import { unspent } from '../src/lib/inbox';
import { bytesToHex } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { deliver, fundWithInvoice, loadWallet, plan, type Recipient } from '../src/lib/boost';
import { ephemeralSigner } from '../src/lib/nostr';
import { fromWire, sum, toWire } from '../src/lib/proofs';
import { allocate } from '../src/lib/splits';

const MINT = 'https://testnut.cashu.space';
let failures = 0;
const check = (cond: unknown, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

// Split math
const a = allocate(100, [{ key: 'a', split: 1 }, { key: 'b', split: 1 }, { key: 'c', split: 1 }]);
check([...a.values()].reduce((x, y) => x + y, 0) === 100, 'allocate sums to total (100 / 3 ways)');
check(a.get('a') === 34 && a.get('b') === 33, 'largest remainder goes to first share');

// Two nutzap recipients (60/40) + one keysend-only recipient that must be skipped.
function recipientKeys() {
  const nostrSk = generateSecretKey();
  const p2pkSk = secp256k1.utils.randomSecretKey();
  return { nostr: getPublicKey(nostrSk), p2pkPriv: bytesToHex(p2pkSk), p2pkPub: bytesToHex(secp256k1.getPublicKey(p2pkSk, true)) };
}
const host = recipientKeys();
const guest = recipientKeys();
const recipients: Recipient[] = [
  { name: 'Host', split: 60, nutzap: { pubkey: host.nostr, p2pk: host.p2pkPub, mints: [MINT], relays: [] } },
  { name: 'Guest', split: 40, nutzap: { pubkey: guest.nostr, p2pk: guest.p2pkPub, mints: [MINT], relays: [] } },
  { name: 'Keysend node', split: 10, type: 'node', unsupported: 'keysend' },
];

const lines = plan(100, recipients, MINT);
check(lines[0].amount === 60 && lines[1].amount === 40 && lines[2].amount === 0, `plan redistributes skipped share: ${lines.map((l) => l.amount)}`);

const wallet = await loadWallet(MINT);
const funding = await fundWithInvoice(wallet, 100, 'e2e boost');
check(funding.invoice.startsWith('lnbc'), 'mint returned a bolt11 invoice');
const proofs = await funding.wait();
check(sum(proofs) === 100, `minted 100 sats of ecash (got ${sum(proofs)})`);

const published: Event[] = [];
const outcome = await deliver(wallet, proofs, lines, {
  message: 'Great episode!',
  senderName: 'e2e',
  signer: ephemeralSigner(),
  episodeGuid: 'ep-guid-123',
  podcastGuid: 'pod-guid-abc',
  publish: async (_r, ev) => {
    published.push(ev);
    return ['test'];
  },
}, funding.pending);

check(outcome.results.length === 2 && outcome.results.every((r) => r.ok), `both deliveries ok: ${outcome.results.map((r) => r.detail).join(' | ')}`);
check(published.length === 2, 'two nutzap events produced');

check(outcome.results[0].sent === 60, `host share is exactly 60 (got ${outcome.results[0].sent})`);
console.log(`      guest nets ${outcome.results[1].sent} after mint fees; change ${outcome.change?.amount ?? 0}`);
for (const [i, [ev, who]] of ([[published[0], host], [published[1], guest]] as const).entries()) {
  check(ev.kind === 9321 && verifyEvent(ev), 'event is a valid signed kind 9321');
  check(ev.content === 'Great episode!', 'message is the event content');
  check(ev.tags.some((t) => t[0] === 'p' && t[1] === who.nostr), 'p tag = recipient');
  check(ev.tags.some((t) => t[0] === 'u' && t[1] === MINT), 'u tag = mint');
  check(ev.tags.some((t) => t[0] === 'i' && t[1] === 'podcast:item:guid:ep-guid-123'), 'NIP-73 episode tag');
  const tokProofs = ev.tags.filter((t) => t[0] === 'proof').map((t) => JSON.parse(t[1]));
  check(tokProofs.every((p) => typeof p.amount === 'number' && JSON.parse(p.secret)[0] === 'P2PK'), 'proofs are P2PK-locked with numeric amounts');
  check(tokProofs.every((p) => JSON.parse(p.secret)[1].data === who.p2pkPub), 'locked to the recipient p2pk key');

  // Someone else cannot redeem…
  const stranger = new Wallet(MINT);
  await stranger.loadMint();
  let stolen = false;
  let why = '';
  try {
    await stranger.receive({ mint: MINT, proofs: tokProofs, unit: 'sat' });
    stolen = true;
  } catch (e) {
    why = (e as Error).message;
  }
  check(!stolen && /sig|witness|p2pk|lock/i.test(why), `nutzap cannot be redeemed without the key (${why})`);
  // …the recipient can.
  const got = await stranger.receive({ mint: MINT, proofs: tokProofs, unit: 'sat' }, { privkey: who.p2pkPriv });
  check(sum(got) === outcome.results[i].sent, `recipient redeemed exactly what the widget reported: ${sum(got)} sats`);
}

// ---------- Lightning route: a recipient with only a lightning address ----------
// A local mock LNURL server hands out invoices created by the same test mint, so the melt settles
// inside testnut. No third-party accounts are touched.
console.log('\nLightning-address route');
const { createServer } = await import('node:http');
const invoiceWallet = await loadWallet(MINT);
const issued: { quote: string; comment: string | null }[] = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://127.0.0.1');
  res.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/.well-known/lnurlp/alice') {
    res.end(JSON.stringify({ tag: 'payRequest', callback: `http://${req.headers.host}/cb`, minSendable: 1000, maxSendable: 1e9, commentAllowed: 140 }));
  } else if (url.pathname === '/cb') {
    const q = await invoiceWallet.createMintQuoteBolt11(Number(url.searchParams.get('amount')) / 1000);
    issued.push({ quote: q.quote, comment: url.searchParams.get('comment') });
    res.end(JSON.stringify({ pr: q.request, routes: [] }));
  } else {
    res.statusCode = 404;
    res.end('{}');
  }
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;

const lnLines = plan(50, [{ name: 'Editor', split: 1, lnaddress: `alice@127.0.0.1:${port}` }], MINT);
check(lnLines[0].rail === 'lightning' && lnLines[0].amount === 50, 'lightning-only recipient routes over Lightning');
const lnFunding = await fundWithInvoice(wallet, 50, 'e2e ln boost');
const lnProofs = await lnFunding.wait();
const lnOutcome = await deliver(wallet, lnProofs, lnLines, { message: 'Nice edit!', senderName: 'e2e', signer: ephemeralSigner() }, lnFunding.pending);
check(lnOutcome.results[0]?.ok, `melt succeeded: ${lnOutcome.results[0]?.detail}`);
check(issued.length >= 1 && issued.at(-1)!.comment === 'e2e: Nice edit!', `LUD-12 comment carried the message (${issued.at(-1)?.comment})`);
const paidQuote = await invoiceWallet.checkMintQuoteBolt11(issued.at(-1)!.quote);
check(String(paidQuote.state) === 'PAID', `recipient's invoice is paid (${paidQuote.state})`);
console.log(`      delivered ${lnOutcome.results[0]?.sent} sats, change back to listener: ${lnOutcome.change?.amount ?? 0}`);
server.close();

// ---------- NIP-60: collected ecash stored on Nostr, encrypted to the creator ----------
console.log('\nNIP-60 balance storage');
{
  const sk = generateSecretKey();
  const me = getPublicKey(sk);
  const ck = nip44.getConversationKey(sk, me);
  const signer: Nip60Signer = {
    signEvent: async (t) => finalizeEvent(t, sk),
    nip44Encrypt: async (_pk, text) => nip44.encrypt(text, ck),
    nip44Decrypt: async (_pk, text) => nip44.decrypt(text, ck),
  };
  const f = await fundWithInvoice(wallet, 64, "e2e nip60");
  const orig = await f.wait();
  const split = await wallet.send(10, orig); // swaps: the original proofs are now spent
  const minted = [...split.keep, ...split.send].map(toWire);
  const first = await signTokenEvent(signer, me, MINT, minted);
  check(first.kind === 7375 && verifyEvent(first) && !first.content.includes(minted[0].secret), "token event is a signed kind 7375 with encrypted proofs");
  let live = await readTokens(signer, me, [first], new Set());
  check(live.length === 1 && live[0].amount === sum(minted) && minted.length > 1, `balance reads back from the event: ${live[0]?.amount} sats in ${minted.length} proofs`);
  const second = await signTokenEvent(signer, me, MINT, minted.slice(1), [first.id]);
  live = await readTokens(signer, me, [first, second], new Set());
  check(live.length === 1 && live[0].id === second.id, "a replacing event (del) hides the old one");
  live = await readTokens(signer, me, [first, second], new Set([second.id]));
  check(live.length === 1 && live[0].id === first.id, "a deleted event (kind 5) is ignored");
  const del = deleteTemplate([first.id]);
  check(del.kind === 5 && del.tags.some((t) => t[0] === "k" && t[1] === "7375"), "deletion is kind 5 tagged k=7375");
  const hist = await signHistoryEvent(signer, me, "in", 64, [{ id: first.id, marker: "created" }], [{ id: "ab".repeat(32), from: "cd".repeat(32) }]);
  const histPlain = JSON.parse(await signer.nip44Decrypt(me, hist.content)) as string[][];
  check(hist.kind === 7376 && histPlain.some((t) => t[0] === "direction" && t[1] === "in"), "history event records direction in, encrypted");
  check(hist.tags.some((t) => t[0] === "e" && t[3] === "redeemed"), "history marks the nutzap as redeemed (public tag)");
  check((await unspent(MINT, orig.map(toWire))).length === 0, "proofs spent elsewhere are detected and dropped");
  check((await unspent(MINT, minted)).length === minted.length, "unspent proofs are kept");
}

// Flaky network while waiting for payment: status checks fail twice, then minting fails once.
// The wait must ride it out instead of giving up (a fan's connection dropping mid-boost).
{
  const real = await loadWallet(MINT);
  let checkFails = 2;
  let mintFails = 1;
  const flaky = Object.assign(Object.create(real), {
    mint: real.mint,
    createMintQuoteBolt11: real.createMintQuoteBolt11.bind(real),
    checkMintQuoteBolt11: (id: string) => (checkFails-- > 0 ? Promise.reject(new TypeError('Failed to fetch')) : real.checkMintQuoteBolt11(id)),
    mintProofsBolt11: (amt: number, id: string) => (mintFails-- > 0 ? Promise.reject(new TypeError('Failed to fetch')) : real.mintProofsBolt11(amt, id)),
  }) as typeof real;
  const f = await fundWithInvoice(flaky, 21, 'e2e flaky network');
  const t0 = Date.now();
  const proofs = await f.wait().catch((e) => (console.log('  wait threw:', e?.message), []));
  check(sum(proofs) === 21, `payment wait survives dropped connections (2 failed checks + 1 failed mint, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
