// The creator app as a phone app: on narrow screens (and when installed) the page becomes an app
// with a slim top bar and a bottom tab bar (Jar, Messages, Share, More), one screen per tab.
// Desktop keeps the full page. inbox-page.ts stays unaware of all this: we only watch the DOM it updates.
const $ = (id: string) => document.getElementById(id)!;
const root = document.documentElement;

type Tab = 'jar' | 'messages' | 'share' | 'more';
const TITLES: Record<Tab, string> = { jar: 'Your jar', messages: 'Messages', share: 'Share', more: 'More' };

const phone = matchMedia('(max-width: 760px)');
const installed = () => matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

function setMode() {
  root.classList.toggle('app-mode', phone.matches || installed());
}
setMode();
phone.addEventListener('change', setMode);

// ---------- signed in or not (inbox-page.ts shows/hides #main and #signed-in) ----------
function syncSignedIn() {
  const inMain = !$('main').classList.contains('hidden');
  const signedIn = !$('signed-in').classList.contains('hidden');
  root.classList.toggle('in-main', inMain);
  root.classList.toggle('signed-in', signedIn);
  $('acct-btn').classList.toggle('hidden', !signedIn);
  $('app-title').textContent = inMain ? TITLES[current] : signedIn ? 'Set up' : '';
}
const watch = (el: Element, fn: () => void, opts: MutationObserverInit = { attributes: true, attributeFilter: ['class'] }) =>
  new MutationObserver(fn).observe(el, opts);
watch($('main'), syncSignedIn);
watch($('signed-in'), syncSignedIn);

// ---------- tabs ----------
let current: Tab = 'jar';
try {
  const saved = sessionStorage.getItem('nutjar-tab') as Tab | null;
  if (saved && saved in TITLES) current = saved;
} catch {
  /* storage blocked: start on the jar */
}

function go(tab: Tab, scroll = true) {
  current = tab;
  root.dataset.tab = tab;
  for (const b of document.querySelectorAll<HTMLButtonElement>('#tabbar button')) {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  $('app-title').textContent = root.classList.contains('in-main') ? TITLES[tab] : $('app-title').textContent;
  if (scroll) window.scrollTo({ top: 0 });
  try {
    sessionStorage.setItem('nutjar-tab', tab);
  } catch {
    /* fine */
  }
}
go(current, false);
for (const b of document.querySelectorAll<HTMLButtonElement>('#tabbar button')) {
  b.addEventListener('click', () => go(b.dataset.tab as Tab));
}
$('acct-btn').addEventListener('click', () => go('more'));
$('acct-signout').addEventListener('click', () => $('signed-in').click());

// ---------- badges: new messages count, a dot on the jar when boosts wait to be collected ----------
function syncBadges() {
  $('tab-badge').textContent = $('zap-count').textContent ?? '';
  $('tab-dot').classList.toggle('on', $('collect-strip').classList.contains('has-new'));
}
watch($('zap-count'), syncBadges, { childList: true, characterData: true, subtree: true });
watch($('collect-strip'), syncBadges);
syncBadges();

// ---------- account details live in More; the jar keeps only warnings ----------
function syncStatus() {
  const html = $('status').innerHTML;
  $('acct-status').innerHTML = html;
  $('status').classList.toggle('quiet', /^Signed in as/.test($('status').textContent ?? ''));
}
watch($('status'), syncStatus, { childList: true, characterData: true, subtree: true });

// ---------- sign-in screen: the extension option is for computers, tucked away on phones ----------
$('ext-toggle').addEventListener('click', () => {
  $('ext-panel').classList.add('shown');
  $('ext-toggle').classList.add('hidden');
});

syncSignedIn();

// ---------- "Take your sats out": quiet when the jar is empty, a hint of what's inside when not ----------
function syncTakeOut() {
  const text = $('balance-total').textContent ?? '';
  const sats = Number(text.replace(/[^\d]/g, '')) || 0;
  const loading = /opening|loading/i.test(text);
  const locked = /locked/i.test(text);
  $('take-out').classList.toggle('empty', locked || (!loading && sats === 0));
  $('take-sub').textContent = loading ? 'Opening your jar…' : locked ? 'Unlock your jar first' : sats > 0 ? `${text} ready to move to your own wallet` : 'Collect boosts first, then move them here';
}
watch($('balance-total'), syncTakeOut, { childList: true, characterData: true, subtree: true });
syncTakeOut();
