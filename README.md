# 🥜 Nutjar

**A Value4Value boost button paid in Cashu ecash.** Drop it on any podcast episode, article, video or creator page. Listeners pick an amount, write a message and pay with Lightning or ecash. Creators receive the boost as a [NIP-61 nutzap](https://github.com/nostr-protocol/nips/blob/master/61.md), split between hosts, guests and editors the way their [Podcasting 2.0 feed](https://podcasting2.org/docs/podcast-namespace/tags/value) says.

Built for [Nut November](https://nutnovember.org), Value4Value track.

```html
<script src="https://hussman256.github.io/nutjar/nutjar.js" defer></script>
<cashu-boost npub="npub1…" lnaddress="you@getalby.com" label="Episode 42"></cashu-boost>
```

## What's in the box

| Page | What it does |
|---|---|
| `index.html` | Landing page with a **two-sided live demo**: boost on the left, watch two demo creators' inbox receive and collect it on the right. Runs on the testnut mint (fake sats, self-paying invoices). |
| `embed.html` | **Embed builder**. Enter an npub/lightning address, or load your RSS feed and pick an episode. Live preview, copy the code. |
| `inbox.html` | **Creator inbox**. Sign in with a NIP-07 extension, set up receiving (NIP-60 key + NIP-61 profile), read boosts and messages, collect ecash, cash out to a lightning address. |
| `nutjar.js` | The widget: one script, a `<cashu-boost>` web component in shadow DOM. Works on any page. |

## How a boost flows

1. **Resolve recipients.** From `recipients`, `feed` + `episode`, `npub`/`lnaddress`, or a NUT-18 `payment-request`. For each recipient the widget looks for a nutzap profile (kind `10019`): directly via npub, or by following their lightning address's NIP-05 to a nostr key.
2. **Fund.** The listener pays a Lightning invoice from a mint quote (NUT-04), or pastes a Cashu token that is swapped into fresh proofs right away so it can't be double-spent mid-boost.
3. **Split.** Largest-remainder integer split by `split` weight. `fee="true"` recipients take their percentage off the top. Keysend-only recipients can't be paid by a mint, so they're shown as skipped and their share is spread over the rest.
4. **Deliver each share** by the best rail available:
   - **Nutzap.** Ecash P2PK-locked to the recipient's key (sender prepays the redemption fee, so they net exactly what the widget showed), published as kind `9321` with the message as content and NIP-73 `i` tags (`podcast:item:guid:…`, `podcast:guid:…`).
   - **Lightning.** Melt (NUT-05) to the recipient's lightning address, message as a LUD-12 comment.
   - **NUT-18.** POST the payload to the payment request's endpoint.
5. **Leftovers** (rounding, fee change) are handed back to the listener as a token. Anything in flight is checkpointed to `localStorage`, so a closed tab never silently loses sats ("Get them back" banner).

## Widget attributes

| Attribute | Meaning |
|---|---|
| `npub` | Creator's nostr key. Boosts become nutzaps if they publish a kind 10019 profile. |
| `lnaddress` | Lightning address fallback (also used to discover an npub via NIP-05). |
| `recipients` | JSON array: `[{"name","split","npub"?,"lnaddress"?,"type"?,"address"?,"fee"?}]`. Podcasting 2.0 `valueRecipient`s map 1:1. |
| `feed`, `episode` | Read splits from an RSS feed at runtime (needs CORS on the feed). The embed builder bakes them into `recipients` instead. |
| `podcast-guid` | Feed GUID for the NIP-73 tag. |
| `payment-request` | A NUT-18 `creqA…` with an HTTP POST transport. |
| `mint` | Mint to fund Lightning payments at. Default: first mint the main recipient accepts, else Minibits. |
| `label`, `name` | What's being boosted / who. |
| `amounts` | Up to 4 preset amounts, e.g. `21,100,500,2100`. |
| `theme` | `light`, `dark`, or omit for auto. |
| `relays` | Comma-separated relay list. |
| CSS | `--cb-accent`, `--cb-bg`, `--cb-ink`, … and `::part(card)`. |

The element fires a `boost` event (`detail: { amount, results }`) when done.

## Standards used

Cashu NUT-00/03/04/05/07/10/11/12/18 · Nostr NIP-05, NIP-07, NIP-44, NIP-60 (wallet key), NIP-61 (nutzaps), NIP-73 (podcast identifiers) · LUD-06/12/16 · Podcasting 2.0 `podcast:value`.

This lines up with the Cashu plans in the [Hopp](https://gitlab.com/nodesignal/hopp) player's wallet design notes (ADR 0005: "Ecash: nutzap (NIP-61)"), so a future Hopp Cashu wallet could read these boosts directly.

## Develop

```bash
npm install
npm run dev        # site with hot reload
npm run build      # site + standalone dist/nutjar.js
npm run e2e        # end-to-end tests against testnut.cashu.space
npm run typecheck
```

`npm run e2e` mints real test ecash, splits a boost 60/40 to two nutzap recipients with a keysend recipient skipped, checks the events (kind, tags, signatures, P2PK locks), proves a stranger can't redeem them and each recipient can, then pays a lightning-address recipient through a local mock LNURL server and checks the invoice was paid and the comment arrived.

## Security notes

- The widget is non-custodial static code. Ecash exists in the listener's browser only between funding and delivery, and is checkpointed to `localStorage` during that time.
- **Mints are trusted** for the sats they back. Creators choose which mints they accept. Listeners paying by Lightning fund at the embed's mint.
- Nutzaps are **public** on relays: amount, message, episode and time are visible (the sender is an ephemeral key unless they opt to sign with their own). Hopp's ADR 0014 prefers NUT-18 for private streaming for this reason; the widget supports both.
- The inbox never asks for an nsec. The receiving key is stored NIP-44-encrypted to the creator (NIP-60), and only their extension can decrypt it.
- This is hackathon software. Use small amounts.

## Built in November

Everything in this repository was written during Nut November 2026 (started 12 Nov 2026). See the git history.

## License

MIT
