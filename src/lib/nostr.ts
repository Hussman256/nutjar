// Nostr helpers: NIP-61 nutzap info, NIP-05 lookups, NIP-07 / ephemeral signing.
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';

export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom', 'wss://offchain.pub'];

export const KIND_NUTZAP = 9321;
export const KIND_NUTZAP_INFO = 10019;
export const KIND_WALLET = 17375;
export const KIND_HISTORY = 7376;

let pool: SimplePool | undefined;
export function getPool(): SimplePool {
  return (pool ??= new SimplePool());
}

export interface NutzapInfo {
  pubkey: string; // nostr pubkey of the recipient (hex)
  p2pk: string; // compressed P2PK pubkey to lock ecash to ("02…")
  mints: string[];
  relays: string[];
}

export function normalizeMint(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** Accepts npub, nprofile or 64-char hex. */
export function toHexPubkey(input: string): string {
  const v = input.trim();
  if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase();
  const decoded = nip19.decode(v);
  if (decoded.type === 'npub') return decoded.data;
  if (decoded.type === 'nprofile') return decoded.data.pubkey;
  throw new Error('Expected an npub or hex pubkey.');
}

export function npub(hex: string): string {
  return nip19.npubEncode(hex);
}

/** Nostr keys are x-only; NIP-61 says lock to the "02"-prefixed compressed form. */
export function toP2pkPubkey(key: string): string {
  const k = key.trim().toLowerCase();
  return k.length === 64 ? `02${k}` : k;
}

export function parseNutzapInfo(ev: Event): NutzapInfo | null {
  const tag = (name: string) => ev.tags.filter((t) => t[0] === name);
  const p2pk = tag('pubkey')[0]?.[1];
  const mints = tag('mint')
    .filter((t) => !t[2] || t.slice(2).includes('sat'))
    .map((t) => normalizeMint(t[1]));
  if (!p2pk || mints.length === 0) return null;
  return {
    pubkey: ev.pubkey,
    p2pk: toP2pkPubkey(p2pk),
    mints,
    relays: tag('relay').map((t) => t[1]).filter(Boolean),
  };
}

export async function fetchNutzapInfo(pubkey: string, relays = DEFAULT_RELAYS): Promise<NutzapInfo | null> {
  const ev = await getPool().get(relays, { kinds: [KIND_NUTZAP_INFO], authors: [pubkey] }, { maxWait: 4000 });
  return ev ? parseNutzapInfo(ev) : null;
}

/** NIP-05 lookup, used to find the nostr key behind a lightning address (alice@getalby.com). */
export async function nip05Pubkey(address: string): Promise<string | null> {
  const [name, domain] = address.trim().toLowerCase().split('@');
  if (!name || !domain) return null;
  try {
    const res = await fetch(`https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const hex = data?.names?.[name];
    return typeof hex === 'string' && /^[0-9a-f]{64}$/i.test(hex) ? hex.toLowerCase() : null;
  } catch {
    return null;
  }
}

export interface Signer {
  pubkey: string;
  sign(t: EventTemplate): Promise<Event>;
  ephemeral: boolean;
}

interface Nip07 {
  getPublicKey(): Promise<string>;
  signEvent(t: EventTemplate): Promise<Event>;
  nip44?: { encrypt(pubkey: string, text: string): Promise<string>; decrypt(pubkey: string, text: string): Promise<string> };
}

export function nip07(): Nip07 | undefined {
  return (globalThis as unknown as { nostr?: Nip07 }).nostr;
}

export function ephemeralSigner(): Signer {
  const sk = generateSecretKey();
  return {
    pubkey: getPublicKey(sk),
    ephemeral: true,
    sign: async (t) => finalizeEvent(t, sk),
  };
}

export async function extensionSigner(): Promise<Signer> {
  const ext = nip07();
  if (!ext) throw new Error('No nostr extension found (try Alby or nos2x).');
  const pubkey = await ext.getPublicKey();
  return { pubkey, ephemeral: false, sign: (t) => ext.signEvent(t) };
}

/** Publish to relays; resolves with the relays that accepted it. Throws if none did. */
export async function publish(relays: string[], ev: Event): Promise<string[]> {
  const unique = [...new Set(relays)];
  const results = await Promise.allSettled(getPool().publish(unique, ev));
  const ok = unique.filter((_, i) => results[i].status === 'fulfilled');
  if (ok.length === 0) throw new Error('No relay accepted the event.');
  return ok;
}
