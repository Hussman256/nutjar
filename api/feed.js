// Feed relay for <cashu-boost feed="…">: many podcast hosts don't send CORS headers, so a widget on
// someone else's site can't read the RSS directly. The widget tries the feed itself first and only
// falls back to this. Locked down so it isn't an open proxy: public http(s) hosts only, RSS/Atom
// XML only, 25 MB read cap, 8 s timeout, at most 3 redirects (each one checked again).
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_BYTES = 25 * 1024 * 1024;
// Vercel functions can return about 4.5 MB, and long-running shows have bigger feeds. The widget
// only needs the channel's value block plus one episode, so keep the newest items and the asked one.
const MAX_OUT = 4 * 1024 * 1024;
const KEEP_ITEMS = 100;

function trimItems(xml, episode) {
  const items = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)];
  if (items.length <= KEEP_ITEMS && xml.length <= MAX_OUT) return xml;
  const first = items[0].index;
  const last = items[items.length - 1];
  const end = last.index + last[0].length;
  const guidOf = (it) => (/<guid[^>]*>([\s\S]*?)<\/guid>/.exec(it[0])?.[1] ?? '').replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '').trim();
  const kept = items.filter((it, i) => i < KEEP_ITEMS || (episode && guidOf(it) === episode)).map((it) => it[0]);
  return xml.slice(0, first) + kept.join('\n') + xml.slice(end);
}

const TIMEOUT_MS = 8000;

function privateIp(ip) {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return privateIp(v.slice(7));
    return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

async function checkUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) return null;
  return u;
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', type);
  if (status === 200) res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  res.end(body);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (req.method !== 'GET') return send(res, 405, 'GET only');
  const params = new URL(req.url, 'http://x').searchParams;
  const target = params.get('url') || '';
  const episode = (params.get('episode') || '').slice(0, 500);
  let url = await checkUrl(target);
  if (!url) return send(res, 400, 'Give a public http(s) feed URL as ?url=');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    let upstream;
    for (let hops = 0; ; hops++) {
      upstream = await fetch(url, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Nutjar feed relay (+https://nutjar.xyz)', Accept: 'application/rss+xml, application/xml, text/xml, */*' },
      });
      const loc = upstream.headers.get('location');
      if (upstream.status >= 300 && upstream.status < 400 && loc) {
        if (hops >= 3) return send(res, 502, 'Too many redirects');
        url = await checkUrl(new URL(loc, url).href);
        if (!url) return send(res, 400, 'Feed redirected somewhere not allowed');
        continue;
      }
      break;
    }
    if (!upstream.ok) return send(res, 502, `Feed host answered ${upstream.status}`);
    if (Number(upstream.headers.get('content-length') || 0) > MAX_BYTES) return send(res, 413, 'Feed too large');

    const chunks = [];
    let size = 0;
    for await (const chunk of upstream.body) {
      size += chunk.length;
      if (size > MAX_BYTES) return send(res, 413, 'Feed too large');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    const head = text.slice(0, 2000).replace(/^﻿/, '').trimStart();
    if (!head.startsWith('<') || !/<(rss|feed|rdf:RDF)[\s>]/i.test(text.slice(0, 20000))) return send(res, 415, 'Not an RSS or Atom feed');
    const out = trimItems(text, episode);
    if (Buffer.byteLength(out) > MAX_OUT) return send(res, 413, 'Feed too large');
    return send(res, 200, out, 'application/xml; charset=utf-8');
  } catch (e) {
    return send(res, 504, e?.name === 'AbortError' ? 'Feed host too slow' : 'Could not reach the feed');
  } finally {
    clearTimeout(timer);
  }
}
