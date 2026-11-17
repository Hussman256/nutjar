// /b/ : a creator's shareable boost page, or (with no params) the link maker.
import './pwa';
import '../widget/cashu-boost';
import QRCode from 'qrcode';
import { DEFAULT_RELAYS, getPool, nip05Pubkey, npub as toNpub, toHexPubkey } from '../lib/nostr';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const base = new URL('./', location.href);
base.search = '';

interface Profile {
  name?: string;
  display_name?: string;
  picture?: string;
  banner?: string;
  about?: string;
  nip05?: string;
}

// Profile fields come from strangers on Nostr: only https images, and text goes in via textContent.
const safeImg = (u?: string) => (typeof u === 'string' && /^https:\/\//i.test(u) && u.length < 2048 ? u : undefined);

async function fetchProfile(hex: string): Promise<Profile | null> {
  const ev = await getPool().get(DEFAULT_RELAYS, { kinds: [0], authors: [hex] }, { maxWait: 4000 });
  if (!ev) return null;
  try {
    return JSON.parse(ev.content) as Profile;
  } catch {
    return null;
  }
}

function showImg(id: string, url?: string) {
  const img = $<HTMLImageElement>(id);
  const u = safeImg(url);
  if (!u) return;
  img.onload = () => {
    img.style.display = 'block';
    if (id === 'p-avatar-img') $('p-avatar-emoji').style.display = 'none';
  };
  img.referrerPolicy = 'no-referrer';
  img.src = u;
}

async function creatorPage() {
  const npubParam = params.get('npub') ?? undefined;
  const to = params.get('to') ?? undefined;
  $('page').classList.remove('hidden');

  const w = document.createElement('cashu-boost');
  if (npubParam) w.setAttribute('npub', npubParam);
  if (to) w.setAttribute('lnaddress', to);
  for (const k of ['label', 'amounts', 'mint', 'skin', 'theme']) {
    const v = params.get(k);
    if (v) w.setAttribute(k, v);
  }
  if (!params.get('label')) w.setAttribute('label', 'Send a boost with a message');
  if (params.get('skin') === 'gamepad') gamePad(w);
  else $('p-widget').append(w);

  let hex: string | null = null;
  try {
    if (npubParam) hex = toHexPubkey(npubParam);
  } catch {
    /* bad npub: the widget explains */
  }
  if (!hex && to) hex = await nip05Pubkey(to);

  const fallback = to ? to.split('@')[0] : npubParam ? `${npubParam.slice(0, 16)}…` : 'a creator';
  let name = params.get('name') ?? fallback;
  $('p-handle').textContent = to ?? (hex ? `${toNpub(hex).slice(0, 20)}…` : '');
  if (hex) {
    const p = await fetchProfile(hex).catch(() => null);
    if (p) {
      name = params.get('name') ?? (p.display_name || p.name || fallback);
      if (typeof p.nip05 === 'string') $('p-handle').textContent = p.nip05.replace(/^_@/, '');
      $('p-about').textContent = String(p.about ?? '').slice(0, 400);
      showImg('p-avatar-img', p.picture);
      showImg('p-banner-img', p.banner);
    }
  }
  name = String(name).slice(0, 60);
  $('p-name').textContent = name;
  w.setAttribute('name', name);
  document.title = `Boost ${name} · Nutjar`;
}

/**
 * The NUTJAR BOY handheld around a real boost button. The keys only pick the amount and open the
 * invoice; the fan still pays in their own wallet, so a stray press never spends anything.
 */
function gamePad(w: HTMLElement) {
  type BoostEl = HTMLElement & { stepAmount(d: 1 | -1): number; press(): void };
  const b = w as BoostEl;
  w.setAttribute('skin', 'arcade');
  const pad = document.createElement('div');
  pad.className = 'console';
  pad.innerHTML = `
    <div class="console-top"><span class="led" title="Lights up when your boost lands"></span><span class="grill"></span><span class="console-brand">NUTJAR&nbsp;BOY</span></div>
    <div class="console-screen"></div>
    <div class="press-hint">PRESS ⚡ TO BOOST</div>
    <div class="console-pad">
      <button class="key blue" data-k="less" aria-label="Less sats">◀</button>
      <button class="key blue" data-k="more" aria-label="More sats">▶</button>
      <button class="key red" data-k="boost" aria-label="Boost">⚡</button>
    </div>
    <div class="console-labels"><span>LESS</span><span>MORE</span><span>BOOST</span></div>
    <span class="coin" aria-hidden="true"></span>`;
  pad.querySelector('.console-screen')!.append(w);
  $('p-widget').append(pad);
  const key = (k: string) => pad.querySelector<HTMLButtonElement>(`[data-k="${k}"]`)!;
  key('less').addEventListener('click', () => b.stepAmount(-1));
  key('more').addEventListener('click', () => b.stepAmount(1));
  key('boost').addEventListener('click', () => {
    pad.classList.remove('lit');
    b.press();
  });
  // The hint and keys only make sense on the amount screen: watch the widget and follow along.
  const sync = () => {
    const onForm = !!w.shadowRoot?.querySelector('[data-act="invoice"]');
    pad.classList.toggle('busy', !onForm);
  };
  new MutationObserver(sync).observe(w.shadowRoot ?? w, { childList: true, subtree: true });
  sync();
  w.addEventListener('boost', () => pad.classList.add('lit'));
}

function maker() {
  $('maker').classList.remove('hidden');
  $('nav-own').classList.add('hidden');
  const enable = (id: string, on: boolean) => $(id).setAttribute('aria-disabled', String(!on));
  let link = '';

  const update = async () => {
    const n = $<HTMLInputElement>('m-npub').value.trim();
    const to = $<HTMLInputElement>('m-to').value.trim();
    const label = $<HTMLInputElement>('m-label').value.trim();
    const skin = $<HTMLSelectElement>('m-skin').value;
    let err = '';
    if (n) {
      try {
        toHexPubkey(n);
      } catch {
        err = "That npub doesn't look right.";
      }
    }
    if (to && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) err = 'A lightning address looks like you@getalby.com.';
    $('m-err').textContent = err;
    const ok = !err && !!(n || to);
    const q = new URLSearchParams();
    if (n) q.set('npub', n);
    if (to) q.set('to', to);
    if (label) q.set('label', label);
    if (skin) q.set('skin', skin);
    link = ok ? `${base.href}?${q}` : '';
    $('m-link').textContent = link || 'Fill in an npub or lightning address.';
    $<HTMLButtonElement>('m-copy').disabled = !link;
    $<HTMLAnchorElement>('m-open').href = link || '#';
    const text = 'Liked something I made? Boost me with a message ⚡🥜';
    $<HTMLAnchorElement>('m-share').href = link ? `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(link)}` : '#';
    for (const id of ['m-open', 'm-share', 'm-dl']) enable(id, !!link);
    $('m-qr').innerHTML = link ? await QRCode.toString(link, { type: 'svg', margin: 1 }) : '';
    $<HTMLAnchorElement>('m-dl').href = link ? await QRCode.toDataURL(link, { width: 1024, margin: 2 }) : '#';
  };

  for (const id of ['m-npub', 'm-to', 'm-label', 'm-skin']) $(id).addEventListener('input', update);
  $('m-copy').addEventListener('click', async () => {
    await navigator.clipboard?.writeText(link);
    $('m-copy').textContent = 'Copied!';
    setTimeout(() => ($('m-copy').textContent = 'Copy link'), 1500);
  });
  document.querySelectorAll<HTMLAnchorElement>('#maker a[aria-disabled]').forEach((a) =>
    a.addEventListener('click', (e) => {
      if (a.getAttribute('aria-disabled') === 'true') e.preventDefault();
    }),
  );
  update();
}

if (params.get('npub') || params.get('to')) creatorPage();
else maker();
