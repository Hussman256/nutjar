export const css = /* css */ `
:host {
  --cb-accent: #e8742a;
  --cb-accent-ink: #ffffff;
  --cb-bg: #fffaf3;
  --cb-surface: #ffffff;
  --cb-ink: #2a1d12;
  --cb-muted: #7a6656;
  --cb-line: #ecdccb;
  --cb-ok: #2f8a4c;
  --cb-bad: #b8392b;
  --cb-radius: 16px;
  display: block;
  max-width: 420px;
  font: 15px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--cb-ink);
}
:host([theme="dark"]) {
  --cb-bg: #1d1712; --cb-surface: #272019; --cb-ink: #f6ece2; --cb-muted: #b5a291; --cb-line: #3b3128;
}
@media (prefers-color-scheme: dark) {
  :host(:not([theme="light"])) {
    --cb-bg: #1d1712; --cb-surface: #272019; --cb-ink: #f6ece2; --cb-muted: #b5a291; --cb-line: #3b3128;
  }
}
* { box-sizing: border-box; }
.card { background: var(--cb-bg); border: 1px solid var(--cb-line); border-radius: var(--cb-radius); padding: 18px; }
.head { display: flex; gap: 12px; align-items: center; margin-bottom: 14px; }
.nut { width: 40px; height: 40px; flex: none; border-radius: 12px; background: var(--cb-accent); color: var(--cb-accent-ink);
  display: grid; place-items: center; font-size: 20px; }
.title { font-weight: 700; font-size: 16px; }
.sub { color: var(--cb-muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 300px; }
.amounts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 10px; }
button { font: inherit; cursor: pointer; border-radius: 12px; border: 1px solid var(--cb-line); background: var(--cb-surface); color: var(--cb-ink); padding: 9px 10px; }
button:hover { border-color: var(--cb-accent); }
button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--cb-accent); outline-offset: 1px; }
button[aria-pressed="true"] { background: var(--cb-accent); color: var(--cb-accent-ink); border-color: var(--cb-accent); font-weight: 700; }
button.primary { width: 100%; background: var(--cb-accent); color: var(--cb-accent-ink); border-color: var(--cb-accent); font-weight: 700; padding: 12px; }
button.ghost { background: transparent; }
button:disabled { opacity: .55; cursor: not-allowed; }
.row { display: flex; gap: 8px; }
.row > * { flex: 1; }
label { display: block; font-size: 12px; font-weight: 600; color: var(--cb-muted); margin: 10px 0 4px; text-transform: uppercase; letter-spacing: .04em; }
input, textarea { width: 100%; font: inherit; color: var(--cb-ink); background: var(--cb-surface); border: 1px solid var(--cb-line); border-radius: 12px; padding: 9px 11px; }
textarea { resize: vertical; min-height: 64px; }
.counter { text-align: right; font-size: 11px; color: var(--cb-muted); }
details { margin: 12px 0; border: 1px solid var(--cb-line); border-radius: 12px; background: var(--cb-surface); }
summary { cursor: pointer; padding: 9px 12px; font-size: 13px; font-weight: 600; }
.splits { list-style: none; margin: 0; padding: 0 12px 10px; }
.splits li { display: flex; justify-content: space-between; gap: 8px; padding: 6px 0; border-top: 1px dashed var(--cb-line); font-size: 13px; }
.badge { font-size: 11px; padding: 2px 7px; border-radius: 99px; border: 1px solid var(--cb-line); color: var(--cb-muted); white-space: nowrap; }
.badge.nutzap { border-color: var(--cb-accent); color: var(--cb-accent); }
.badge.none { text-decoration: line-through; }
.check { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--cb-muted); margin: 10px 0; }
.check input { width: auto; }
.qr { background: #fff; border-radius: 12px; padding: 10px; display: grid; place-items: center; margin: 8px 0; }
.qr svg { width: 220px; height: 220px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }
.box { background: var(--cb-surface); border: 1px solid var(--cb-line); border-radius: 12px; padding: 10px; max-height: 90px; overflow: auto; }
.status { list-style: none; margin: 12px 0; padding: 0; }
.status li { display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; font-size: 14px; }
.ok { color: var(--cb-ok); } .bad { color: var(--cb-bad); }
.note { font-size: 12px; color: var(--cb-muted); margin-top: 10px; }
.err { color: var(--cb-bad); font-size: 13px; margin-top: 8px; }
.banner { border: 1px solid var(--cb-accent); border-radius: 12px; padding: 10px; font-size: 13px; margin-bottom: 12px; }
.spinner { width: 14px; height: 14px; border: 2px solid var(--cb-line); border-top-color: var(--cb-accent); border-radius: 50%; animation: spin 0.8s linear infinite; display: inline-block; flex: none; margin-top: 3px; }
@keyframes spin { to { transform: rotate(360deg); } }
.big { font-size: 28px; font-weight: 800; text-align: center; margin: 4px 0; }
.center { text-align: center; }
a { color: var(--cb-accent); }
.foot { margin-top: 12px; font-size: 11px; color: var(--cb-muted); text-align: center; }
`;

// Arcade skin: dark console, chunky 3D keys, gold START-style button. <cashu-boost skin="arcade">
export const arcade = /* css */ `
:host([skin="arcade"]) {
  --cb-accent: #ffc23d;
  --cb-accent-ink: #2a1a00;
  --cb-bg: #1b1a18;
  --cb-surface: #0f0e0d;
  --cb-ink: #f2f2f2;
  --cb-muted: #a8a29a;
  --cb-line: #3d3934;
  --cb-ok: #5fd38a;
  --cb-bad: #ff7a6b;
  --cb-radius: 24px;
  font-family: "Gabarito", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
:host([skin="arcade"]) .card { background: linear-gradient(180deg, #2b2926, #151412); border-color: #3a3631; box-shadow: 0 24px 60px rgba(0,0,0,.45); }
:host([skin="arcade"]) .title { font-weight: 900; font-size: 18px; letter-spacing: -.01em; }
:host([skin="arcade"]) .nut { background: linear-gradient(180deg, #ffd56b, #ffc23d 45%, #f5a800); box-shadow: inset 0 -3px 0 #e89a00, 0 2px 0 #000; border-radius: 10px; }
:host([skin="arcade"]) button { font-weight: 800; border: 0; background: #2e2b27; box-shadow: inset 0 1px 0 rgba(255,255,255,.07), 0 3px 0 #000; transition: transform .08s, box-shadow .08s; }
:host([skin="arcade"]) button:active { transform: translateY(2px); box-shadow: inset 0 1px 0 rgba(255,255,255,.07), 0 1px 0 #000; }
:host([skin="arcade"]) button[aria-pressed="true"], :host([skin="arcade"]) button.primary {
  background: linear-gradient(180deg, #ffd56b, var(--cb-accent) 45%, #f5a800); color: var(--cb-accent-ink);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.6), 0 4px 0 #a86a00, 0 8px 18px rgba(0,0,0,.35); }
:host([skin="arcade"]) button.primary { font-size: 17px; letter-spacing: .05em; text-transform: uppercase; padding: 14px; border-radius: 16px; }
:host([skin="arcade"]) button.primary:active { box-shadow: inset 0 1px 0 rgba(255,255,255,.6), 0 1px 0 #a86a00; }
:host([skin="arcade"]) button.ghost { background: transparent; box-shadow: none; text-decoration: underline; text-decoration-color: var(--cb-muted); text-underline-offset: 4px; }
:host([skin="arcade"]) .amounts button { padding: 12px 6px; font-size: 16px; }
:host([skin="arcade"]) details { background: #0f0e0d; }
:host([skin="arcade"]) .badge.nutzap { background: rgba(255,194,61,.1); }
:host([skin="arcade"]) .big { color: var(--cb-accent); text-shadow: 0 0 18px rgba(255,194,61,.35); font-weight: 900; }
:host([skin="arcade"]) .banner { background: rgba(255,194,61,.07); }
`;
