// Boost links. On the main site they are short: nutjar.vercel.app/you@getalby.com or
// nutjar.vercel.app/npub1… (vercel.json rewrites those paths to the boost page). Hosts without that
// rewrite (GitHub Pages, the local dev server) get the long form, /b/?to=…, which works everywhere.

export interface LinkParts {
  npub?: string;
  to?: string;
  label?: string;
  skin?: string;
}

const NO_REWRITES = /(^|\.)github\.io$|^localhost$|^127\.0\.0\.1$/;

/** Does this host serve the short /<address> paths? */
export function shortLinksWork(hostname = location.hostname): boolean {
  return !NO_REWRITES.test(hostname);
}

/** A boost link for a creator. `root` is the site root, e.g. https://nutjar.vercel.app/ */
export function boostLink(root: string, p: LinkParts, short = shortLinksWork(new URL(root).hostname)): string {
  const q = new URLSearchParams();
  const id = p.npub || p.to;
  if (short && id) {
    if (p.npub && p.to) q.set('to', p.to);
    if (p.label) q.set('label', p.label);
    if (p.skin) q.set('skin', p.skin);
    const qs = q.toString();
    return new URL(id, root).href + (qs ? `?${qs}` : '');
  }
  if (p.npub) q.set('npub', p.npub);
  if (p.to) q.set('to', p.to);
  if (p.label) q.set('label', p.label);
  if (p.skin) q.set('skin', p.skin);
  return new URL(`b/?${q}`, root).href;
}

/** Read a creator from a short path (/you@getalby.com, /npub1…). Undefined when the path is something else. */
export function fromPath(pathname = location.pathname): { npub?: string; to?: string } | undefined {
  let seg: string;
  try {
    seg = decodeURIComponent(pathname.replace(/^\/+|\/+$/g, ''));
  } catch {
    return undefined;
  }
  if (!seg || seg.includes('/')) return undefined;
  if (/^npub1[02-9ac-hj-np-z]{20,}$/.test(seg)) return { npub: seg };
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(seg)) return { to: seg };
  return undefined;
}

/** A link worth showing a creator: a public https page, not localhost or a private network address. */
export function publicHttpsUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    const h = u.hostname.replace(/^\[|\]$/g, '');
    const local =
      h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.test') || h === '::1' ||
      /^(127|10|0)\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
    return u.protocol === 'https:' && !local ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A boost link for one podcast episode: /b/?feed=…&episode=… opens a ready boost page that pays the
 * episode's own <podcast:value> splits. Without an episode it boosts the show (channel splits).
 */
export function episodeLink(root: string, feed: string, episode?: string, opts: { skin?: string } = {}): string {
  const q = new URLSearchParams({ feed });
  if (episode) q.set('episode', episode);
  if (opts.skin) q.set('skin', opts.skin);
  return new URL(`b/?${q}`, root).href;
}

/** "Nodesignal - Deine Bitcoin-Frequenz" -> "Nodesignal": the show's name without its tagline. */
export function shortShowName(title: string): string {
  const t = title.trim();
  const head = t.split(/\s+[-–—|:]\s+/)[0].trim();
  return (head.length >= 2 ? head : t).slice(0, 60);
}
