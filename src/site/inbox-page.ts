import './pwa';
import { getEncodedToken } from '@cashu/cashu-ts';
import QRCode from 'qrcode';
import { DEFAULT_RELAYS, KIND_WALLET, npub, parseNutzapInfo, publish, type NutzapInfo } from '../lib/nostr';
import { connectBunker, extensionSigner, forgetSession, hasExtension, restoreSession, startNostrConnect, type AppSigner, type PendingConnect } from '../lib/signer';
import {
  fetchNutzaps,
  fetchOwn,
  meltToAddress,
  newP2pkKey,
  nutzapInfoTemplate,
  p2pkPubFromPriv,
  parseWalletContent,
  redeem,
  refreshStates,
  walletContent,
  watchNutzaps,
  unspent,
  type Nutzap,
  type Redeemed,
} from '../lib/inbox';
import { deleteTemplate, fetchWalletEvents, readTokens, signHistoryEvent, signTokenEvent, type HistoryRef, type TokenEvent } from '../lib/nip60';
import type { Event } from 'nostr-tools/pure';
import { fromWire, toWire, type WireProof } from '../lib/proofs';
import { esc, zapHtml } from './zaplist';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const show = (id: string, on = true) => $(id).classList.toggle('hidden', !on);
const lines = (id: string) => $<HTMLTextAreaElement>(id).value.split('\n').map((s) => s.trim()).filter(Boolean);

let me = '';
let relays = DEFAULT_RELAYS;
let privkey: string | undefined;
let info: NutzapInfo | null = null;
const zaps = new Map<string, Nutzap>();

// ---------- balance: NIP-60 token events on my relays (encrypted to me) ----------
// Collected ecash is written to Nostr so it survives a cleared browser and shows on every device.
// Anything not yet saved to a relay waits in localStorage ("unsynced") and is retried; it is never dropped.
const STORE = 'cashu-boost:collected';
interface Kept { mint: string; amount: number; proofs: WireProof[] }
const kept = (): Kept[] => {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? '[]');
  } catch {
    return [];
  }
};
const saveKept = (k: Kept[]) => {
  try {
    localStorage.setItem(STORE, JSON.stringify(k));
  } catch {
    /* private mode: tokens are still on screen */
  }
};
const encode = (mint: string, proofs: WireProof[]) => getEncodedToken({ mint, unit: 'sat', proofs: proofs.map(fromWire) });
const toRedeemed = (mint: string, proofs: WireProof[]): Redeemed => ({ mint, amount: sumWire(proofs), proofs: proofs.map(fromWire), token: encode(mint, proofs) });
const sumWire = (p: WireProof[]) => p.reduce((t, x) => t + x.amount, 0);
const fmt = (n: number) => n.toLocaleString('en-US');

let tokens: TokenEvent[] = [];
let balanceState: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
let balanceErr = '';

/** Token events grouped by mint. */
function byMint(): Map<string, TokenEvent[]> {
  const m = new Map<string, TokenEvent[]>();
  for (const t of tokens) m.set(t.mint, [...(m.get(t.mint) ?? []), t]);
  return m;
}

/** Encrypt, sign and publish one token event. */
async function saveToken(mint: string, proofs: WireProof[], del: string[] = []): Promise<Event> {
  const ev = await signTokenEvent(signer!, me, mint, proofs, del);
  await publish(relays, ev);
  return ev;
}

async function logHistory(direction: 'in' | 'out', amount: number, refs: HistoryRef[], redeemed: { id: string; from: string }[] = []) {
  try {
    await publish(relays, await signHistoryEvent(signer!, me, direction, amount, refs, redeemed));
  } catch {
    /* history is nice to have; the balance is what matters */
  }
}

async function deleteTokens(ids: string[]) {
  if (!ids.length) return;
  try {
    await publish(relays, await signer!.signEvent(deleteTemplate(ids)));
  } catch {
    /* the replacing event's `del` already hides them from NIP-60 clients */
  }
}

/** Push anything still only on this device up to the relays. */
async function syncLocal(): Promise<void> {
  let rest = kept();
  for (const k of [...rest]) {
    try {
      const ev = await saveToken(k.mint, k.proofs);
      rest = rest.filter((x) => x !== k);
      saveKept(rest);
      tokens.unshift({ id: ev.id, mint: k.mint, proofs: k.proofs, amount: sumWire(k.proofs), createdAt: ev.created_at });
    } catch {
      /* stays local, retried next time */
    }
  }
}

async function loadBalance(): Promise<void> {
  if (!signer) return;
  balanceState = 'loading';
  renderBalance();
  try {
    const { tokens: evs, deleted } = await fetchWalletEvents(me, relays);
    if (evs.length && signer.kind === 'remote') $('balance-note').textContent = `Approve ${evs.length} decrypt request(s) in your signer app to show your balance…`;
    tokens = await readTokens(signer, me, evs, deleted);
    // Drop proofs that were spent elsewhere (e.g. pasted into another wallet), and tidy the events up.
    for (const [mint, list] of byMint()) {
      const all = list.flatMap((t) => t.proofs);
      const live = await unspent(mint, all);
      if (live.length === all.length) continue;
      const ids = list.map((t) => t.id);
      tokens = tokens.filter((t) => t.mint !== mint);
      if (live.length) {
        const ev = await saveToken(mint, live, ids);
        tokens.unshift({ id: ev.id, mint, proofs: live, amount: sumWire(live), createdAt: ev.created_at });
      }
      await deleteTokens(ids);
    }
    await syncLocal();
    balanceState = 'ready';
  } catch (e) {
    balanceState = 'error';
    balanceErr = (e as Error).message;
  }
  renderBalance();
}

function renderBalance() {
  const local = kept();
  const groups = [...byMint()];
  const total = tokens.reduce((t, x) => t + x.amount, 0) + local.reduce((t, k) => t + k.amount, 0);
  show('collected', balanceState !== 'idle' || local.length > 0);
  $('balance-total').textContent = balanceState === 'loading' ? 'Loading…' : `${fmt(total)} sats`;
  $('balance-note').textContent =
    balanceState === 'error'
      ? `Couldn't load your saved balance: ${balanceErr}`
      : 'Saved on your Nostr relays, encrypted so only you can read it. Sign in on any device to see it.';
  $('tokens').innerHTML =
    groups
      .map(([mint, list]) => {
        const amount = list.reduce((t, x) => t + x.amount, 0);
        return `<div class="row" style="justify-content:space-between;margin-bottom:8px"><span><b>${fmt(amount)} sats</b> <span class="small muted">${esc(new URL(mint).host)}</span></span>
          <span><button class="ghost" data-export="${esc(mint)}">Move to a Cashu wallet</button></span></div>`;
      })
      .join('') +
    (local.length
      ? `<div class="notice" style="margin-top:8px">⚠️ ${fmt(local.reduce((t, k) => t + k.amount, 0))} sats are saved on this device only. <button class="ghost" id="btn-sync">Save to Nostr</button></div>`
      : '') +
    `<div id="export-box" class="hidden" style="margin-top:10px"><p class="small">Paste this token into any Cashu wallet (Minibits, cashu.me, eNuts…), then tap <b>Done</b>.</p>
      <div class="box mono small" id="export-token"></div>
      <div class="row" style="margin-top:6px"><button class="ghost" id="btn-export-copy">Copy</button><button id="btn-export-done">Done, it's in my wallet</button><button class="ghost" id="btn-export-cancel">Cancel</button></div></div>`;
  $('tokens').querySelectorAll<HTMLButtonElement>('[data-export]').forEach((b) => b.addEventListener('click', () => openExport(b.dataset.export!)));
  document.getElementById('btn-sync')?.addEventListener('click', async () => {
    await syncLocal();
    renderBalance();
  });
  $<HTMLButtonElement>('btn-melt').disabled = total === 0;
}

let exporting: string | undefined;
function openExport(mint: string) {
  exporting = mint;
  const proofs = (byMint().get(mint) ?? []).flatMap((t) => t.proofs);
  $('export-token').textContent = encode(mint, proofs);
  show('export-box');
  $('btn-export-copy').onclick = () => navigator.clipboard?.writeText($('export-token').textContent ?? '');
  $('btn-export-cancel').onclick = () => show('export-box', false);
  $('btn-export-done').onclick = async () => {
    if (!exporting) return;
    const list = byMint().get(exporting) ?? [];
    const all = list.flatMap((t) => t.proofs);
    const live = await unspent(exporting, all);
    if (live.length === all.length && !confirm("The mint doesn't see this token as received yet. Remove it from your Nutjar balance anyway? Only do this if it's safely in another wallet.")) return;
    const ids = list.map((t) => t.id);
    if (live.length && live.length < all.length) {
      // Part was received elsewhere: keep the rest.
      const ev = await saveToken(exporting, live, ids);
      tokens = tokens.filter((t) => t.mint !== exporting);
      tokens.unshift({ id: ev.id, mint: exporting, proofs: live, amount: sumWire(live), createdAt: ev.created_at });
    } else {
      tokens = tokens.filter((t) => t.mint !== exporting);
    }
    await deleteTokens(ids);
    await logHistory('out', sumWire(all) - (live.length < all.length ? sumWire(live) : 0), ids.map((id) => ({ id, marker: 'destroyed' as const })));
    exporting = undefined;
    renderBalance();
  };
}

// ---------- boosts ----------
function render() {
  const list = [...zaps.values()].sort((a, b) => b.createdAt - a.createdAt);
  $('zaps').innerHTML = list.length ? list.map((z) => zapHtml(z)).join('') : '<p class="muted">No boosts yet. Share your embed code!</p>';
  const open = list.filter((z) => z.state === 'unclaimed');
  const total = open.reduce((t, z) => t + z.amount, 0);
  $('collect-summary').textContent = open.length ? `${total.toLocaleString('en-US')} sats in ${open.length} boost(s) waiting.` : 'Nothing to collect right now.';
  $<HTMLButtonElement>('btn-collect').disabled = !open.length || !privkey;
}

async function load() {
  const list = await fetchNutzaps(me, relays);
  await refreshStates(list);
  for (const z of list) zaps.set(z.id, z);
  render();
}

// ---------- sign in ----------
let signer: AppSigner | undefined;
let pendingConnect: PendingConnect | undefined;

async function signIn(s: AppSigner, knownPubkey?: string) {
  signer = s;
  pendingConnect?.cancel();
  $('connect-err').textContent = '';
  try {
    me = knownPubkey ?? (await s.getPublicKey());
    show('connect', false);
    show('signed-in');
    $('status').textContent = 'Looking up your nutzap profile…';
    show('main');
    const own = await fetchOwn(me, DEFAULT_RELAYS);
    info = own.info ? parseNutzapInfo(own.info) : null;
    if (info?.relays.length) relays = [...new Set([...info.relays, ...DEFAULT_RELAYS])];

    if (own.wallet) {
      $('status').textContent = s.kind === 'remote' ? 'Approve the decrypt request in your signer app…' : 'Unlocking your receiving key…';
      privkey = parseWalletContent(await s.nip44Decrypt(me, own.wallet.content)).privkey;
    }

    if (!info && !privkey) {
      show('main', false);
      $<HTMLTextAreaElement>('relays').value = DEFAULT_RELAYS.join('\n');
      show('setup');
      return;
    }
    await start();
  } catch (e) {
    show('main', false);
    show('signed-in', false);
    show('connect');
    $('connect-err').textContent = (e as Error).message;
  }
}

$('btn-connect').addEventListener('click', () => {
  if (!hasExtension()) {
    $('connect-err').textContent = 'No Nostr extension found. Install Alby or nos2x, or use a signer app below.';
    return;
  }
  signIn(extensionSigner());
});

$('btn-remote').addEventListener('click', async () => {
  pendingConnect?.cancel();
  pendingConnect = startNostrConnect({
    connected: () => ($('remote-status').textContent = 'Connected. Open your signer app and approve the request…'),
    offline: () => ($('remote-status').textContent = "Can't reach the Nostr relays from this device. Trying again…"),
    retry: () => ($('remote-status').textContent = 'Still waiting. Keep your signer app open on screen and approve the request…'),
  });
  const { uri } = pendingConnect;
  show('remote');
  show('btn-remote', false);
  $<HTMLAnchorElement>('remote-open').href = uri;
  $('remote-qr').innerHTML = await QRCode.toString(uri, { type: 'svg', margin: 1 });
  $('remote-uri').textContent = uri;
  $('remote-status').textContent = 'Waiting for your signer app…';
  pendingConnect.signer.then(
    (s) => signIn(s),
    (e) => {
      if ((e as Error).name === 'AbortError') return;
      const timedOut = /timeout/.test((e as Error).message);
      $('remote-status').textContent = timedOut
        ? "Your signer app didn't answer. Open it, check it is connected to its relays, then reload this page and try again."
        : /subscription closed/.test((e as Error).message)
          ? "This device can't reach the Nostr relays. Check your internet connection, then reload this page and try again."
          : `Connection failed: ${(e as Error).message}`;
    },
  );
});
$('remote-copy').addEventListener('click', () => navigator.clipboard?.writeText(pendingConnect?.uri ?? ''));

$('btn-bunker').addEventListener('click', async () => {
  $('connect-err').textContent = '';
  try {
    $('bunker-status').textContent = 'Connecting… approve the request in your signer.';
    signIn(await connectBunker($<HTMLInputElement>('bunker').value));
  } catch (e) {
    $('bunker-status').textContent = '';
    $('connect-err').textContent = (e as Error).message;
  }
});

$('signed-in').addEventListener('click', async () => {
  forgetSession();
  unwatch?.();
  await signer?.close();
  location.reload();
});

// Returning user with a saved signer-app session: reconnect without asking again.
const saved = restoreSession();
if (saved) signIn(saved.signer, saved.pubkey);

let unwatch: (() => void) | undefined;
async function start() {
  describe();
  $('my-snippet').textContent = snippet();
  const link = new URL('./b/?npub=' + npub(me), location.href).href;
  $('my-link').textContent = link;
  $<HTMLAnchorElement>('my-link-open').href = link;
  $('my-qr').innerHTML = await QRCode.toString(link, { type: 'svg', margin: 1 });
  await load();
  await loadBalance();
  unwatch?.();
  unwatch = watchNutzaps(me, relays, async (z) => {
    if (zaps.has(z.id)) return;
    await refreshStates([z]);
    zaps.set(z.id, z);
    render();
  });
}

function describe() {
  const mints = info?.mints.map((m) => new URL(m).host).join(', ') ?? 'none';
  if (privkey && info && p2pkPubFromPriv(privkey) !== info.p2pk) {
    $('status').innerHTML = `⚠️ Your published nutzap key belongs to a different wallet than the key this page can decrypt. You can see boosts here, but collect them in the wallet that published your profile.`;
    privkey = undefined;
  } else if (!privkey) {
    $('status').innerHTML = `Signed in as <span class="mono">${npub(me).slice(0, 20)}…</span>. Your nutzap profile was made by another wallet, so you can read boosts here and collect them in that wallet. Accepted mints: ${esc(mints)}.`;
  } else {
    $('status').innerHTML = `Signed in as <span class="mono">${npub(me).slice(0, 20)}…</span>. Receiving at: ${esc(mints)}.`;
  }
}

function snippet() {
  const origin = location.origin + location.pathname.replace(/[^/]*$/, '');
  return `<script src="${origin}nutjar.js" defer></script>\n<cashu-boost npub="${npub(me)}"></cashu-boost>`;
}

// ---------- setup ----------
$('btn-setup').addEventListener('click', async () => {
  const s = signer!;
  const mints = lines('mints');
  const rels = lines('relays');
  $('setup-err').textContent = '';
  try {
    if (!mints.length) throw new Error('Add at least one mint.');
    for (const m of [...mints, ...rels]) new URL(m);
    if (s.kind === 'remote') $('setup-err').textContent = 'Approve 3 requests in your signer app: encrypt, then sign twice.';
    const key = newP2pkKey();
    const encrypted = await s.nip44Encrypt(me, walletContent(key.priv, mints));
    const walletEv = await s.signEvent({ kind: KIND_WALLET, created_at: Math.floor(Date.now() / 1000), content: encrypted, tags: [] });
    const infoEv = await s.signEvent(nutzapInfoTemplate(key.pub, mints, rels));
    $('setup-err').textContent = '';
    relays = [...new Set([...rels, ...DEFAULT_RELAYS])];
    await publish(relays, walletEv);
    await publish(relays, infoEv);
    privkey = key.priv;
    info = parseNutzapInfo(infoEv);
    show('setup', false);
    show('main');
    await start();
  } catch (e) {
    $('setup-err').textContent = (e as Error).message;
  }
});

// ---------- collect & cash out ----------
$('btn-refresh').addEventListener('click', () => load());
$('btn-copy-link').addEventListener('click', () => navigator.clipboard?.writeText($('my-link').textContent ?? ''));

$('btn-collect').addEventListener('click', async () => {
  if (!privkey) return;
  const btn = $<HTMLButtonElement>('btn-collect');
  btn.disabled = true;
  $('collect-err').textContent = '';
  try {
    const all = [...zaps.values()];
    await refreshStates(all);
    const claimed = all.filter((z) => z.state === 'unclaimed');
    const got = await redeem(all, privkey);
    // Safety first: the fresh ecash goes to this device before anything else can fail.
    const fresh: Kept[] = got.map((r) => ({ mint: r.mint, amount: r.amount, proofs: r.proofs.map(toWire) }));
    saveKept([...kept(), ...fresh]);
    await refreshStates(all);
    render();
    renderBalance();
    // Then save to Nostr (NIP-60) and record which nutzaps were redeemed (NIP-61).
    const before = new Set(tokens.map((t) => t.id));
    await syncLocal();
    const created = tokens.filter((t) => !before.has(t.id)).map((t) => ({ id: t.id, marker: 'created' as const }));
    if (created.length) await logHistory('in', got.reduce((t, r) => t + r.amount, 0), created, claimed.map((z) => ({ id: z.id, from: z.from })));
  } catch (e) {
    $('collect-err').textContent = (e as Error).message;
  }
  render();
  renderBalance();
});

$('btn-melt').addEventListener('click', async () => {
  const address = $<HTMLInputElement>('ln').value.trim();
  if (!address.includes('@')) {
    $('melt-out').textContent = 'Enter a lightning address like you@getalby.com.';
    return;
  }
  const btn = $<HTMLButtonElement>('btn-melt');
  btn.disabled = true;
  $('melt-out').textContent = 'Sending…';
  const msgs: string[] = [];
  await syncLocal();
  for (const [mint, list] of byMint()) {
    const ids = list.map((t) => t.id);
    try {
      const live = await unspent(mint, list.flatMap((t) => t.proofs));
      if (!live.length) throw new Error('Already spent elsewhere.');
      const res = await meltToAddress(toRedeemed(mint, live), address);
      tokens = tokens.filter((t) => t.mint !== mint);
      const refs: HistoryRef[] = ids.map((id) => ({ id, marker: 'destroyed' }));
      if (res.change) {
        const change = res.change.proofs.map(toWire);
        try {
          const ev = await saveToken(mint, change, ids);
          tokens.unshift({ id: ev.id, mint, proofs: change, amount: sumWire(change), createdAt: ev.created_at });
          refs.push({ id: ev.id, marker: 'created' });
        } catch {
          saveKept([...kept(), { mint, amount: res.change.amount, proofs: change }]);
        }
      }
      await deleteTokens(ids);
      await logHistory('out', res.paid, refs);
      msgs.push(`<span class="ok">Sent ${fmt(res.paid)} sats to ${esc(address)}.</span>`);
    } catch (e) {
      msgs.push(`<span class="err">${esc(new URL(mint).host)}: ${esc((e as Error).message)}</span>`);
    }
  }
  // Anything that still couldn't be saved to Nostr can be cashed out straight from this device.
  let rest = kept();
  for (const k of [...rest]) {
    try {
      const res = await meltToAddress(toRedeemed(k.mint, k.proofs), address);
      rest = rest.filter((x) => x !== k);
      if (res.change) rest.push({ mint: k.mint, amount: res.change.amount, proofs: res.change.proofs.map(toWire) });
      msgs.push(`<span class="ok">Sent ${fmt(res.paid)} sats to ${esc(address)}.</span>`);
    } catch (e) {
      msgs.push(`<span class="err">${esc(new URL(k.mint).host)}: ${esc((e as Error).message)}</span>`);
    }
    saveKept(rest);
  }
  $('melt-out').innerHTML = msgs.join('<br>') || 'Nothing to send.';
  btn.disabled = false;
  renderBalance();
});

renderBalance();
