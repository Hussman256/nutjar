import '../widget/cashu-boost';
import { parseFeed, recipientsFor, type ParsedFeed } from '../lib/feed';
import { esc } from './zaplist';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const val = (id: string) => ($<HTMLInputElement>(id).value ?? '').trim();
let feed: ParsedFeed | null = null;
let timer: number | undefined;

function attrs(): Record<string, string> {
  const a: Record<string, string> = {};
  const mode = val('mode');
  if (mode === 'single') {
    if (val('npub')) a.npub = val('npub');
    if (val('lnaddress')) a.lnaddress = val('lnaddress');
  } else if (mode === 'feed' && feed) {
    // Bake the splits in so the widget doesn't depend on the feed host allowing CORS.
    const guid = val('episode');
    a.recipients = JSON.stringify(recipientsFor(feed, guid || undefined).map((r) => ({ name: r.name, split: r.split, type: r.type, address: r.address, ...(r.fee ? { fee: true } : {}) })));
    if (guid) a.episode = guid;
    if (feed.podcastGuid) a['podcast-guid'] = feed.podcastGuid;
  } else if (mode === 'request' && val('creq')) {
    a['payment-request'] = val('creq');
  }
  const ep = feed?.episodes.find((e) => e.guid === val('episode'));
  const label = val('label') || (mode === 'feed' ? ep?.title ?? feed?.title ?? '' : '');
  if (label) a.label = label;
  const name = val('name') || (mode === 'feed' ? feed?.title ?? '' : '');
  if (name) a.name = name;
  if (val('mint')) a.mint = val('mint');
  if (val('amounts') && val('amounts') !== '21,100,500,2100') a.amounts = val('amounts');
  if (val('theme')) a.theme = val('theme');
  if (val('skin')) a.skin = val('skin');
  return a;
}

function update() {
  const a = attrs();
  const accent = val('accent');
  const style = accent && accent !== '#e8742a' ? ` style="--cb-accent: ${accent}"` : '';
  const origin = location.origin + location.pathname.replace(/[^/]*$/, '');
  const attrStr = Object.entries(a)
    .map(([k, v]) => ` ${k}='${v.replace(/&/g, '&amp;').replace(/'/g, '&#39;')}'`)
    .join('');
  $('code').textContent = `<script src="${origin}cashu-boost.js" defer></script>\n<cashu-boost${attrStr}${style}></cashu-boost>`;

  const hasTarget = a.npub || a.lnaddress || a.recipients || a['payment-request'];
  if (!hasTarget) {
    $('preview').innerHTML = '<p class="muted small">Add an npub, a lightning address, a feed or a payment request to see the preview.</p>';
    return;
  }
  const el = document.createElement('cashu-boost');
  for (const [k, v] of Object.entries(a)) el.setAttribute(k, v);
  if (style) el.style.setProperty('--cb-accent', accent);
  $('preview').replaceChildren(el);
}

const schedule = () => {
  clearTimeout(timer);
  timer = window.setTimeout(update, 450);
};

function useFeed(xml: string) {
  feed = parseFeed(xml);
  const sel = $<HTMLSelectElement>('episode');
  sel.innerHTML = '<option value="">Whole show (channel splits)</option>' + feed.episodes.slice(0, 200).map((e) => `<option value="${esc(e.guid)}">${esc(e.title)}</option>`).join('');
  $('feed-status').textContent = `Loaded "${feed.title}": ${feed.episodes.length} episodes, ${feed.recipients.length} channel recipient(s).`;
  showSplits();
  update();
}

function showSplits() {
  if (!feed) return;
  const rs = recipientsFor(feed, val('episode') || undefined);
  $('splits').innerHTML = rs.length
    ? `<table><tr><th>Recipient</th><th>Split</th><th>Type</th></tr>${rs.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.split}${r.fee ? '% fee' : ''}</td><td>${esc(r.type)}${r.type === 'node' ? ' <span class="muted">(skipped: keysend)</span>' : ''}</td></tr>`).join('')}</table>`
    : '<p class="err">This feed has no &lt;podcast:value&gt; block. Use "Just me" instead.</p>';
}

$('btn-feed').addEventListener('click', async () => {
  $('feed-status').textContent = 'Loading…';
  try {
    const res = await fetch(val('feed'));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    useFeed(await res.text());
    $('feed-paste').classList.add('hidden');
  } catch (e) {
    $('feed-status').textContent = `Couldn't load it from the browser (${(e as Error).message}). Many feed hosts block cross-site requests. Open the feed URL, then copy and paste the XML below.`;
    $('feed-paste').classList.remove('hidden');
  }
});
$('btn-xml').addEventListener('click', () => {
  try {
    useFeed(val('xml'));
  } catch (e) {
    $('feed-status').textContent = (e as Error).message;
  }
});
$('mode').addEventListener('change', () => {
  for (const m of ['single', 'feed', 'request']) $(`m-${m}`).classList.toggle('hidden', val('mode') !== m);
  update();
});
$('episode').addEventListener('change', () => {
  showSplits();
  update();
});
for (const id of ['npub', 'lnaddress', 'creq', 'label', 'name', 'mint', 'amounts', 'accent', 'theme', 'skin']) $(id).addEventListener('input', schedule);
$('btn-copy').addEventListener('click', () => navigator.clipboard?.writeText($('code').textContent ?? ''));
update();
