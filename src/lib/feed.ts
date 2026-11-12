// Podcasting 2.0 feed parsing: <podcast:value> recipients and episode metadata.
// Spec: https://podcasting2.org/docs/podcast-namespace/tags/value

export interface FeedRecipient {
  name: string;
  type: string; // "node" (keysend), "lnaddress", or anything else
  address: string;
  split: number;
  fee: boolean;
}

export interface FeedEpisode {
  guid: string;
  title: string;
  enclosure?: string;
  recipients: FeedRecipient[]; // empty → falls back to channel-level value block
}

export interface ParsedFeed {
  title: string;
  image?: string;
  podcastGuid?: string;
  recipients: FeedRecipient[];
  episodes: FeedEpisode[];
}

const NS = 'https://podcastindex.org/namespace/1.0';

function children(el: Element, local: string): Element[] {
  // Match namespaced (podcast:value) tags regardless of prefix; fall back to the literal name.
  const out: Element[] = [];
  for (const c of Array.from(el.children)) {
    if (c.localName === local && (c.namespaceURI === NS || c.prefix === 'podcast' || c.tagName === `podcast:${local}`)) {
      out.push(c);
    }
  }
  return out;
}

function text(el: Element | null | undefined, tag: string): string {
  const found = el?.getElementsByTagName(tag)[0];
  return found?.textContent?.trim() ?? '';
}

function parseValue(parent: Element): FeedRecipient[] {
  const values = children(parent, 'value').filter((v) => {
    const type = (v.getAttribute('type') ?? '').toLowerCase();
    return type === 'lightning' || type === '';
  });
  const value = values[0];
  if (!value) return [];
  return children(value, 'valueRecipient').map((r) => ({
    name: r.getAttribute('name') ?? 'Recipient',
    type: (r.getAttribute('type') ?? '').toLowerCase(),
    address: r.getAttribute('address') ?? '',
    split: Number(r.getAttribute('split') ?? '0') || 0,
    fee: (r.getAttribute('fee') ?? '').toLowerCase() === 'true',
  }));
}

export function parseFeed(xml: string): ParsedFeed {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('That does not look like an RSS feed.');
  const channel = doc.getElementsByTagName('channel')[0];
  if (!channel) throw new Error('No <channel> found in the feed.');

  const imageEl = children(channel, 'image')[0];
  const itunesImage = Array.from(channel.children).find((c) => c.localName === 'image' && c.getAttribute('href'));
  const recipients = parseValue(channel);
  const episodes: FeedEpisode[] = Array.from(channel.getElementsByTagName('item')).map((item) => ({
    guid: text(item, 'guid'),
    title: text(item, 'title'),
    enclosure: item.getElementsByTagName('enclosure')[0]?.getAttribute('url') ?? undefined,
    recipients: parseValue(item),
  }));

  return {
    title: Array.from(channel.children).find((c) => c.tagName === 'title')?.textContent?.trim() ?? '',
    image: imageEl?.getAttribute('href') ?? itunesImage?.getAttribute('href') ?? text(channel.getElementsByTagName('image')[0], 'url') ?? undefined,
    podcastGuid: children(channel, 'guid')[0]?.textContent?.trim() || undefined,
    recipients,
    episodes,
  };
}

/** Recipients for an episode: item-level value block overrides the channel's. */
export function recipientsFor(feed: ParsedFeed, guid?: string): FeedRecipient[] {
  const ep = guid ? feed.episodes.find((e) => e.guid === guid) : undefined;
  return ep && ep.recipients.length ? ep.recipients : feed.recipients;
}

export async function fetchFeed(url: string): Promise<ParsedFeed> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Feed request failed (${res.status}).`);
  return parseFeed(await res.text());
}
