// <cashu-boost> — an embeddable Value4Value boost button paid in Cashu ecash.
import QRCode from 'qrcode';
import { getEncodedToken, type Proof, type Wallet } from '@cashu/cashu-ts';
import { arcade, classic, css } from './styles';

const ALL_CSS = css + classic + arcade;
let sheet: CSSStyleSheet | undefined;
/** One shared constructable stylesheet: not blocked by a site's Content-Security-Policy, unlike <style>. */
function sharedSheet(): CSSStyleSheet | undefined {
  if (sheet) return sheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(ALL_CSS);
    return sheet;
  } catch {
    return undefined; // very old browser: fall back to a <style> tag
  }
}
import {
  deliver,
  fundWithInvoice,
  fundWithToken,
  loadWallet,
  pickMint,
  plan,
  resolveRecipients,
  type DeliveryResult,
  type PlanLine,
  type Recipient,
  type RecipientInput,
} from '../lib/boost';
import { fetchFeed, recipientsFor } from '../lib/feed';
import { publicHttpsUrl } from '../lib/links';
import { DEFAULT_RELAYS, ephemeralSigner, extensionSigner, fetchProfileName, nip05Pubkey, nip07, toHexPubkey } from '../lib/nostr';
import { listPending, removePending, savePending, type PendingBoost } from '../lib/pending';
import { fromWire, sum, toWire } from '../lib/proofs';

type View = 'loading' | 'form' | 'invoice' | 'token' | 'sending' | 'done' | 'fatal';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** "Nodesignal - Deine Bitcoin-Frequenz" -> "Nodesignal": the show's name without its tagline. */
const shortShowName = (title: string): string | undefined => {
  const t = title.trim();
  if (!t) return undefined;
  const head = t.split(/\s+[-–—|:]\s+/)[0].trim();
  return (head.length >= 2 ? head : t).slice(0, 60);
};
/** The page the boost came from (public https pages only), so creators see where fans found them. */
const publicPageUrl = () => publicHttpsUrl(location.href);
const fmt = (n: number) => n.toLocaleString('en-US');
const MAX_MESSAGE = 280;

const RAIL_LABEL: Record<string, string> = {
  nutzap: 'nutzap',
  lightning: 'via Lightning',
  request: 'payment request',
  none: 'skipped',
};

export class CashuBoost extends HTMLElement {
  static observedAttributes = ['npub', 'lnaddress', 'recipients', 'feed', 'episode', 'payment-request', 'mint', 'label', 'max', 'name'];

  private root: ShadowRoot;
  private view: View = 'loading';
  private recipients: Recipient[] = [];
  private amount = 100;
  private message = '';
  private sender = '';
  private useNostrId = false;
  private error = '';
  private invoice = '';
  private invoiceQr = '';
  private abort?: AbortController;
  private results: DeliveryResult[] = [];
  private lines: PlanLine[] = [];
  private change?: { amount: number; token: string };
  private podcastGuid?: string;
  private episodeTitle?: string;
  private podcastName?: string;
  private loadToken = 0;
  private started = false;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    const s = sharedSheet();
    if (s) this.root.adoptedStyleSheets = [s];
  }

  connectedCallback() {
    const amounts = this.amounts();
    this.amount = amounts[1] ?? amounts[0];
    this.started = true;
    this.load();
    void this.sweepPending();
  }

  /**
   * Old invoices that were never paid are not money. Check them with the mint: paid ones become
   * ecash we can hand back, dead ones are forgotten, so the "get them back" banner only ever shows
   * sats that really exist. Skips anything under 10 minutes old (another tab may still be paying it).
   */
  private async sweepPending() {
    let changed = false;
    for (const p of listPending()) {
      if (p.proofs.length || !p.quote || Date.now() - p.createdAt < 10 * 60_000) continue;
      try {
        const wallet = await loadWallet(p.mint);
        const q = await wallet.checkMintQuoteBolt11(p.quote);
        const state = String(q.state);
        if (state === 'PAID') {
          const proofs = await wallet.mintProofsBolt11(p.amount, p.quote);
          savePending({ ...p, quote: undefined, proofs: proofs.map(toWire) });
          changed = true;
        } else if (state === 'ISSUED' || (q.expiry && q.expiry * 1000 < Date.now())) {
          removePending(p.id);
          changed = true;
        }
      } catch {
        /* mint unreachable: leave it for next time, it stays hidden from the banner */
      }
    }
    if (changed && this.view === 'form') this.render();
  }

  /** Unfinished boosts that hold real ecash (not just an unpaid invoice). */
  private recoverable(): PendingBoost[] {
    return listPending().filter((p) => p.proofs.length > 0);
  }

  attributeChangedCallback(n: string, oldV: string | null, newV: string | null) {
    // A new name only changes the title: no reload, and nothing a fan is typing gets lost.
    if (n === 'name') {
      const title = this.root.querySelector('.title');
      if (title) title.textContent = `Boost ${this.displayName()}`;
      return;
    }
    // Never interrupt a payment in progress; otherwise reload (load() discards stale runs).
    const busy = this.view === 'invoice' || this.view === 'token' || this.view === 'sending';
    // Before connectedCallback (attributes set while the element upgrades) there is nothing to reload yet.
    if (this.started && this.isConnected && oldV !== newV && !busy) this.load();
  }

  disconnectedCallback() {
    this.abort?.abort();
  }

  // ---------- config ----------

  private attr(name: string): string | undefined {
    return this.getAttribute(name)?.trim() || undefined;
  }

  private amounts(): number[] {
    const raw = this.attr('amounts') ?? '21,100,500,2100';
    const list = raw.split(',').map((s) => parseInt(s, 10)).filter((n) => n > 0);
    return list.length ? list.slice(0, 4) : [21, 100, 500, 2100];
  }

  private relays(): string[] {
    const r = this.attr('relays');
    return r ? r.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_RELAYS;
  }

  private async inputs(): Promise<RecipientInput[]> {
    const json = this.attr('recipients');
    if (json) {
      const parsed = JSON.parse(json) as RecipientInput[];
      if (!Array.isArray(parsed)) throw new Error('recipients must be a JSON array');
      return parsed;
    }
    const feedUrl = this.attr('feed');
    if (feedUrl) {
      const guid = this.attr('episode');
      const feed = await fetchFeed(feedUrl, guid);
      this.podcastGuid = feed.podcastGuid;
      this.podcastName = shortShowName(feed.title);
      this.episodeTitle = feed.episodes.find((e) => e.guid === guid)?.title;
      return recipientsFor(feed, guid).map((r) => ({ name: r.name, split: r.split, type: r.type, address: r.address, fee: r.fee }));
    }
    const npub = this.attr('npub');
    const ln = this.attr('lnaddress');
    // Until the Nostr name arrives, a Lightning address already says who this is ("marcelo").
    if (npub || ln) return [{ name: this.attr('name') ?? (!npub && ln ? ln.split('@')[0] : 'Creator'), split: 100, npub, lnaddress: ln }];
    return [];
  }

  private async load() {
    const ticket = ++this.loadToken;
    this.view = 'loading';
    this.render();
    try {
      const request = this.attr('payment-request');
      const recipients = request
        ? [{ name: this.attr('name') ?? 'Creator', split: 100, request } as Recipient]
        : await resolveRecipients(await this.inputs(), this.relays());
      if (ticket !== this.loadToken) return;
      if (recipients.length === 0)
        throw new Error(this.attr('feed')
          ? "This podcast's feed has no <podcast:value> block yet, so there's no one to send boosts to. Add one in your podcast host, or embed with npub or lnaddress instead."
          : 'No recipient configured. Set npub, lnaddress, recipients, feed or payment-request.');
      this.recipients = recipients;
      this.view = 'form';
      void this.lookUpName(ticket);
    } catch (e) {
      if (ticket !== this.loadToken) return;
      this.error = e instanceof Error ? e.message : String(e);
      this.view = 'fatal';
    }
    this.render();
  }

  /**
   * Embedded with just an npub or a Lightning address, the widget would say "Boost Creator" (or
   * the address's user part). Fetch the creator's Nostr name instead: from the npub, or from the
   * key the Lightning address's domain publishes for it (NIP-05). Only the title text is swapped, so a fan who is already typing isn't disturbed.
   */
  private async lookUpName(ticket: number) {
    const npub = this.attr('npub');
    const ln = this.attr('lnaddress');
    if ((!npub && !ln) || this.attr('name') || this.recipients.length !== 1) return;
    try {
      const hex = npub ? toHexPubkey(npub) : await nip05Pubkey(ln!);
      if (!hex) return;
      const name = await fetchProfileName(hex, this.relays());
      if (!name || ticket !== this.loadToken || this.attr('name')) return;
      this.recipients[0].name = name;
      const title = this.root.querySelector('.title');
      if (title) title.textContent = `Boost ${name}`;
    } catch {
      /* no profile or relays unreachable: keep the generic name */
    }
  }

  private mint(): string | undefined {
    return pickMint(this.recipients, this.attr('mint'));
  }

  private currentPlan(mint = this.mint()): PlanLine[] {
    return mint ? plan(this.amount, this.recipients, mint) : [];
  }

  // ---------- public controls (used by hardware-style frames, e.g. the demo console) ----------

  /**
   * Step the amount up or down a ladder of friendly numbers (the presets plus 21, 50, 100, 210, 500…),
   * never past the boost cap. Returns the new amount.
   */
  stepAmount(dir: 1 | -1): number {
    if (this.view !== 'form') return this.amount;
    const max = this.maxAmount();
    const ladder = [...new Set([...this.amounts(), 21, 50, 100, 210, 500, 1000, 2100, 5000, 10_000, 21_000, 50_000, 100_000])]
      .filter((a) => a <= max)
      .sort((a, b) => a - b);
    const next = dir > 0 ? (ladder.find((a) => a > this.amount) ?? this.amount) : ([...ladder].reverse().find((a) => a < this.amount) ?? this.amount);
    if (next !== this.amount) {
      this.amount = next;
      this.render();
    }
    return next;
  }

  /** What a console frame needs to draw itself: the amount, the cap, and which screen is showing. */
  state(): { amount: number; max: number; view: string } {
    return { amount: this.amount, max: this.maxAmount(), view: this.view };
  }

  /** Press the main button: boost from the form, or start again after a finished boost. */
  press(): void {
    if (this.view === 'form') this.payInvoice();
    else if (this.view === 'done') {
      this.change = undefined;
      this.results = [];
      this.message = '';
      this.error = '';
      this.view = 'form';
      this.render();
    }
  }

  // ---------- actions ----------

  /** Beta safety cap on a single boost (sats). Creators can raise or lower it with max="…". */
  private maxAmount(): number {
    const v = parseInt(this.attr('max') ?? '', 10);
    return v > 0 ? v : 100_000;
  }

  private async payInvoice() {
    const mint = this.mint();
    if (!mint) return this.fail('No mint configured: set the mint attribute or have the creator publish a nutzap profile.');
    if (this.amount > this.maxAmount()) return this.fail(`Boosts are capped at ${fmt(this.maxAmount())} sats while Nutjar is in beta.`);
    this.error = '';
    this.view = 'invoice';
    this.invoice = '';
    this.render();
    try {
      const wallet = await loadWallet(mint);
      const funding = await fundWithInvoice(wallet, this.amount, `Boost: ${this.label()}`);
      this.invoice = funding.invoice;
      // Bare invoice, no "lightning:" prefix: some wallets reject the prefixed form when scanned
      // ("Payment destination could not be validated"). Uppercase keeps the QR small.
      this.invoiceQr = await QRCode.toString(funding.invoice.toUpperCase(), { type: 'svg', margin: 1 });
      this.render();
      this.abort = new AbortController();
      const proofs = await funding.wait(this.abort.signal);
      await this.send(wallet, proofs, funding.pending);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      this.fail(e);
    }
  }

  private async payToken(token: string) {
    this.error = '';
    try {
      this.view = 'sending';
      this.lines = [];
      this.results = [];
      this.render();
      const { wallet, proofs, pending } = await fundWithToken(token);
      this.amount = sum(proofs);
      await this.send(wallet, proofs, pending);
    } catch (e) {
      this.view = 'token';
      this.fail(e);
    }
  }

  private async send(wallet: Wallet, proofs: Proof[], pending: PendingBoost) {
    this.view = 'sending';
    this.lines = plan(sum(proofs), this.recipients, wallet.mint.mintUrl);
    this.results = [];
    this.render();
    const signer = this.useNostrId && nip07() ? await extensionSigner() : ephemeralSigner();
    const outcome = await deliver(
      wallet,
      proofs,
      this.lines,
      {
        message: this.message.trim() || '⚡ Boost!',
        senderName: this.sender.trim() || undefined,
        signer,
        episodeGuid: this.attr('episode'),
        podcastGuid: this.attr('podcast-guid') ?? this.podcastGuid,
        url: this.attr('url') ?? publicPageUrl(),
        relays: this.relays(),
      },
      pending,
      (r) => {
        this.results.push(r);
        this.render();
      },
    );
    this.change = outcome.change;
    this.view = 'done';
    this.render();
    this.dispatchEvent(new CustomEvent('boost', { detail: { amount: this.amount, results: outcome.results }, bubbles: true, composed: true }));
  }

  private async recover(p: PendingBoost) {
    try {
      const wallet = await loadWallet(p.mint);
      let proofs: Proof[] = p.proofs.map(fromWire);
      if (!proofs.length && p.quote) {
        const q = await wallet.checkMintQuoteBolt11(p.quote);
        if (String(q.state) !== 'PAID') {
          this.error = 'That invoice was never paid. Nothing to recover.';
          removePending(p.id);
          return this.render();
        }
        proofs = await wallet.mintProofsBolt11(p.amount, p.quote);
      }
      const token = getEncodedToken({ mint: p.mint, proofs, unit: 'sat' });
      this.change = { amount: sum(proofs), token };
      this.results = [];
      this.lines = [];
      this.view = 'done';
      removePending(p.id);
      this.render();
    } catch (e) {
      this.fail(e);
    }
  }

  private fail(e: unknown) {
    this.error = e instanceof Error ? e.message : String(e);
    this.render();
  }

  /** Who the title thanks: the name attribute, the podcast (feed embeds), else the first recipient. */
  private displayName(): string {
    return this.attr('name') ?? this.podcastName ?? this.recipients[0]?.name ?? 'the creator';
  }

  private label(): string {
    return this.attr('label') ?? this.episodeTitle ?? document.title;
  }

  // ---------- rendering ----------

  private render() {
    const body = (() => {
      switch (this.view) {
        case 'loading':
          return `<div class="row"><span class="spinner"></span><span>Finding where your sats go…</span></div>`;
        case 'fatal':
          return `<div class="err">${esc(this.error)}</div>`;
        case 'form':
          return this.formView();
        case 'invoice':
          return this.invoiceView();
        case 'token':
          return this.tokenView();
        case 'sending':
        case 'done':
          return this.progressView();
      }
    })();
    const name = this.displayName();
    this.root.innerHTML = `${this.root.adoptedStyleSheets.length ? '' : `<style>${ALL_CSS}</style>`}
      <div class="card" part="card">
        <div class="head"><div class="nut" aria-hidden="true">🥜</div>
          <div><div class="title">Boost ${esc(name)}</div><div class="sub">${esc(this.label())}</div></div></div>
        ${body}
        <div class="foot">Value4Value with <a href="https://cashu.space" target="_blank" rel="noopener">Cashu</a> ecash</div>
      </div>`;
    this.wire();
  }

  private formView(): string {
    const mint = this.mint();
    const lines = this.currentPlan(mint);
    const pending = this.recoverable();
    const custom = !this.amounts().includes(this.amount);
    const payable = lines.some((l) => l.rail !== 'none');
    return `
      ${pending.length ? `<div class="banner">You have ${fmt(pending.reduce((t, p) => t + sum(p.proofs), 0))} sats from an unfinished boost. <button class="ghost" data-act="recover">Get them back</button></div>` : ''}
      <div class="amounts" role="group" aria-label="Amount in sats">
        ${this.amounts().map((a) => `<button data-amt="${a}" aria-pressed="${a === this.amount}">${fmt(a)}</button>`).join('')}
      </div>
      <input type="number" min="1" inputmode="numeric" placeholder="Custom amount (sats)" data-field="custom" value="${custom ? this.amount : ''}" aria-label="Custom amount in sats">
      <label for="msg">Message</label>
      <textarea id="msg" data-field="message" maxlength="${MAX_MESSAGE}" placeholder="Say thanks, ask a question…">${esc(this.message)}</textarea>
      <div class="counter">${this.message.length}/${MAX_MESSAGE}</div>
      <label for="from">Your name <span class="opt">(optional)</span></label>
      <input id="from" data-field="sender" placeholder="Anonymous" value="${esc(this.sender)}">
      ${nip07() ? `<label class="check"><input type="checkbox" data-field="nostr" ${this.useNostrId ? 'checked' : ''}> Sign with my Nostr identity (otherwise anonymous)</label>` : ''}
      <details ${lines.length > 1 && !this.hasAttribute('compact') ? 'open' : ''}><summary>Where your ${fmt(this.amount)} sats go</summary><ul class="splits">
        ${lines.map((l) => `<li><span>${esc(l.recipient.name)}${l.recipient.unsupported ? `<br><span class="note">${esc(l.recipient.unsupported)}</span>` : ''}</span>
          <span>${l.rail === 'none' ? '' : fmt(l.amount) + ' sats '}<span class="badge ${l.rail}">${RAIL_LABEL[l.rail]}</span></span></li>`).join('')}
      </ul>${mint ? `<div class="note pad">Mint: ${esc(new URL(mint).host)}. Mint and routing fees, if any, come out of the last share.</div>` : ''}</details>
      ${payable ? `<button class="primary" data-act="invoice">Boost ${fmt(this.amount)} sats ⚡</button>
      <div class="row mt8"><button class="ghost" data-act="token">Pay with ecash instead</button></div>
      <div class="note center wallet-note"><a href="https://cashu.space/wallets" target="_blank" rel="noopener">No wallet yet? Get one in a minute →</a></div>`
      : `<div class="err">None of these recipients can receive Cashu yet.</div>`}
      ${this.error ? `<div class="err">${esc(this.error)}</div>` : ''}`;
  }

  private invoiceView(): string {
    if (!this.invoice) return `<div class="row"><span class="spinner"></span><span>Asking the mint for an invoice…</span></div>${this.error ? `<div class="err">${esc(this.error)}</div><button data-act="back">Back</button>` : ''}`;
    const webln = (globalThis as { webln?: unknown }).webln;
    return `
      <div class="big">${fmt(this.amount)} sats</div>
      <div class="qr">${this.invoiceQr}</div>
      <div class="row"><a href="lightning:${esc(this.invoice)}"><button class="primary">Open wallet</button></a></div>
      <div class="row mt8">
        <button data-act="copy-invoice">Copy invoice</button>
        ${webln ? '<button data-act="webln">Pay with browser wallet</button>' : ''}
      </div>
      <div class="row mt12 mid"><span class="spinner"></span><span class="note m0">Waiting for payment. Your sats become ecash, then go to the creator.</span></div>
      <div class="note center"><a href="https://cashu.space/wallets" target="_blank" rel="noopener">No wallet yet? Get one in a minute →</a></div>
      ${this.error ? `<div class="err">${esc(this.error)}</div>` : ''}
      <button class="ghost mt10 wide" data-act="back">Cancel</button>`;
  }

  private tokenView(): string {
    return `
      <label for="tok">Paste a Cashu token</label>
      <textarea id="tok" data-field="token" class="mono" placeholder="cashuB…"></textarea>
      <div class="note">The whole token is boosted. It is split the same way as a Lightning boost.</div>
      ${this.error ? `<div class="err">${esc(this.error)}</div>` : ''}
      <div class="row mt10"><button class="ghost" data-act="back">Back</button><button class="primary" data-act="send-token">Boost</button></div>`;
  }

  private progressView(): string {
    const todo = this.lines.filter((l) => l.amount > 0 && l.rail !== 'none');
    const items = todo
      .map((l, i) => {
        const r = this.results[i];
        const icon = !r ? '<span class="spinner"></span>' : r.ok ? '<span class="ok">✓</span>' : '<span class="bad">✕</span>';
        return `<li>${icon}<span><b>${esc(l.recipient.name)}</b>: ${fmt(r?.sent || l.amount)} sats<br><span class="note">${esc(r ? r.detail : RAIL_LABEL[l.rail] + '…')}</span></span></li>`;
      })
      .join('');
    const done = this.view === 'done';
    const okAll = done && this.results.length > 0 && this.results.every((r) => r.ok);
    return `
      ${done ? `<div class="big center">${okAll ? 'Thank you! 🧡' : this.results.length ? 'Boost finished' : 'Your sats'}</div>` : `<div class="row"><span class="spinner"></span><span>Sending your boost…</span></div>`}
      ${todo.length || !done ? `<ul class="status">${items}</ul>` : ''}
      ${this.change ? `<div class="banner"><b>${fmt(this.change.amount)} sats</b> ${this.results.length ? 'were left over' : 'are yours again'}. Copy this token into any Cashu wallet to keep them:
        <div class="box mono mt6">${esc(this.change.token)}</div>
        <button class="mt6" data-act="copy-change">Copy token</button></div>` : ''}
      ${this.error ? `<div class="err">${esc(this.error)}</div>` : ''}
      ${done ? `<button class="ghost wide" data-act="again">Boost again</button>` : ''}`;
  }

  private wire() {
    const $ = <T extends Element>(sel: string) => this.root.querySelector<T>(sel);
    this.root.querySelectorAll<HTMLButtonElement>('[data-amt]').forEach((b) =>
      b.addEventListener('click', () => {
        this.amount = Number(b.dataset.amt);
        this.render();
      }),
    );
    $<HTMLInputElement>('[data-field="custom"]')?.addEventListener('change', (e) => {
      const v = parseInt((e.target as HTMLInputElement).value, 10);
      if (v > 0) {
        this.error = v > this.maxAmount() ? `Boosts are capped at ${fmt(this.maxAmount())} sats while Nutjar is in beta.` : '';
        this.amount = Math.min(v, this.maxAmount());
        this.render();
      }
    });
    $<HTMLTextAreaElement>('[data-field="message"]')?.addEventListener('input', (e) => {
      this.message = (e.target as HTMLTextAreaElement).value.slice(0, MAX_MESSAGE);
      const c = $('.counter');
      if (c) c.textContent = `${this.message.length}/${MAX_MESSAGE}`;
    });
    $<HTMLInputElement>('[data-field="sender"]')?.addEventListener('input', (e) => (this.sender = (e.target as HTMLInputElement).value));
    $<HTMLInputElement>('[data-field="nostr"]')?.addEventListener('change', (e) => (this.useNostrId = (e.target as HTMLInputElement).checked));

    const on = (act: string, fn: () => void) => $(`[data-act="${act}"]`)?.addEventListener('click', fn);
    on('invoice', () => this.payInvoice());
    on('token', () => {
      this.error = '';
      this.view = 'token';
      this.render();
    });
    on('send-token', () => {
      const t = $<HTMLTextAreaElement>('[data-field="token"]')?.value ?? '';
      if (t.trim()) this.payToken(t);
    });
    on('back', () => {
      this.abort?.abort();
      this.error = '';
      this.view = 'form';
      this.render();
    });
    on('again', () => {
      this.change = undefined;
      this.results = [];
      this.message = '';
      this.error = '';
      this.view = 'form';
      this.render();
    });
    on('copy-invoice', () => navigator.clipboard?.writeText(this.invoice));
    on('copy-change', () => navigator.clipboard?.writeText(this.change?.token ?? ''));
    on('webln', async () => {
      try {
        const w = (globalThis as unknown as { webln: { enable(): Promise<void>; sendPayment(pr: string): Promise<unknown> } }).webln;
        await w.enable();
        await w.sendPayment(this.invoice);
      } catch (e) {
        this.fail(e);
      }
    });
    on('recover', () => {
      const p = this.recoverable()[0];
      if (p) this.recover(p);
    });
  }
}

if (!customElements.get('cashu-boost')) customElements.define('cashu-boost', CashuBoost);
