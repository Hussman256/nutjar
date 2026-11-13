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
  type Nutzap,
  type Redeemed,
} from '../lib/inbox';
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

// ---------- collected tokens, kept until dismissed ----------
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
const toRedeemed = (k: Kept): Redeemed => {
  const proofs = k.proofs.map(fromWire);
  return { mint: k.mint, amount: k.amount, proofs, token: getEncodedToken({ mint: k.mint, unit: 'sat', proofs }) };
};

function renderKept() {
  const list = kept();
  show('collected', list.length > 0);
  $('tokens').innerHTML = list
    .map((k, i) => `<div style="margin-bottom:12px"><b>${k.amount.toLocaleString('en-US')} sats</b> <span class="small muted">${esc(new URL(k.mint).host)}</span>
      <div class="box mono small">${esc(toRedeemed(k).token)}</div>
      <div class="row" style="margin-top:6px"><button class="ghost" data-copy="${i}">Copy</button><button class="ghost" data-dismiss="${i}">I've saved it</button></div></div>`)
    .join('');
  $('tokens').querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((b) =>
    b.addEventListener('click', () => navigator.clipboard?.writeText(toRedeemed(kept()[Number(b.dataset.copy)]).token)),
  );
  $('tokens').querySelectorAll<HTMLButtonElement>('[data-dismiss]').forEach((b) =>
    b.addEventListener('click', () => {
      if (!confirm('Remove this token from this browser? Make sure it is in a wallet first.')) return;
      saveKept(kept().filter((_, i) => i !== Number(b.dataset.dismiss)));
      renderKept();
    }),
  );
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
  pendingConnect = startNostrConnect();
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
      if ((e as Error).name !== 'AbortError') $('remote-status').textContent = `Connection failed: ${(e as Error).message}`;
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
    const got = await redeem(all, privkey);
    saveKept([...kept(), ...got.map((r) => ({ mint: r.mint, amount: r.amount, proofs: r.proofs.map(toWire) }))]);
    await refreshStates(all);
    renderKept();
  } catch (e) {
    $('collect-err').textContent = (e as Error).message;
  }
  render();
});

$('btn-melt').addEventListener('click', async () => {
  const address = $<HTMLInputElement>('ln').value.trim();
  if (!address.includes('@')) {
    $('melt-out').textContent = 'Enter a lightning address like you@getalby.com.';
    return;
  }
  const btn = $<HTMLButtonElement>('btn-melt');
  btn.disabled = true;
  const msgs: string[] = [];
  let remaining = kept();
  for (const k of [...remaining]) {
    try {
      const res = await meltToAddress(toRedeemed(k), address);
      remaining = remaining.filter((x) => x !== k);
      if (res.change) remaining.push({ mint: k.mint, amount: res.change.amount, proofs: res.change.proofs.map(toWire) });
      msgs.push(`<span class="ok">Sent ${res.paid} sats to ${esc(address)}.</span>`);
    } catch (e) {
      msgs.push(`<span class="err">${esc(new URL(k.mint).host)}: ${esc((e as Error).message)}</span>`);
    }
    saveKept(remaining);
  }
  $('melt-out').innerHTML = msgs.join('<br>');
  btn.disabled = false;
  renderKept();
});

renderKept();
