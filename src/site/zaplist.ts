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

export function zapHtml(z: Nutzap, extra = ''): string {
  const [label, cls] = STATE[z.state ?? 'unknown'] ?? ['', ''];
  const where = z.url ? `<a href="${esc(z.url)}" target="_blank" rel="noopener">${esc(new URL(z.url).host)}</a>` : '';
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
