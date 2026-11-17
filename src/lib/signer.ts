// One signer interface for the creator side: a NIP-07 browser extension on desktop,
// or a remote signer app over Nostr Connect (NIP-46) on phones: Amber, nsec.app, and others.
// The user's private key never touches this app in either case.
import type { EventTemplate, VerifiedEvent, Event } from 'nostr-tools/pure';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { BunkerSigner, createNostrConnectURI, parseBunkerInput, type BunkerPointer } from 'nostr-tools/nip46';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { getPool, nip07 } from './nostr';

export interface AppSigner {
  kind: 'extension' | 'remote';
  getPublicKey(): Promise<string>;
  signEvent(t: EventTemplate): Promise<Event | VerifiedEvent>;
  nip44Encrypt(pubkey: string, text: string): Promise<string>;
  nip44Decrypt(pubkey: string, text: string): Promise<string>;
  close(): Promise<void>;
}

/** Relays used for the Nostr Connect handshake. relay.nsec.app is the usual NIP-46 relay (nsec.app needs it) but is listed last in case it is down. */
export const CONNECT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://nostr.mom', 'wss://relay.primal.net', 'wss://relay.nsec.app'];
const PERMS = ['get_public_key', 'sign_event:10019', 'sign_event:17375', 'nip44_encrypt', 'nip44_decrypt'];
const SESSION = 'nutjar:signer-session';

interface Session {
  clientSk: string; // a throwaway key for this app's side of the NIP-46 channel, NOT the user's key
  bp: BunkerPointer;
  pubkey: string;
}

export function hasExtension(): boolean {
  return !!nip07();
}

export function extensionSigner(): AppSigner {
  const ext = nip07();
  if (!ext) throw new Error('No Nostr extension found.');
  const need44 = () => {
    if (!ext.nip44) throw new Error('Your extension cannot do NIP-44 encryption. Update Alby or nos2x.');
    return ext.nip44;
  };
  return {
    kind: 'extension',
    getPublicKey: () => ext.getPublicKey(),
    signEvent: (t) => ext.signEvent(t),
    nip44Encrypt: (pk, text) => need44().encrypt(pk, text),
    nip44Decrypt: (pk, text) => need44().decrypt(pk, text),
    close: async () => {},
  };
}

function wrapRemote(b: BunkerSigner): AppSigner {
  return {
    kind: 'remote',
    getPublicKey: () => b.getPublicKey(),
    signEvent: (t) => b.signEvent(t),
    nip44Encrypt: (pk, text) => b.nip44Encrypt(pk, text),
    nip44Decrypt: (pk, text) => b.nip44Decrypt(pk, text),
    close: () => b.close(),
  };
}

function save(clientSk: Uint8Array, bp: BunkerPointer, pubkey: string) {
  try {
    // The connect secret is single-use; don't keep it.
    localStorage.setItem(SESSION, JSON.stringify({ clientSk: bytesToHex(clientSk), bp: { ...bp, secret: null }, pubkey } satisfies Session));
  } catch {
    /* private mode: user signs in again next time */
  }
}

const onauth = (url: string) => window.open(url, '_blank', 'noopener');
// A person has to pick up their phone and tap Approve, so wait much longer than the library's 30 s default.
const REQUEST_TIMEOUT = 120_000;
const params = () => ({ pool: getPool(), onauth, timeout: REQUEST_TIMEOUT });

/** Ask for the user's pubkey, asking again if the signer app was asleep and missed the request. */
async function askPubkey(b: BunkerSigner, onRetry?: () => void): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await b.getPublicKey();
    } catch (e) {
      if (attempt >= 3 || !/timeout|failed to send/.test((e as Error).message)) throw e;
      onRetry?.();
    }
  }
}

export interface PendingConnect {
  uri: string;
  signer: Promise<AppSigner>;
  cancel(): void;
}

/** Flow A: show a nostrconnect:// link/QR; the signer app scans or opens it and calls back. */
export function startNostrConnect(on: { connected?: () => void; retry?: () => void; offline?: () => void } = {}): PendingConnect {
  const clientSk = generateSecretKey();
  const secret = bytesToHex(generateSecretKey()).slice(0, 16);
  const uri = createNostrConnectURI({
    clientPubkey: getPublicKey(clientSk),
    relays: CONNECT_RELAYS,
    secret,
    perms: PERMS,
    name: 'Nutjar',
    url: location.origin,
    image: new URL('icon-512.png', location.href).href,
  });
  const abort = new AbortController();
  // We chose the relays ourselves, so skip the library's switch_relays request: it can move the
  // channel to other relays while the first real request is still waiting for an answer.
  const listen = async (): Promise<BunkerSigner> => {
    // If no relay could be reached, keep trying with the same link: the QR on screen stays valid.
    for (let attempt = 1; ; attempt++) {
      try {
        return await BunkerSigner.fromURI(clientSk, uri, { ...params(), skipSwitchRelays: true }, abort.signal);
      } catch (e) {
        if (abort.signal.aborted || attempt >= 5 || !/subscription closed/.test((e as Error)?.message ?? '')) throw e;
        on.offline?.();
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  };
  const signer = listen().then(async (b) => {
    on.connected?.();
    const pubkey = await askPubkey(b, on.retry);
    save(clientSk, b.bp, pubkey);
    return wrapRemote(b);
  });
  return { uri, signer, cancel: () => abort.abort() };
}

/** Flow B: the user pastes a bunker:// URL (or a NIP-05 that advertises a bunker). */
export async function connectBunker(input: string): Promise<AppSigner> {
  const bp = await parseBunkerInput(input.trim());
  if (!bp) throw new Error('That is not a bunker:// link.');
  const clientSk = generateSecretKey();
  const b = BunkerSigner.fromBunker(clientSk, bp, params());
  await b.connect({ name: 'Nutjar', url: location.origin });
  const pubkey = await askPubkey(b);
  save(clientSk, bp, pubkey);
  return wrapRemote(b);
}

/** Reconnect a saved remote-signer session without asking the user again. */
export function restoreSession(): { signer: AppSigner; pubkey: string } | null {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION) ?? 'null') as Session | null;
    if (!s?.clientSk || !s.bp?.pubkey) return null;
    const b = BunkerSigner.fromBunker(hexToBytes(s.clientSk), s.bp, params());
    return { signer: wrapRemote(b), pubkey: s.pubkey };
  } catch {
    return null;
  }
}

export function forgetSession(): void {
  try {
    localStorage.removeItem(SESSION);
  } catch {
    /* ignore */
  }
}
