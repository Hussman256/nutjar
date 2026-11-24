// /b/ : a creator's shareable boost page, or (with no params) the link maker.
import './pwa';
import '../widget/cashu-boost';
import QRCode from 'qrcode';
import { buildPad, enhancePad } from './gamepad';
import { boostLink, fromPath, shortShowName } from '../lib/links';
import { fetchFeed, recipientsFor } from '../lib/feed';
import { DEFAULT_RELAYS, getPool, nip05Pubkey, npub as toNpub, toHexPubkey } from '../lib/nostr';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
// A short link (/you@getalby.com, /npub1…) is served from the site root; the long form lives at /b/.
const short = fromPath();
const root = new URL(short ? './' : '../', location.href);
root.search = '';

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
  // ?to= is meant for a Lightning address, but an npub pasted there by hand works too.
  const rawTo = params.get('to') ?? short?.to;
  const toIsNpub = !!rawTo && /^npub1/i.test(rawTo.trim());
  const npubParam = params.get('npub') ?? short?.npub ?? (toIsNpub ? rawTo!.trim() : undefined);
  const to = toIsNpub ? undefined : rawTo;
  $('page').classList.remove('hidden');
  // "Get your link" / "Get your own jar" go to the link maker, wherever this page is served from.
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href="./"]')) a.href = new URL('b/', root).href;

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
  name = String(name).trim().slice(0, 60) || fallback;
  $('p-name').textContent = name;
  w.setAttribute('name', name);
  document.title = `Boost ${name} · Nutjar`;
}

/**
 * An episode boost link: /b/?feed=<rss>&episode=<guid>. The page shows the show's cover art, its name and
 * the episode, and the widget pays that episode's own <podcast:value> splits. No episode: the whole show.
 */
async function podcastPage(feedUrl: string) {
  const episode = params.get('episode') ?? undefined;
  $('page').classList.remove('hidden');
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href="./"]')) a.href = new URL('b/', root).href;

  const w = document.createElement('cashu-boost');
  w.setAttribute('feed', feedUrl);
  if (episode) w.setAttribute('episode', episode);
  for (const k of ['label', 'amounts', 'mint', 'skin', 'theme']) {
    const v = params.get(k);
    if (v) w.setAttribute(k, v);
  }
  if (params.get('skin') === 'gamepad') gamePad(w);
  else $('p-widget').append(w);

  $('p-name').textContent = 'Loading the show…';
  try {
    const feed = await fetchFeed(feedUrl, episode);
    const show = shortShowName(feed.title) || 'this show';
    const ep = episode ? feed.episodes.find((e) => e.guid === episode) : undefined;
    $('p-name').textContent = show;
    $('p-handle').textContent = ep ? ep.title : episode ? 'Episode not found in the feed: boosting the show' : 'The whole show';
    const rs = recipientsFor(feed, ep?.guid).filter((r) => r.split > 0);
    const total = rs.reduce((t, r) => t + r.split, 0) || 1;
    $('p-about').textContent = rs.length
      ? `Your boost is split the way this show's feed says: ${rs.map((r) => `${r.name.trim()} ${Math.round((r.split / total) * 100)}%`).join(' · ')}.`
      : "This show's feed doesn't list anyone to pay yet.";
    showImg('p-avatar-img', feed.image);
    showImg('p-banner-img', feed.image);
    document.title = `Boost ${show}${ep ? `: ${ep.title}` : ''} · Nutjar`;
  } catch (e) {
    $('p-name').textContent = 'Podcast';
    $('p-about').textContent = `Couldn't load this podcast's feed (${(e as Error).message}).`;
  }
}

/** The NUTJAR BOY handheld around the real boost button (see gamepad.ts). */
function gamePad(w: HTMLElement) {
  w.setAttribute('skin', 'arcade');
  const pad = buildPad(w);
  $('p-widget').append(pad);
  enhancePad(pad, w, { name: () => $('p-name').textContent ?? '' });
}

function maker() {
  $('maker').classList.remove('hidden');
  $('nav-own').classList.add('hidden');
  const enable = (id: string, on: boolean) => $(id).setAttribute('aria-disabled', String(!on));
  let link = '';
  let npubTouched = false;

  const update = async () => {
    const n = $<HTMLInputElement>('m-npub').value.trim();
    const to = $<HTMLInputElement>('m-to').value.trim();
    const label = $<HTMLInputElement>('m-label').value.trim();
    const skin = $<HTMLSelectElement>('m-skin').value;
    let err = '';
    let npubOk = false;
    if (n) {
      try {
        toHexPubkey(n);
        npubOk = true;
      } catch {
        // Don't scold while it's still being typed: only once it's full length, or the field was left.
        if (n.length >= 63 || npubTouched) err = "That npub doesn't look right.";
      }
    }
    if (to && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) err = 'A lightning address looks like you@getalby.com.';
    $('m-err').textContent = err;
    const ok = !err && (!n || npubOk) && !!(n || to);
    link = ok ? boostLink(root.href, { npub: n || undefined, to: to || undefined, label: label || undefined, skin: skin || undefined }) : '';
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
  $('m-npub').addEventListener('change', () => {
    npubTouched = true;
    update();
  });
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

if (params.get('feed')) void podcastPage(params.get('feed')!);
else if (params.get('npub') || params.get('to') || short) creatorPage();
else maker();
