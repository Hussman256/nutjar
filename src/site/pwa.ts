// Installable app: register the service worker and offer an "Install app" button where supported.
interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
document.documentElement.classList.toggle('is-app', standalone);

const links = document.querySelector('nav .links');
let deferred: InstallPrompt | undefined;

function addButton(label: string, onClick: () => void) {
  if (!links || standalone || links.querySelector('.install') || document.body.hasAttribute('data-no-install')) return;
  const a = document.createElement('a');
  a.href = '#';
  a.className = 'install';
  a.textContent = label;
  a.addEventListener('click', (e) => {
    e.preventDefault();
    onClick();
  });
  links.prepend(a);
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e as InstallPrompt;
  addButton('⬇ Install app', async () => {
    await deferred?.prompt();
    if ((await deferred?.userChoice)?.outcome === 'accepted') links?.querySelector('.install')?.remove();
    deferred = undefined;
  });
});

// iPhone/iPad Safari has no install prompt; explain the Share-sheet route instead.
const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);
if (ios && !standalone) {
  addButton('⬇ Get the app', () => alert('To install Nutjar: tap the Share button in Safari, then "Add to Home Screen".'));
}
