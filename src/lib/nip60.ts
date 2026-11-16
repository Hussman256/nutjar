// NIP-60 ecash storage: the creator's collected sats live on their relays, encrypted to themselves,
// so the balance follows their Nostr account to any device and any NIP-60 wallet can read it.
//   kind 7375  token event   content = nip44({ mint, unit, proofs, del })
//   kind 7376  history event content = nip44([["direction","in"|"out"],["amount",n],["unit","sat"],["e",id,"","created"|"destroyed"]...])
//                             public tags: ["e", <nutzap id>, "", "redeemed"] (+ ["p", sender]) so other clients skip redeemed nutzaps
//   kind 5     deletion of spent token events, tagged ["k","7375"]
import type { Event, EventTemplate } from 'nostr-tools/pure';
import { getPool, normalizeMint } from './nostr';
import { sum, type WireProof } from './proofs';

export const KIND_TOKEN = 7375;
export const KIND_HISTORY = 7376;
export const KIND_DELETE = 5;

/** What NIP-60 needs from a signer: sign, and NIP-44 encrypt/decrypt to yourself. */
export interface Nip60Signer {
  signEvent(t: EventTemplate): Promise<Event>;
  nip44Encrypt(pubkey: string, text: string): Promise<string>;
  nip44Decrypt(pubkey: string, text: string): Promise<string>;
}

export interface TokenEvent {
  id: string;
  mint: string;
  proofs: WireProof[];
  amount: number;
  createdAt: number;
}

const now = () => Math.floor(Date.now() / 1000);

export function tokenContent(mint: string, proofs: WireProof[], del: string[] = []): string {
  return JSON.stringify({ mint: normalizeMint(mint), unit: 'sat', proofs, ...(del.length ? { del } : {}) });
}

export function parseTokenContent(plain: string): { mint: string; proofs: WireProof[]; del: string[] } | null {
  try {
    const c = JSON.parse(plain);
    if (!c || typeof c.mint !== 'string' || !Array.isArray(c.proofs)) return null;
    if (c.unit && c.unit !== 'sat') return null;
    const proofs = (c.proofs as WireProof[])
      .filter((p) => p && typeof p.secret === 'string' && typeof p.C === 'string' && typeof p.id === 'string')
      .map((p) => ({ ...p, amount: Number(p.amount) }));
    return { mint: normalizeMint(c.mint), proofs, del: Array.isArray(c.del) ? c.del.filter((d: unknown) => typeof d === 'string') : [] };
  } catch {
    return null;
  }
}

/** Encrypt + sign a token event holding `proofs`. `del` lists token events these proofs replace. */
export async function signTokenEvent(s: Nip60Signer, me: string, mint: string, proofs: WireProof[], del: string[] = []): Promise<Event> {
  const content = await s.nip44Encrypt(me, tokenContent(mint, proofs, del));
  return s.signEvent({ kind: KIND_TOKEN, created_at: now(), content, tags: [] });
}

export function deleteTemplate(ids: string[]): EventTemplate {
  return { kind: KIND_DELETE, created_at: now(), content: '', tags: [...ids.map((id) => ['e', id]), ['k', String(KIND_TOKEN)]] };
}

export interface HistoryRef {
  id: string;
  marker: 'created' | 'destroyed';
}

export async function signHistoryEvent(
  s: Nip60Signer,
  me: string,
  direction: 'in' | 'out',
  amount: number,
  refs: HistoryRef[],
  redeemed: { id: string; from: string }[] = [],
): Promise<Event> {
  const secret = [['direction', direction], ['amount', String(amount)], ['unit', 'sat'], ...refs.map((r) => ['e', r.id, '', r.marker])];
  const content = await s.nip44Encrypt(me, JSON.stringify(secret));
  const tags = redeemed.flatMap((z) => [['e', z.id, '', 'redeemed'], ['p', z.from]]);
  return s.signEvent({ kind: KIND_HISTORY, created_at: now(), content, tags });
}

/** Raw token + deletion events of mine. Throws if no relay answers (silence must not read as "empty wallet"). */
export async function fetchWalletEvents(pubkey: string, relays: string[], deadlineMs = 6000): Promise<{ tokens: Event[]; deleted: Set<string> }> {
  const pool = getPool();
  let answered = 0;
  const perRelay = await Promise.all(
    relays.map(async (r): Promise<Event[]> => {
      const res = await Promise.race([
        pool.querySync([r], { kinds: [KIND_TOKEN, KIND_DELETE], authors: [pubkey] }, { maxWait: deadlineMs - 500 }),
        new Promise<null>((ok) => setTimeout(() => ok(null), deadlineMs)),
      ]).catch(() => null);
      if (res === null) return [];
      answered++;
      return res;
    }),
  );
  if (answered === 0) throw new Error("Couldn't reach any Nostr relay to load your balance.");
  const seen = new Set<string>();
  const all = perRelay.flat().filter((e) => !seen.has(e.id) && seen.add(e.id));
  const deleted = new Set<string>();
  for (const e of all) if (e.kind === KIND_DELETE) for (const t of e.tags) if (t[0] === 'e' && t[1]) deleted.add(t[1]);
  return { tokens: all.filter((e) => e.kind === KIND_TOKEN), deleted };
}

/**
 * Decrypt token events into the live set: drops events that were deleted (kind 5) or replaced (another
 * token's `del`), and de-duplicates proofs that appear in more than one event.
 */
export async function readTokens(s: Pick<Nip60Signer, 'nip44Decrypt'>, me: string, events: Event[], deleted: Set<string>): Promise<TokenEvent[]> {
  const parsed: (TokenEvent & { del: string[] })[] = [];
  for (const ev of events) {
    if (deleted.has(ev.id)) continue;
    try {
      const c = parseTokenContent(await s.nip44Decrypt(me, ev.content));
      if (c) parsed.push({ id: ev.id, mint: c.mint, proofs: c.proofs, amount: sum(c.proofs), createdAt: ev.created_at, del: c.del });
    } catch {
      /* not decryptable by this signer: skip */
    }
  }
  const replaced = new Set(parsed.flatMap((t) => t.del));
  const secrets = new Set<string>();
  return parsed
    .filter((t) => !replaced.has(t.id))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(({ del: _del, ...t }) => {
      const proofs = t.proofs.filter((p) => !secrets.has(p.secret) && secrets.add(p.secret));
      return { ...t, proofs, amount: sum(proofs) };
    })
    .filter((t) => t.proofs.length > 0);
}
