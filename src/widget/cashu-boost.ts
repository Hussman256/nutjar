// <cashu-boost> — an embeddable Value4Value boost button paid in Cashu ecash.
import QRCode from 'qrcode';
import { getEncodedToken, type Proof, type Wallet } from '@cashu/cashu-ts';
import { css } from './styles';
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
import { DEFAULT_RELAYS, ephemeralSigner, extensionSigner, nip07 } from '../lib/nostr';
import { listPending, removePending, type PendingBoost } from '../lib/pending';
import { fromWire, sum } from '../lib/proofs';

type View = 'loading' | 'form' | 'invoice' | 'token' | 'sending' | 'done' | 'fatal';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmt = (n: number) => n.toLocaleString('en-US');
const MAX_MESSAGE = 280;

const RAIL_LABEL: Record<string, string> = {
  nutzap: 'nutzap',
  lightning: 'via Lightning',
  request: 'payment request',
  none: 'skipped',
};

export class CashuBoost extends HTMLElement {
  static observedAttributes = ['npub', 'lnaddress', 'recipients', 'feed', 'episode', 'payment-request', 'mint', 'label'];

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
  private loadToken = 0;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    const amounts = this.amounts();
    this.amount = amounts[1] ?? amounts[0];
    this.load();
  }

  attributeChangedCallback(_n: string, oldV: string | null, newV: string | null) {
    // Never interrupt a payment in progress; otherwise reload (load() discards stale runs).
    const busy = this.view === 'invoice' || this.view === 'token' || this.view === 'sending';
    if (this.isConnected && oldV !== newV && !busy) this.load();
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
      const feed = await fetchFeed(feedUrl);
      const guid = this.attr('episode');
      this.podcastGuid = feed.podcastGuid;
      this.episodeTitle = feed.episodes.find((e) => e.guid === guid)?.title;
      return recipientsFor(feed, guid).map((r) => ({ name: r.name, split: r.split, type: r.type, address: r.address, fee: r.fee }));
    }
    const npub = this.attr('npub');
    const ln = this.attr('lnaddress');
    if (npub || ln) return [{ name: this.attr('name') ?? 'Creator', split: 100, npub, lnaddress: ln }];
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
      if (recipients.length === 0) throw new Error('No recipient configured. Set npub, lnaddress, recipients, feed or payment-request.');
      this.recipients = recipients;
      this.view = 'form';
    } catch (e) {
      if (ticket !== this.loadToken) return;
      this.error = e instanceof Error ? e.message : String(e);
      this.view = 'fatal';
    }
    this.render();
  }

  private mint(): string | undefined {
    return pickMint(this.recipients, this.attr('mint'));
  }

  private currentPlan(mint = this.mint()): PlanLine[] {
    return mint ? plan(this.amount, this.recipients, mint) : [];
  }

  // ---------- actions ----------

  private async payInvoice() {
    const mint = this.mint();
    if (!mint) return this.fail('No mint configured: set the mint attribute or have the creator publish a nutzap profile.');
    this.error = '';
    this.view = 'invoice';
    this.invoice = '';
    this.render();
    try {
      const wallet = await loadWallet(mint);
      const funding = await fundWithInvoice(wallet, this.amount, `Boost: ${this.label()}`);
      this.invoice = funding.invoice;
      this.invoiceQr = await QRCode.toString(`lightning:${funding.invoice}`.toUpperCase(), { type: 'svg', margin: 1 });
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
        url: this.attr('url') ?? location.href,
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
    const name = this.attr('name') ?? this.recipients[0]?.name ?? 'the creator';
    this.root.innerHTML = `<style>${css}</style>
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
    const pending = listPending();
    const custom = !this.amounts().includes(this.amount);
    const payable = lines.some((l) => l.rail !== 'none');
    return `
      ${pending.length ? `<div class="banner">You have ${fmt(pending.reduce((t, p) => t + (p.proofs.length ? sum(p.proofs) : p.amount), 0))} sats from an unfinished boost. <button class="ghost" data-act="recover">Get them back</button></div>` : ''}
      <div class="amounts" role="group" aria-label="Amount in sats">
        ${this.amounts().map((a) => `<button data-amt="${a}" aria-pressed="${a === this.amount}">${fmt(a)}</button>`).join('')}
      </div>
      <input type="number" min="1" inputmode="numeric" placeholder="Custom amount (sats)" data-field="custom" value="${custom ? this.amount : ''}" aria-label="Custom amount in sats">
      <label for="msg">Message</label>
      <textarea id="msg" data-field="message" maxlength="${MAX_MESSAGE}" placeholder="Say thanks, ask a question…">${esc(this.message)}</textarea>
      <div class="counter">${this.message.length}/${MAX_MESSAGE}</div>
      <label for="from">Your name <span style="text-transform:none;font-weight:400">(optional)</span></label>
      <input id="from" data-field="sender" placeholder="Anonymous" value="${esc(this.sender)}">
      ${nip07() ? `<label class="check"><input type="checkbox" data-field="nostr" ${this.useNostrId ? 'checked' : ''}> Sign with my Nostr identity (otherwise anonymous)</label>` : ''}
      <details ${lines.length > 1 ? 'open' : ''}><summary>Where your ${fmt(this.amount)} sats go</summary><ul class="splits">
        ${lines.map((l) => `<li><span>${esc(l.recipient.name)}${l.recipient.unsupported ? `<br><span class="note">${esc(l.recipient.unsupported)}</span>` : ''}</span>
          <span>${l.rail === 'none' ? '' : fmt(l.amount) + ' sats '}<span class="badge ${l.rail}">${RAIL_LABEL[l.rail]}</span></span></li>`).join('')}
      </ul>${mint ? `<div class="note" style="padding:0 12px 10px">Mint: ${esc(new URL(mint).host)}</div>` : ''}</details>
      ${payable ? `<button class="primary" data-act="invoice">Boost ${fmt(this.amount)} sats ⚡</button>
      <div class="row" style="margin-top:8px"><button class="ghost" data-act="token">Pay with ecash instead</button></div>`
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
      <div class="row" style="margin-top:8px">
        <button data-act="copy-invoice">Copy invoice</button>
        ${webln ? '<button data-act="webln">Pay with browser wallet</button>' : ''}
      </div>
      <div class="row" style="margin-top:12px;align-items:center"><span class="spinner"></span><span class="note" style="margin:0">Waiting for payment. Your sats become ecash, then go to the creator.</span></div>
      ${this.error ? `<div class="err">${esc(this.error)}</div>` : ''}
      <button class="ghost" style="margin-top:10px;width:100%" data-act="back">Cancel</button>`;
  }

  private tokenView(): string {
    return `
      <label for="tok">Paste a Cashu token</label>
      <textarea id="tok" data-field="token" class="mono" placeholder="cashuB…"></textarea>
      <div class="note">The whole token is boosted. It is split the same way as a Lightning boost.</div>
      ${this.error ? `<div class="err">${esc(this.error)}</div>` : ''}
      <div class="row" style="margin-top:10px"><button class="ghost" data-act="back">Back</button><button class="primary" data-act="send-token">Boost</button></div>`;
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
        <div class="box mono" style="margin-top:6px">${esc(this.change.token)}</div>
        <button style="margin-top:6px" data-act="copy-change">Copy token</button></div>` : ''}
      ${this.error ? `<div class="err">${esc(this.error)}</div>` : ''}
      ${done ? `<button class="ghost" style="width:100%" data-act="again">Boost again</button>` : ''}`;
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
        this.amount = v;
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
      const p = listPending()[0];
      if (p) this.recover(p);
    });
  }
}

if (!customElements.get('cashu-boost')) customElements.define('cashu-boost', CashuBoost);
