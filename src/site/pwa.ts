// Installable app: register the service worker and offer "Install app" wherever it makes sense.
// Browsers only hand us an install prompt (beforeinstallprompt) after their own checks, which can
// take a while or never happen (Brave, Samsung Internet, iPhone). So on phones the button shows
// right away: it uses the prompt when we have one, and otherwise opens a short how-to sheet.
interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  // Register as early as possible: the browser won't offer installing before the worker is active.
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
document.documentElement.classList.toggle('is-app', standalone);

const ua = navigator.userAgent;
const ios = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
const mobile = ios || /android|mobile/i.test(ua);
const links = document.querySelector('nav .links');
let deferred: InstallPrompt | undefined;

const canOffer = !standalone && !document.body.hasAttribute('data-no-install');
document.documentElement.classList.toggle('can-install', canOffer && mobile);

function steps(): string[] {
  if (ios) return ['Tap the <b>Share</b> button (the square with an arrow) in Safari.', 'Scroll down and tap <b>Add to Home Screen</b>.', 'Tap <b>Add</b>.'];
  if (/samsungbrowser/i.test(ua)) return ['Tap the <b>☰</b> menu at the bottom right.', 'Tap <b>Add page to</b>, then <b>Home screen</b>.', 'Tap <b>Add</b>.'];
  return ['Tap the browser menu <b>⋮</b> (top or bottom right).', 'Tap <b>Install app</b> or <b>Add to Home screen</b>.', 'Tap <b>Install</b> / <b>Add</b>.'];
}

function sheet() {
  let el = document.getElementById('install-sheet');
  if (!el) {
    el = document.createElement('div');
    el.id = 'install-sheet';
    el.className = 'sheet';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML = `<div class="sheet-card"><h3>Add Nutjar to your home screen</h3><ol>${steps().map((s) => `<li>${s}</li>`).join('')}</ol>
      <p class="small muted">If your phone says <b>"Home screen layout locked"</b>: long-press an empty spot on your home screen, open <b>Settings</b>, turn off <b>Lock Home screen layout</b>, and try again.</p>
      <button class="ghost" type="button" data-close style="width:100%">Got it</button></div>`;
    el.addEventListener('click', (e) => {
      if (e.target === el || (e.target as HTMLElement).closest('[data-close]')) el!.classList.remove('open');
    });
    document.body.append(el);
  }
  requestAnimationFrame(() => el!.classList.add('open'));
}

async function install() {
  if (deferred) {
    const d = deferred;
    deferred = undefined;
    await d.prompt();
    if ((await d.userChoice).outcome === 'accepted') {
      document.documentElement.classList.remove('can-install');
      links?.querySelector('.install')?.remove();
    }
    return;
  }
  sheet();
}

// Any element with data-install (nav button, the app's banner, the More tab) installs.
document.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest('[data-install]');
  if (!t) return;
  e.preventDefault();
  void install();
});

function addButton() {
  if (!links || !canOffer || links.querySelector('.install')) return;
  const a = document.createElement('a');
  a.href = '#';
  a.className = 'install';
  a.dataset.install = '';
  a.textContent = '⬇ Install app';
  links.prepend(a);
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e as InstallPrompt;
  document.documentElement.classList.add('can-install');
  addButton();
});
window.addEventListener('appinstalled', () => {
  document.documentElement.classList.remove('can-install');
  links?.querySelector('.install')?.remove();
});

if (mobile) addButton();
