// Lightning address (LUD-16) → invoice, with LUD-12 comments.

export interface LnurlPayInfo {
  callback: string;
  minSendable: number; // msat
  maxSendable: number; // msat
  commentAllowed: number;
  nostrPubkey?: string;
}

export function lnAddressUrl(address: string): string {
  const [name, domain] = address.trim().toLowerCase().split('@');
  if (!name || !domain) throw new Error(`"${address}" is not a lightning address.`);
  // Plain http only for local development servers.
  const scheme = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(domain) ? 'http' : 'https';
  return `${scheme}://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`;
}

export async function getPayInfo(address: string): Promise<LnurlPayInfo> {
  const res = await fetch(lnAddressUrl(address));
  const data = await res.json();
  if (data.status === 'ERROR' || !data.callback) throw new Error(data.reason ?? `No LNURL-pay info for ${address}.`);
  return {
    callback: data.callback,
    minSendable: Number(data.minSendable ?? 1000),
    maxSendable: Number(data.maxSendable ?? 1e11),
    commentAllowed: Number(data.commentAllowed ?? 0),
    nostrPubkey: data.nostrPubkey,
  };
}

export async function getInvoice(info: LnurlPayInfo, sats: number, comment?: string): Promise<string> {
  const msat = sats * 1000;
  if (msat < info.minSendable) throw new Error(`Minimum for this address is ${Math.ceil(info.minSendable / 1000)} sats.`);
  if (msat > info.maxSendable) throw new Error(`Maximum for this address is ${Math.floor(info.maxSendable / 1000)} sats.`);
  const url = new URL(info.callback);
  url.searchParams.set('amount', String(msat));
  if (comment && info.commentAllowed > 0) url.searchParams.set('comment', comment.slice(0, info.commentAllowed));
  const res = await fetch(url);
  const data = await res.json();
  if (data.status === 'ERROR' || !data.pr) throw new Error(data.reason ?? 'The lightning address did not return an invoice.');
  return data.pr as string;
}
