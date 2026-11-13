// Creator side: find nutzaps addressed to me, see which are unclaimed, and redeem them.
import { Wallet, getEncodedToken, type Proof } from '@cashu/cashu-ts';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { Event } from 'nostr-tools/pure';
import { DEFAULT_RELAYS, KIND_NUTZAP, KIND_NUTZAP_INFO, KIND_WALLET, getPool, normalizeMint } from './nostr';
import { fromWire, sum, type WireProof } from './proofs';
import { getInvoice, getPayInfo } from './lnurl';

export interface Nutzap {
  id: string;
  from: string; // signer pubkey (often ephemeral)
  to: string; // recipient pubkey (p tag)
  senderName?: string;
  message: string;
  mint: string;
  proofs: WireProof[];
  amount: number;
  createdAt: number;
  episodeGuid?: string;
  podcastGuid?: string;
  url?: string;
  state?: 'unclaimed' | 'claimed' | 'pending' | 'unknown';
}

export function parseNutzap(ev: Event): Nutzap | null {
  const get = (n: string) => ev.tags.find((t) => t[0] === n)?.[1];
  const mint = get('u');
  const proofs: WireProof[] = [];
  for (const t of ev.tags) {
    if (t[0] !== 'proof') continue;
    try {
      const p = JSON.parse(t[1]);
      if (p && typeof p.secret === 'string' && typeof p.C === 'string') proofs.push({ ...p, amount: Number(p.amount) });
    } catch {
      /* skip malformed proof tag */
    }
  }
  if (!mint || proofs.length === 0) return null;
  const is = ev.tags.filter((t) => t[0] === 'i').map((t) => t[1]);
  return {
    id: ev.id,
    from: ev.pubkey,
    to: get('p') ?? '',
    senderName: get('sender'),
    message: ev.content,
    mint: normalizeMint(mint),
    proofs,
    amount: sum(proofs),
    createdAt: ev.created_at,
    episodeGuid: is.find((i) => i.startsWith('podcast:item:guid:'))?.slice('podcast:item:guid:'.length),
    podcastGuid: is.find((i) => i.startsWith('podcast:guid:'))?.slice('podcast:guid:'.length),
    url: get('r'),
  };
}

export async function fetchNutzaps(pubkey: string | string[], relays = DEFAULT_RELAYS, since?: number): Promise<Nutzap[]> {
  const events = await getPool().querySync(relays, { kinds: [KIND_NUTZAP], '#p': ([] as string[]).concat(pubkey), limit: 500, ...(since ? { since } : {}) }, { maxWait: 5000 });
  const seen = new Set<string>();
  return events
    .filter((e) => !seen.has(e.id) && seen.add(e.id))
    .map(parseNutzap)
    .filter((z): z is Nutzap => z !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Live subscription for new nutzaps. Returns an unsubscribe function. */
export function watchNutzaps(pubkey: string | string[], relays: string[], onZap: (z: Nutzap) => void): () => void {
  const sub = getPool().subscribeMany(relays, { kinds: [KIND_NUTZAP], '#p': ([] as string[]).concat(pubkey), since: Math.floor(Date.now() / 1000) - 5 }, {
    onevent: (ev) => {
      const z = parseNutzap(ev);
      if (z) onZap(z);
    },
  });
  return () => sub.close();
}

const wallets = new Map<string, Promise<Wallet>>();
export function walletFor(mint: string): Promise<Wallet> {
  const key = normalizeMint(mint);
  if (!wallets.has(key)) {
    const w = new Wallet(key);
    wallets.set(key, w.loadMint().then(() => w));
  }
  return wallets.get(key)!;
}

/** Ask each mint (NUT-07) whether the proofs are spent. Mutates `state` on each nutzap. */
export async function refreshStates(zaps: Nutzap[]): Promise<void> {
  const byMint = new Map<string, Nutzap[]>();
  for (const z of zaps) byMint.set(z.mint, [...(byMint.get(z.mint) ?? []), z]);
  await Promise.all(
    [...byMint].map(async ([mint, list]) => {
      try {
        const wallet = await walletFor(mint);
        const states = await wallet.checkProofsStates(list.flatMap((z) => z.proofs.map((p) => ({ secret: p.secret, id: p.id }))));
        let i = 0;
        for (const z of list) {
          const s = states.slice(i, i + z.proofs.length).map((x) => String(x.state));
          i += z.proofs.length;
          z.state = s.every((x) => x === 'UNSPENT') ? 'unclaimed' : s.some((x) => x === 'PENDING') ? 'pending' : 'claimed';
          // Show what the creator actually nets: the sender prepaid the mint's redemption fee.
          try {
            z.amount = sum(z.proofs) - wallet.getFeesForProofs(z.proofs.map(fromWire)).toNumber();
          } catch {
            /* unknown keyset: keep the gross amount */
          }
        }
      } catch {
        for (const z of list) z.state = 'unknown';
      }
    }),
  );
}

export interface Redeemed {
  mint: string;
  amount: number;
  token: string;
  proofs: Proof[];
}

/** Swap every unclaimed nutzap into fresh, unlocked ecash, one token per mint. */
export async function redeem(zaps: Nutzap[], privkey: string): Promise<Redeemed[]> {
  const byMint = new Map<string, WireProof[]>();
  for (const z of zaps.filter((z) => z.state === 'unclaimed')) byMint.set(z.mint, [...(byMint.get(z.mint) ?? []), ...z.proofs]);
  const out: Redeemed[] = [];
  for (const [mint, wire] of byMint) {
    const wallet = await walletFor(mint);
    const proofs = await wallet.receive({ mint, unit: 'sat', proofs: wire.map(fromWire) }, { privkey });
    out.push({ mint, amount: sum(proofs), proofs, token: getEncodedToken({ mint, unit: 'sat', proofs }) });
  }
  return out;
}

/** Cash redeemed ecash out to a lightning address. Returns sats delivered. */
export async function meltToAddress(r: Redeemed, address: string): Promise<{ paid: number; change?: Redeemed }> {
  const wallet = await walletFor(r.mint);
  const info = await getPayInfo(address);
  const fees = wallet.getFeesForProofs(r.proofs).toNumber();
  let target = r.amount - fees;
  let quote = await wallet.createMeltQuoteBolt11(await getInvoice(info, target));
  const reserve = quote.fee_reserve.toNumber();
  if (quote.amount.toNumber() + reserve + fees > r.amount) {
    target = r.amount - reserve - fees;
    if (target <= 0) throw new Error('Too small to pay out over Lightning after fees.');
    quote = await wallet.createMeltQuoteBolt11(await getInvoice(info, target));
  }
  const res = await wallet.meltProofsBolt11(quote, r.proofs);
  const change = (res.change ?? []) as Proof[];
  return {
    paid: quote.amount.toNumber(),
    change: change.length ? { mint: r.mint, amount: sum(change), proofs: change, token: getEncodedToken({ mint: r.mint, unit: 'sat', proofs: change }) } : undefined,
  };
}

// ---------- receiving setup (NIP-60 wallet key + NIP-61 nutzap info) ----------

export function newP2pkKey(): { priv: string; pub: string } {
  const sk = secp256k1.utils.randomSecretKey();
  return { priv: bytesToHex(sk), pub: bytesToHex(secp256k1.getPublicKey(sk, true)) };
}

export function p2pkPubFromPriv(priv: string): string {
  return bytesToHex(secp256k1.getPublicKey(hexToBytes(priv), true));
}

export function nutzapInfoTemplate(p2pkPub: string, mints: string[], relays: string[]) {
  return {
    kind: KIND_NUTZAP_INFO,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: [...relays.map((r) => ['relay', r]), ...mints.map((m) => ['mint', normalizeMint(m), 'sat']), ['pubkey', p2pkPub]],
  };
}

/** NIP-60 wallet event content (before NIP-44 encryption to self). */
export function walletContent(priv: string, mints: string[]): string {
  return JSON.stringify([['privkey', priv], ...mints.map((m) => ['mint', normalizeMint(m)])]);
}

export function parseWalletContent(plain: string): { privkey?: string; mints: string[] } {
  const tags = JSON.parse(plain) as string[][];
  return { privkey: tags.find((t) => t[0] === 'privkey')?.[1], mints: tags.filter((t) => t[0] === 'mint').map((t) => t[1]) };
}

/**
 * Newest copy of my nutzap profile (10019) and wallet key (17375).
 * Each relay gets its own deadline so one hung relay can't stall sign-in. If *no* relay answers we throw
 * instead of returning "nothing found": treating silence as "new user" could overwrite a real profile.
 */
export async function fetchOwn(pubkey: string, relays: string[], deadlineMs = 6000) {
  const pool = getPool();
  let answered = 0;
  const perRelay = await Promise.all(
    relays.map(async (r): Promise<Event[]> => {
      const res = await Promise.race([
        pool.querySync([r], { kinds: [KIND_NUTZAP_INFO, KIND_WALLET], authors: [pubkey] }, { maxWait: deadlineMs - 500 }),
        new Promise<null>((ok) => setTimeout(() => ok(null), deadlineMs)),
      ]).catch(() => null);
      if (res === null) return [];
      answered++;
      return res;
    }),
  );
  const events: Event[] = perRelay.flat();
  if (answered === 0) throw new Error("Couldn't reach any Nostr relay. Check your connection and try again.");
  const newest = (kind: number) => events.filter((e) => e.kind === kind).sort((a, b) => b.created_at - a.created_at)[0] ?? null;
  return { info: newest(KIND_NUTZAP_INFO), wallet: newest(KIND_WALLET) };
}
