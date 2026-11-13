import './pwa';
// Landing-page demo: two throwaway creators on the testnut mint, a live widget, and their inbox.
import '../widget/cashu-boost';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import { DEFAULT_RELAYS, npub } from '../lib/nostr';
import { fetchNutzaps, newP2pkKey, redeem, refreshStates, watchNutzaps, type Nutzap } from '../lib/inbox';
import QRCode from 'qrcode';
import { esc, zapHtml } from './zaplist';

const MINT = 'https://testnut.cashu.space';

interface DemoCreator {
  name: string;
  split: number;
  nostrSk: string;
  pubkey: string;
  p2pkPriv: string;
  p2pkPub: string;
}

function makeCreator(name: string, split: number): DemoCreator {
  const sk = generateSecretKey();
  const k = newP2pkKey();
  return { name, split, nostrSk: bytesToHex(sk), pubkey: getPublicKey(sk), p2pkPriv: k.priv, p2pkPub: k.pub };
}

function demoCreators(): DemoCreator[] {
  const KEY = 'cashu-boost:demo-creators';
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (Array.isArray(saved) && saved.length === 2) return saved;
  } catch {
    /* ignore */
  }
  const fresh = [makeCreator('Host', 60), makeCreator('Guest', 40)];
  try {
    localStorage.setItem(KEY, JSON.stringify(fresh));
  } catch {
    /* fine: new demo identities next visit */
  }
  return fresh;
}

const creators = demoCreators();
const widget = document.getElementById('demo-widget')!;
widget.setAttribute(
  'recipients',
  JSON.stringify([
    ...creators.map((c) => ({ name: c.name, split: c.split, npub: npub(c.pubkey), p2pk: c.p2pkPub, mints: [MINT] })),
    // A keysend-only recipient, like many Podcasting 2.0 feeds have: shown as skipped, share redistributed.
    { name: 'Hosting provider (keysend)', split: 10, type: 'node', address: '03ae9f91a0cb8ff43840e3c322c4c61f019d8c1c3cea15a25cfc425ac605e61a4a' },
  ]),
);

const $ = (id: string) => document.getElementById(id)!;
$('demo-who').innerHTML = creators
  .map((c) => `${esc(c.name)} (${c.split}%): <span class="mono">${npub(c.pubkey).slice(0, 16)}…</span>`)
  .join(' · ');

const zaps = new Map<string, Nutzap>();
let fresh = new Set<string>();

function render() {
  const list = [...zaps.values()].sort((a, b) => b.createdAt - a.createdAt);
  const who = (z: Nutzap) => creators.find((c) => c.pubkey === z.to)?.name ?? '?';
  $('demo-zaps').innerHTML = list.length
    ? list.map((z) => zapHtml(z, ` <span class="tag">to ${esc(who(z))}</span>`)).join('')
    : '<p class="muted small">Nothing yet. Your boost will pop in here.</p>';
  for (const id of fresh) $('demo-zaps').querySelector(`[data-id="${id}"]`)?.classList.add('flash');
  fresh = new Set();
  const open = list.filter((z) => z.state === 'unclaimed');
  const total = open.reduce((t, z) => t + z.amount, 0);
  ($('demo-collect') as HTMLButtonElement).disabled = open.length === 0;
  $('demo-total').textContent = open.length ? `${total.toLocaleString('en-US')} sats waiting` : '';
}

async function add(list: Nutzap[]) {
  const mine = list.filter((z) => z.mint === MINT && !zaps.has(z.id));
  if (!mine.length) return;
  await refreshStates(mine);
  for (const z of mine) {
    zaps.set(z.id, z);
    fresh.add(z.id);
  }
  render();
}

const pubkeys = creators.map((c) => c.pubkey);
fetchNutzaps(pubkeys, DEFAULT_RELAYS).then(add);
watchNutzaps(pubkeys, DEFAULT_RELAYS, (z) => add([z]));
// Relays can be slow to echo our own events; the widget tells us when it's done too.
widget.addEventListener('boost', () => setTimeout(() => fetchNutzaps(pubkeys, DEFAULT_RELAYS, Math.floor(Date.now() / 1000) - 120).then(add), 1500));

$('demo-collect').addEventListener('click', async () => {
  const btn = $('demo-collect') as HTMLButtonElement;
  btn.disabled = true;
  $('demo-out').textContent = 'Collecting…';
  try {
    const all = [...zaps.values()];
    await refreshStates(all);
    const parts: string[] = [];
    for (const c of creators) {
      const got = await redeem(all.filter((z) => z.to === c.pubkey), c.p2pkPriv);
      for (const r of got) parts.push(`<b>${esc(c.name)}</b> collected ${r.amount} sats:<div class="box mono">${esc(r.token)}</div>`);
    }
    await refreshStates(all);
    $('demo-out').innerHTML = parts.length
      ? `<p class="ok">Unlocked with each creator's key and swapped for fresh ecash (test sats):</p>${parts.join('')}`
      : 'Nothing left to collect.';
  } catch (e) {
    $('demo-out').innerHTML = `<span class="err">${esc((e as Error).message)}</span>`;
  }
  render();
});

const origin = location.origin + location.pathname.replace(/[^/]*$/, '');
$('snippet').textContent = `<script src="${origin}nutjar.js" defer></script>
<cashu-boost npub="npub1yourkey…" lnaddress="you@getalby.com" label="Episode 42"></cashu-boost>`;

// ---------- page life ----------
// Jar counter: the illustrated total plus anything boosted in this visit's demo.
const jarTotal = document.getElementById('jar-total');
let boosted = 2810;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
function bump(by: number) {
  const from = boosted;
  boosted += by;
  if (!jarTotal) return;
  if (reduce) return void (jarTotal.textContent = boosted.toLocaleString('en-US') + ' sats');
  const t0 = performance.now();
  const step = (t: number) => {
    const k = Math.min(1, (t - t0) / 900);
    jarTotal.textContent = Math.round(from + (boosted - from) * (1 - Math.pow(1 - k, 3))).toLocaleString('en-US') + ' sats';
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
widget.addEventListener('boost', (e) => bump((e as CustomEvent<{ amount: number }>).detail.amount));

// Example QR for the boost-link card.
const qrBox = document.getElementById('ways-qr');
if (qrBox) QRCode.toString(origin + 'b/?to=you@getalby.com', { type: 'svg', margin: 0 }).then((svg) => (qrBox.innerHTML = svg));

// Split bars grow when they scroll into view.
const bars = document.querySelectorAll<HTMLElement>('.split-row .bar span[data-w]');
const grow = () => bars.forEach((b) => (b.style.width = b.dataset.w + '%'));
if (reduce || !('IntersectionObserver' in window)) grow();
else {
  const io = new IntersectionObserver((entries) => {
    if (entries.some((en) => en.isIntersecting)) {
      grow();
      io.disconnect();
    }
  }, { threshold: 0.4 });
  const panel = document.getElementById('split-panel');
  if (panel) io.observe(panel);
}

// ---------- the console: blue keys step the amount, red key boosts ----------
type BoostEl = HTMLElement & { stepAmount(d: 1 | -1): number; press(): void };
const consoleEl = document.getElementById('console');
const boostEl = widget as BoostEl;
document.getElementById('key-less')?.addEventListener('click', () => boostEl.stepAmount(-1));
document.getElementById('key-more')?.addEventListener('click', () => boostEl.stepAmount(1));
document.getElementById('key-boost')?.addEventListener('click', () => {
  consoleEl?.classList.add('busy');
  consoleEl?.classList.remove('lit');
  boostEl.press();
});
// Any route to boosting (keys or the on-screen button) hides the hint until it lands.
widget.shadowRoot?.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest?.('[data-act="invoice"]')) consoleEl?.classList.add('busy');
});
widget.addEventListener('boost', () => {
  consoleEl?.classList.remove('busy');
  consoleEl?.classList.add('lit');
});
