import type { Nutzap } from '../lib/inbox';

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function ago(ts: number): string {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

const STATE: Record<string, [string, string]> = {
  unclaimed: ['new', 'new'],
  claimed: ['collected', 'done'],
  pending: ['pending', ''],
  unknown: ['mint offline', ''],
};

const AV = ['#ffc23d', '#ff8a6b', '#9ad0ff', '#b7e4a1', '#e2b071', '#d7b8ff'];

/** Nutjar's own sites (now and before the move to Vercel): boosts from there came through a boost link. */
const OWN_HOSTS = new Set(['nutjar.vercel.app', 'hussman256.github.io']);

/** Where a boost came from: "via boost link" for Nutjar's own pages, the site's name for embeds elsewhere. */
function whereHtml(url?: string): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (OWN_HOSTS.has(u.host)) return 'via boost link';
    return `via <a href="${esc(u.href)}" target="_blank" rel="noopener">${esc(u.host.replace(/^www\./, ''))}</a>`;
  } catch {
    return '';
  }
}

/** One boost in the creator app's message feed. */
export function feedHtml(z: Nutzap): string {
  const name = z.senderName || 'Anonymous';
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const initial = name === 'Anonymous' ? '🥜' : esc([...name][0]!.toUpperCase());
  const [label, cls] = STATE[z.state ?? 'unknown'] ?? ['', ''];
  const where = whereHtml(z.url);
  let host = '';
  try {
    host = new URL(z.mint).host;
  } catch {
    host = z.mint;
  }
  const msg = z.message.trim();
  return `<div class="fz${z.state === 'unclaimed' ? ' is-new' : ''}" data-id="${z.id}">
    <div class="av" style="background:${AV[h % AV.length]}">${initial}</div>
    <div>
      <div class="top"><span class="nm">${esc(name)}</span><span class="amt">${z.amount.toLocaleString('en-US')} <small>sats</small></span></div>
      <div class="bub${msg ? '' : ' empty'}">${msg ? esc(msg) : 'No message, just sats'}</div>
      <div class="meta"><span class="tag ${cls}">${label}</span>${[ago(z.createdAt), host, where].filter(Boolean).map((x) => `<span>${x}</span>`).join('<span>·</span>')}</div>
    </div>
  </div>`;
}

export function zapHtml(z: Nutzap, extra = ''): string {
  const [label, cls] = STATE[z.state ?? 'unknown'] ?? ['', ''];
  const where = whereHtml(z.url);
  const ep = z.episodeGuid ? `episode ${esc(z.episodeGuid.slice(0, 24))}` : '';
  let host = '';
  try {
    host = new URL(z.mint).host;
  } catch {
    host = z.mint;
  }
  return `<div class="zap" data-id="${z.id}">
    <div><b>${esc(z.senderName || 'Anonymous')}</b> <span class="tag ${cls}">${label}</span>${extra}</div>
    <div class="amt">${z.amount.toLocaleString('en-US')} <span class="small muted">sats</span></div>
    <div class="msg">${esc(z.message)}</div>
    <div class="meta">${[ago(z.createdAt), host, ep, where].filter(Boolean).join(' · ')}</div>
  </div>`;
}
