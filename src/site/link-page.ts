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
  $('p-widget').append(w);

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
