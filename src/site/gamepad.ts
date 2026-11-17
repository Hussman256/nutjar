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

// ---------- sound: tiny synthesized blips, no files ----------
let ctx: AudioContext | undefined;
let soundOn = false;
try {
  soundOn = localStorage.getItem(SOUND_KEY) === 'on';
} catch {
  /* storage blocked: sound starts off */
}

function tone(freq: number, ms: number, opts: { type?: OscillatorType; vol?: number; to?: number; at?: number } = {}) {
  if (!soundOn) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const t = ctx.currentTime + (opts.at ?? 0) / 1000;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = opts.type ?? 'square';
    osc.frequency.setValueAtTime(freq, t);
    if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, t + ms / 1000);
    gain.gain.setValueAtTime(opts.vol ?? 0.04, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + ms / 1000 + 0.02);
  } catch {
    /* no audio on this device */
  }
}

const sfx = {
  up: () => tone(660, 70, { to: 990 }),
  down: () => tone(520, 70, { to: 330 }),
  wall: () => tone(110, 120, { type: 'sawtooth', vol: 0.03 }),
  boost: () => [523, 659, 784].forEach((f, i) => tone(f, 90, { at: i * 70 })),
  landed: () => {
    tone(988, 90, { at: 0 });
    tone(1319, 420, { at: 90, vol: 0.05 });
    [1568, 2093].forEach((f, i) => tone(f, 120, { at: 420 + i * 90, type: 'triangle', vol: 0.03 }));
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
    sfx.up();
  });
  pad.querySelector('.console-top')!.append(snd);

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
