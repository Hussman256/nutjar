import { getEncodedToken } from '@cashu/cashu-ts';
import { DEFAULT_RELAYS, KIND_WALLET, nip07, npub, parseNutzapInfo, publish, type NutzapInfo } from '../lib/nostr';
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
$('btn-connect').addEventListener('click', async () => {
  const ext = nip07();
  if (!ext) {
    $('connect-err').textContent = 'No Nostr extension found. Install Alby or nos2x, then reload this page.';
    return;
  }
  try {
    me = await ext.getPublicKey();
    show('connect', false);
    $('status').textContent = 'Looking up your nutzap profile…';
    show('main');
    const own = await fetchOwn(me, DEFAULT_RELAYS);
    info = own.info ? parseNutzapInfo(own.info) : null;
    if (info?.relays.length) relays = [...new Set([...info.relays, ...DEFAULT_RELAYS])];

    if (own.wallet) {
      if (!ext.nip44) throw new Error('Your extension cannot decrypt NIP-44 messages. Try a recent Alby or nos2x.');
      const w = parseWalletContent(await ext.nip44.decrypt(me, own.wallet.content));
      privkey = w.privkey;
    }

    if (!info && !privkey) {
      show('main', false);
      $<HTMLTextAreaElement>('relays').value = DEFAULT_RELAYS.join('\n');
      show('setup');
      return;
    }
    describe();
    $('my-snippet').textContent = snippet();
    await load();
    watchNutzaps(me, relays, async (z) => {
      if (zaps.has(z.id)) return;
      await refreshStates([z]);
      zaps.set(z.id, z);
      render();
    });
  } catch (e) {
    show('connect');
    $('connect-err').textContent = (e as Error).message;
  }
});

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
  return `<script src="${origin}cashu-boost.js" defer></script>\n<cashu-boost npub="${npub(me)}"></cashu-boost>`;
}

// ---------- setup ----------
$('btn-setup').addEventListener('click', async () => {
  const ext = nip07()!;
  const mints = lines('mints');
  const rels = lines('relays');
  $('setup-err').textContent = '';
  try {
    if (!mints.length) throw new Error('Add at least one mint.');
    for (const m of [...mints, ...rels]) new URL(m);
    if (!ext.nip44) throw new Error('Your extension cannot encrypt NIP-44 messages. Try a recent Alby or nos2x.');
    const key = newP2pkKey();
    const encrypted = await ext.nip44.encrypt(me, walletContent(key.priv, mints));
    const walletEv = await ext.signEvent({ kind: KIND_WALLET, created_at: Math.floor(Date.now() / 1000), content: encrypted, tags: [] });
    const infoEv = await ext.signEvent(nutzapInfoTemplate(key.pub, mints, rels));
    relays = [...new Set([...rels, ...DEFAULT_RELAYS])];
    await publish(relays, walletEv);
    await publish(relays, infoEv);
    privkey = key.priv;
    info = parseNutzapInfo(infoEv);
    show('setup', false);
    show('main');
    describe();
    $('my-snippet').textContent = snippet();
    await load();
  } catch (e) {
    $('setup-err').textContent = (e as Error).message;
  }
});

// ---------- collect & cash out ----------
$('btn-refresh').addEventListener('click', () => load());

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
