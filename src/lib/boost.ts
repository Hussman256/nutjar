// The boost engine: resolve recipients → fund with ecash → split → deliver each share.
import {
  Wallet,
  MintQuoteState,
  getEncodedToken,
  getTokenMetadata,
  decodePaymentRequest,
  PaymentRequestTransportType,
  type Proof,
} from '@cashu/cashu-ts';
import { allocate } from './splits';
import { getInvoice, getPayInfo } from './lnurl';
import {
  DEFAULT_RELAYS,
  KIND_NUTZAP,
  fetchNutzapInfo,
  nip05Pubkey,
  normalizeMint,
  publish,
  toHexPubkey,
  toP2pkPubkey,
  type NutzapInfo,
  type Signer,
} from './nostr';
import type { Event } from 'nostr-tools/pure';
import { amountOf, sum, toWire, type WireProof } from './proofs';
import { removePending, savePending, type PendingBoost } from './pending';

// ---------- recipients ----------

export interface RecipientInput {
  name: string;
  split: number;
  npub?: string; // nostr identity → nutzap if they publish kind 10019
  lnaddress?: string; // lightning address → melt fallback (and NIP-05 lookup)
  type?: string; // raw podcast:valueRecipient type, e.g. "node"
  address?: string;
  fee?: boolean; // podcast:valueRecipient fee="true": split is a percentage off the top
  /** Inline nutzap profile (skips the relay lookup). Requires npub. */
  p2pk?: string;
  mints?: string[];
}

export type Rail = 'nutzap' | 'lightning' | 'request' | 'none';

export interface Recipient extends RecipientInput {
  nutzap?: NutzapInfo;
  request?: string; // NUT-18 payment request (creqA…)
  unsupported?: string; // why this recipient can't be paid with ecash
}

/** Look up how each recipient can receive ecash. Network: relays + .well-known. */
export async function resolveRecipients(inputs: RecipientInput[], relays = DEFAULT_RELAYS): Promise<Recipient[]> {
  return Promise.all(
    inputs.map(async (r): Promise<Recipient> => {
      const out: Recipient = { ...r };
      if (r.type === 'lnaddress' && r.address && !r.lnaddress) out.lnaddress = r.address;
      try {
        let hex = r.npub ? toHexPubkey(r.npub) : null;
        if (hex && r.p2pk && r.mints?.length) {
          out.nutzap = { pubkey: hex, p2pk: toP2pkPubkey(r.p2pk), mints: r.mints.map(normalizeMint), relays: [] };
          return out;
        }
        if (!hex && out.lnaddress) hex = await nip05Pubkey(out.lnaddress);
        if (hex) out.nutzap = (await fetchNutzapInfo(hex, relays)) ?? undefined;
      } catch {
        /* a bad npub just means no nutzap rail */
      }
      if (!out.nutzap && !out.lnaddress) {
        out.unsupported =
          r.type === 'node'
            ? 'Keysend-only (node pubkey): Cashu mints cannot pay keysend.'
            : 'No nutzap profile or lightning address found.';
      }
      return out;
    }),
  );
}

export function railFor(r: Recipient, mint: string): Rail {
  if (r.request) return 'request';
  if (r.nutzap && r.nutzap.mints.includes(normalizeMint(mint))) return 'nutzap';
  if (r.lnaddress) return 'lightning';
  return 'none';
}

/** The mint we should fund at: the widget's choice, else one the main recipient accepts. */
/** Used only when neither the embed nor any recipient names a mint (e.g. Lightning-only feeds). */
export const DEFAULT_MINT = 'https://mint.minibits.cash/Bitcoin';

export function pickMint(recipients: Recipient[], preferred?: string): string | undefined {
  if (preferred) return normalizeMint(preferred);
  for (const r of recipients) if (r.nutzap?.mints[0]) return r.nutzap.mints[0];
  return recipients.some((r) => r.lnaddress || r.request) ? DEFAULT_MINT : undefined;
}

export interface PlanLine {
  recipient: Recipient;
  rail: Rail;
  amount: number;
}

/** Split `total` sats. Fee recipients take their percentage first; unpayable shares are redistributed. */
export function plan(total: number, recipients: Recipient[], mint: string): PlanLine[] {
  const lines = recipients.map((recipient) => ({ recipient, rail: railFor(recipient, mint), amount: 0 }));
  const payable = lines.filter((l) => l.rail !== 'none');
  let rest = total;
  for (const l of payable.filter((l) => l.recipient.fee)) {
    l.amount = Math.floor((total * Math.min(l.recipient.split, 100)) / 100);
    rest -= l.amount;
  }
  const shared = payable.filter((l) => !l.recipient.fee);
  const alloc = allocate(rest, shared.map((l, i) => ({ key: String(i), split: l.recipient.split })));
  shared.forEach((l, i) => (l.amount = alloc.get(String(i)) ?? 0));
  return lines;
}

// ---------- funding ----------

export async function loadWallet(mint: string): Promise<Wallet> {
  const wallet = new Wallet(normalizeMint(mint));
  await wallet.loadMint();
  return wallet;
}

export interface InvoiceFunding {
  invoice: string;
  /** Resolves with the minted proofs once the invoice is paid. */
  wait(signal?: AbortSignal): Promise<Proof[]>;
  pending: PendingBoost;
}

export async function fundWithInvoice(wallet: Wallet, amount: number, description: string): Promise<InvoiceFunding> {
  const quote = await wallet.createMintQuoteBolt11(amount, description);
  const pending: PendingBoost = {
    id: quote.quote,
    mint: wallet.mint.mintUrl,
    amount,
    createdAt: Date.now(),
    quote: quote.quote,
    proofs: [],
  };
  savePending(pending);
  return {
    invoice: quote.request,
    pending,
    wait: async (signal) => {
      for (;;) {
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        const q = await wallet.checkMintQuoteBolt11(quote.quote);
        if (q.state === MintQuoteState.PAID || q.state === MintQuoteState.ISSUED) {
          const proofs = await wallet.mintProofsBolt11(amount, quote.quote);
          savePending({ ...pending, quote: undefined, proofs: proofs.map(toWire) });
          return proofs;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    },
  };
}

/** Claim a pasted token into fresh proofs we control (so the payer can't double-spend mid-boost). */
export async function fundWithToken(token: string): Promise<{ wallet: Wallet; proofs: Proof[]; pending: PendingBoost }> {
  const meta = getTokenMetadata(token.trim());
  if (meta.unit && meta.unit !== 'sat') throw new Error(`Only sat tokens are supported (got ${meta.unit}).`);
  const wallet = await loadWallet(meta.mint);
  const proofs = await wallet.receive(token.trim());
  const pending: PendingBoost = {
    id: crypto.randomUUID(),
    mint: wallet.mint.mintUrl,
    amount: sum(proofs),
    createdAt: Date.now(),
    proofs: proofs.map(toWire),
  };
  savePending(pending);
  return { wallet, proofs, pending };
}

// ---------- delivery ----------

export interface BoostContext {
  message: string;
  senderName?: string;
  signer: Signer;
  /** Podcasting 2.0 identifiers, published as NIP-73 "i" tags so any client can link the boost to the episode. */
  episodeGuid?: string;
  podcastGuid?: string;
  url?: string;
  relays?: string[];
  /** Override relay publishing (tests, or apps with their own relay pool). */
  publish?: (relays: string[], ev: Event) => Promise<string[]>;
}

export interface DeliveryResult {
  line: PlanLine;
  ok: boolean;
  sent: number;
  detail: string;
  eventId?: string;
}

export interface BoostOutcome {
  results: DeliveryResult[];
  change?: { amount: number; token: string };
}

export function nutzapTags(ctx: BoostContext, mint: string, recipientPubkey: string, proofs: WireProof[]): string[][] {
  const tags: string[][] = proofs.map((p) => ['proof', JSON.stringify(p)]);
  tags.push(['u', mint], ['p', recipientPubkey]);
  if (ctx.episodeGuid) tags.push(['i', `podcast:item:guid:${ctx.episodeGuid}`], ['k', 'podcast:item:guid']);
  if (ctx.podcastGuid) tags.push(['i', `podcast:guid:${ctx.podcastGuid}`]);
  if (ctx.url) tags.push(['r', ctx.url]);
  if (ctx.senderName) tags.push(['sender', ctx.senderName.slice(0, 64)]);
  tags.push(['client', 'cashu-boost']);
  return tags;
}

export async function deliver(
  wallet: Wallet,
  proofsIn: Proof[],
  lines: PlanLine[],
  ctx: BoostContext,
  pending: PendingBoost,
  onProgress?: (r: DeliveryResult) => void,
): Promise<BoostOutcome> {
  const mint = wallet.mint.mintUrl;
  let pool: Proof[] = proofsIn;
  const results: DeliveryResult[] = [];
  const checkpoint = () => savePending({ ...pending, proofs: pool.map(toWire) });
  const comment = ctx.senderName ? `${ctx.senderName}: ${ctx.message}` : ctx.message;

  const todo = lines.filter((l) => l.amount > 0 && l.rail !== 'none');
  for (const [i, line] of todo.entries()) {
    const isLast = i === todo.length - 1;
    let result: DeliveryResult;
    try {
      // The last recipient absorbs any swap fees taken along the way.
      const available = sum(pool) - amountOf({ amount: wallet.getFeesForProofs(pool) });
      const amount = isLast ? Math.min(line.amount, available) : line.amount;
      if (amount <= 0) throw new Error('Nothing left after mint fees.');

      if (line.rail === 'nutzap') {
        const info = line.recipient.nutzap!;
        // includeFees: we prepay the recipient's redemption fee so they net exactly `net` sats.
        let net = amount;
        let res: { keep: Proof[]; send: Proof[] } | undefined;
        for (let attempt = 0; !res; attempt++) {
          try {
            res = await wallet.ops.send(net, pool).asP2PK({ pubkey: info.p2pk }).includeFees(true).run();
          } catch (e) {
            // Only the last share may shrink to fit what fees left over.
            if (!isLast || attempt >= 8 || net <= 1 || !/insufficient|not enough|balance/i.test(String(e))) throw e;
            net -= 1;
          }
        }
        const { keep, send } = res;
        pool = keep;
        checkpoint();
        const wire = send.map(toWire);
        const ev = await ctx.signer.sign({
          kind: KIND_NUTZAP,
          created_at: Math.floor(Date.now() / 1000),
          content: ctx.message,
          tags: nutzapTags(ctx, mint, info.pubkey, wire),
        });
        const relays = [...(info.relays.length ? info.relays : []), ...(ctx.relays ?? DEFAULT_RELAYS)];
        const accepted = await (ctx.publish ?? publish)(relays, ev);
        result = { line, ok: true, sent: net, eventId: ev.id, detail: `Nutzap published to ${accepted.length} relay(s)` };
      } else if (line.rail === 'lightning') {
        const info = await getPayInfo(line.recipient.lnaddress!);
        let invoice = await getInvoice(info, amount, comment);
        let quote = await wallet.createMeltQuoteBolt11(invoice);
        let need = amountOf({ amount: quote.amount.add(quote.fee_reserve) });
        if (need > amount) {
          // Re-invoice for the share minus the routing reserve so the recipient's share covers its own fee.
          const reserve = amountOf({ amount: quote.fee_reserve });
          invoice = await getInvoice(info, amount - reserve, comment);
          quote = await wallet.createMeltQuoteBolt11(invoice);
          need = amountOf({ amount: quote.amount.add(quote.fee_reserve) });
        }
        const { keep, send } = await wallet.send(need, pool, { includeFees: true });
        pool = keep;
        checkpoint();
        const res = await wallet.meltProofsBolt11(quote, send);
        pool = [...pool, ...((res.change ?? []) as Proof[])];
        checkpoint();
        result = { line, ok: true, sent: amountOf({ amount: quote.amount }), detail: `Paid ${line.recipient.lnaddress} over Lightning` };
      } else {
        const pr = decodePaymentRequest(line.recipient.request!);
        const post = pr.getTransport(PaymentRequestTransportType.POST);
        if (!post) throw new Error('Only HTTP POST payment requests are supported.');
        const { keep, send } = await wallet.ops.sendToRequest(pr, pool, pr.amount ? undefined : amount).run();
        pool = keep;
        checkpoint();
        const body = pr.encodePayload(mint, send, { memo: comment.slice(0, 280) });
        const res = await fetch(post.target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        if (!res.ok) throw new Error(`Payment request endpoint answered ${res.status}.`);
        result = { line, ok: true, sent: sum(send), detail: 'Delivered to the payment request (NUT-18)' };
      }
    } catch (e) {
      result = { line, ok: false, sent: 0, detail: e instanceof Error ? e.message : String(e) };
    }
    results.push(result);
    onProgress?.(result);
  }

  let change: BoostOutcome['change'];
  if (pool.length && sum(pool) > 0) {
    change = { amount: sum(pool), token: getEncodedToken({ mint, proofs: pool, unit: 'sat' }) };
    checkpoint(); // keep it recoverable until the listener copies it
  } else {
    removePending(pending.id);
  }
  return { results, change };
}
