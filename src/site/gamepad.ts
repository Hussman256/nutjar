// NUTJAR BOY: the handheld console around a boost button, on the demo and on creators' boost links.
// The keys only pick the amount and open the invoice; paying always happens in the fan's own wallet,
// so no key press can ever spend anything.

type BoostEl = HTMLElement & {
  stepAmount(d: 1 | -1): number;
  press(): void;
  state(): { amount: number; max: number; view: string };
};

const fmt = (n: number) => n.toLocaleString('en-US');
const SOUND_KEY = 'nutjar:sound';

// ---------- sound: real sound effects (Kenney.nl, CC0; see sfx/LICENSE-*) ----------
// Loaded only once someone turns the sound on, so fans who never do download nothing.
import clickUrl from './sfx/click_001.mp3?url';
import bongUrl from './sfx/bong_001.mp3?url';
import toggleUrl from './sfx/toggle_001.mp3?url';
import chipLayUrl from './sfx/chip-lay-1.mp3?url';
import confirm1Url from './sfx/confirmation_001.mp3?url';
import collide1Url from './sfx/chips-collide-1.mp3?url';
import collide3Url from './sfx/chips-collide-3.mp3?url';
import stackUrl from './sfx/chips-stack-3.mp3?url';
import confirm2Url from './sfx/confirmation_002.mp3?url';

const FILES = { click: clickUrl, bong: bongUrl, toggle: toggleUrl, chipLay: chipLayUrl, confirm1: confirm1Url, collide1: collide1Url, collide3: collide3Url, stack: stackUrl, confirm2: confirm2Url };
type Sound = keyof typeof FILES;

let ctx: AudioContext | undefined;
let soundOn = false;
try {
  soundOn = localStorage.getItem(SOUND_KEY) === 'on';
} catch {
  /* storage blocked: sound starts off */
}
const buffers = new Map<Sound, AudioBuffer>();
let loading: Promise<void> | undefined;

function audio(): AudioContext | undefined {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return undefined;
  }
}

function loadSounds(): Promise<void> {
  const c = audio();
  if (!c) return Promise.resolve();
  return (loading ??= Promise.all(
    (Object.keys(FILES) as Sound[]).map(async (k) => {
      try {
        const res = await fetch(FILES[k]);
        buffers.set(k, await c.decodeAudioData(await res.arrayBuffer()));
      } catch {
        /* that one stays silent */
      }
    }),
  ).then(() => undefined));
}

function play(name: Sound, opts: { at?: number; rate?: number; vol?: number } = {}) {
  if (!soundOn) return;
  const c = audio();
  const buf = buffers.get(name);
  if (!c || !buf) {
    void loadSounds();
    return;
  }
  const src = c.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = opts.rate ?? 1;
  const gain = c.createGain();
  gain.gain.value = opts.vol ?? 0.8;
  src.connect(gain).connect(c.destination);
  src.start(c.currentTime + (opts.at ?? 0) / 1000);
}

// A little pitch wobble so holding a key doesn't sound like a machine gun.
const wobble = () => 0.94 + Math.random() * 0.12;
const sfx = {
  up: () => play('click', { rate: 1.18 * wobble(), vol: 0.7 }),
  down: () => play('click', { rate: 0.86 * wobble(), vol: 0.7 }),
  wall: () => play('bong', { rate: 0.8, vol: 0.6 }),
  toggle: () => play('toggle', { vol: 0.7 }),
  boost: () => {
    play('chipLay', { vol: 0.9 });
    play('confirm1', { at: 120, vol: 0.6 });
  },
  // Nuts rattling into the jar, then a happy chime.
  landed: () => {
    play('collide1', { vol: 0.9 });
    play('collide3', { at: 110, rate: 1.08, vol: 0.85 });
    play('stack', { at: 230, vol: 0.9 });
    play('collide1', { at: 380, rate: 1.15, vol: 0.6 });
    play('confirm2', { at: 520, vol: 0.7 });
  },
};
const buzz = (p: number | number[]) => {
  try {
    navigator.vibrate?.(p);
  } catch {
    /* no vibration */
  }
};

// ---------- markup ----------
export function buildPad(widget: HTMLElement): HTMLElement {
  const pad = document.createElement('div');
  pad.className = 'console';
  pad.innerHTML = `
    <div class="console-top"><span class="led" title="Lights up when your boost lands"></span><span class="grill"></span><span class="console-brand">NUTJAR&nbsp;BOY</span></div>
    <div class="console-screen"></div>
    <div class="press-hint">PRESS ⚡ TO BOOST</div>
    <div class="console-pad">
      <button class="key blue" data-k="less" aria-label="Less sats">◀</button>
      <button class="key blue" data-k="more" aria-label="More sats">▶</button>
      <button class="key red" data-k="boost" aria-label="Boost">⚡</button>
    </div>
    <div class="console-labels"><span>LESS</span><span>MORE</span><span>BOOST</span></div>
    <span class="coin" aria-hidden="true"></span>`;
  pad.querySelector('.console-screen')!.append(widget);
  return pad;
}

/** Bring a console to life: sound, vibration, power meter, hold-to-repeat, keyboard, celebration. */
export function enhancePad(pad: HTMLElement, widgetEl: HTMLElement, opts: { name?: () => string } = {}) {
  const w = widgetEl as BoostEl;
  // Small phones: trim the widget (the keys already set the amount) so screen and keys fit together.
  const small = matchMedia('(max-width: 560px)');
  const fit = () => w.toggleAttribute('compact', small.matches);
  fit();
  small.addEventListener('change', fit);
  const screen = pad.querySelector<HTMLElement>('.console-screen')!;
  const key = (k: string) => pad.querySelector<HTMLButtonElement>(`[data-k="${k}"]`)!;

  // Sound toggle on the console's top edge.
  const snd = document.createElement('button');
  snd.className = 'snd';
  snd.type = 'button';
  const paintSnd = () => {
    snd.textContent = soundOn ? '🔊' : '🔇';
    snd.setAttribute('aria-label', soundOn ? 'Sound on. Turn off' : 'Sound off. Turn on');
    snd.setAttribute('aria-pressed', String(soundOn));
  };
  paintSnd();
  snd.addEventListener('click', () => {
    soundOn = !soundOn;
    try {
      localStorage.setItem(SOUND_KEY, soundOn ? 'on' : 'off');
    } catch {
      /* fine */
    }
    paintSnd();
    if (soundOn) void loadSounds().then(sfx.toggle);
  });
  pad.querySelector('.console-top')!.append(snd);
  if (soundOn) void loadSounds();

  // The LCD strip: amount readout and a power meter that charges as the amount grows.
  const lcd = document.createElement('div');
  lcd.className = 'pad-lcd';
  lcd.innerHTML = `<span class="num"><b>0</b> SATS</span><span class="meter" aria-hidden="true">${'<i></i>'.repeat(10)}</span>`;
  screen.after(lcd);
  const num = lcd.querySelector('b')!;
  const cells = [...lcd.querySelectorAll<HTMLElement>('.meter i')];
  let shown = -1;
  const paint = () => {
    const { amount, max, view } = w.state();
    pad.classList.toggle('busy', view !== 'form');
    if (amount === shown) return;
    const grew = amount > shown;
    shown = amount;
    num.textContent = fmt(amount);
    const level = Math.max(1, Math.round((Math.log10(Math.max(1, amount)) / Math.log10(Math.max(10, max))) * cells.length));
    cells.forEach((c, i) => c.classList.toggle('on', i < level));
    lcd.classList.toggle('max', amount >= max);
    num.classList.remove('bump', 'dip');
    void num.offsetWidth;
    num.classList.add(grew ? 'bump' : 'dip');
  };
  new MutationObserver(paint).observe(w.shadowRoot ?? w, { childList: true, subtree: true, characterData: true });
  paint();

  const flash = (k: HTMLElement) => {
    k.classList.add('pressed');
    setTimeout(() => k.classList.remove('pressed'), 120);
  };
  const step = (dir: 1 | -1) => {
    if (w.state().view !== 'form') return false;
    const before = w.state().amount;
    const after = w.stepAmount(dir);
    if (after === before) {
      sfx.wall();
      buzz(40);
      lcd.classList.remove('shake');
      void lcd.offsetWidth;
      lcd.classList.add('shake');
      return false;
    }
    (dir > 0 ? sfx.up : sfx.down)();
    buzz(8);
    paint();
    return true;
  };
  const boost = () => {
    flash(key('boost'));
    if (w.state().view === 'form') {
      sfx.boost();
      buzz([12, 30, 12]);
      pad.classList.remove('lit');
    }
    w.press();
    paint();
  };

  // Hold ◀ / ▶ to keep going, faster the longer you hold.
  for (const [k, dir] of [['less', -1], ['more', 1]] as const) {
    const el = key(k);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture?.(e.pointerId);
      stop();
      flash(el);
      if (!step(dir)) return;
      let delay = 340;
      const again = () => {
        timer = setTimeout(() => {
          if (!step(dir)) return stop();
          delay = Math.max(70, delay * 0.72);
          again();
        }, delay);
      };
      again();
    });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(ev, stop);
    // Keyboard activation of the focused button (Enter/Space) arrives as a click with detail 0.
    el.addEventListener('click', (e) => {
      if (e.detail === 0) step(dir);
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  key('boost').addEventListener('click', boost);

  // Arrow keys and Enter work the pad on computers, while it is on screen and you aren't typing.
  let visible = false;
  new IntersectionObserver(([e]) => (visible = e.isIntersecting && e.intersectionRatio > 0.4), { threshold: [0, 0.4, 1] }).observe(pad);
  document.addEventListener('keydown', (e) => {
    if (!visible || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.composedPath()[0] as HTMLElement | undefined;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    if (t && t.tagName === 'BUTTON' && !pad.contains(t)) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      flash(key(e.key === 'ArrowLeft' ? 'less' : 'more'));
      step(e.key === 'ArrowLeft' ? -1 : 1);
    } else if (e.key === 'Enter' && !(t && pad.contains(t) && t.tagName === 'BUTTON')) {
      e.preventDefault();
      boost();
    }
  });

  // The boost landed: coins burst out, the screen says so, the light goes wild.
  w.addEventListener('boost', (e) => {
    const amount = (e as CustomEvent<{ amount: number }>).detail?.amount ?? w.state().amount;
    pad.classList.add('lit', 'party');
    setTimeout(() => pad.classList.remove('party'), 2600);
    sfx.landed();
    buzz([30, 40, 30, 40, 90]);
    const card = document.createElement('div');
    card.className = 'landed';
    const who = opts.name?.() || w.getAttribute('name') || 'the creator';
    card.innerHTML = `<div><span class="t">BOOST LANDED!</span><span class="a"></span><span class="w"></span></div>`;
    card.querySelector('.a')!.textContent = `${fmt(amount)} sats`;
    card.querySelector('.w')!.textContent = `→ ${who}`;
    screen.append(card);
    setTimeout(() => card.remove(), 2800);
    for (let i = 0; i < 18; i++) {
      const c = document.createElement('span');
      c.className = 'burst';
      const ang = (Math.PI * 2 * i) / 18 + Math.random() * 0.3;
      const dist = 90 + Math.random() * 110;
      c.style.setProperty('--dx', `${Math.cos(ang) * dist}px`);
      c.style.setProperty('--dy', `${Math.sin(ang) * dist - 60}px`);
      c.style.setProperty('--r', `${Math.round(Math.random() * 720 - 360)}deg`);
      c.style.animationDelay = `${Math.random() * 120}ms`;
      pad.append(c);
      setTimeout(() => c.remove(), 1600);
    }
    paint();
  });
}
