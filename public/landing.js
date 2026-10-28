'use strict';
// Скрипт главной: защита от зума по двойному тапу и живой счётчик игроков.

// iOS Safari увеличивает экран двойным тапом, даже когда touch-action это
// запрещает. Второй быстрый тап перехватываем сами и отдаём кнопке или
// ссылке обычным кликом — зума нет, а нажатие не теряется. Щипок на главной
// оставляем: читать текст покрупнее — нормальное желание.
const DOUBLE_TAP_MS = 350;
const TAP_SLOP = 12;            // палец сдвинулся сильнее — это прокрутка, а не тап
let tapStart = null;
let lastTapAt = 0;
document.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  tapStart = e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null;
}, { passive: true });
document.addEventListener('touchend', (e) => {
  const t = e.changedTouches[0];
  if (!tapStart || e.touches.length || !t
    || Math.abs(t.clientX - tapStart.x) > TAP_SLOP || Math.abs(t.clientY - tapStart.y) > TAP_SLOP) return;
  const quick = e.timeStamp - lastTapAt < DOUBLE_TAP_MS;
  lastTapAt = e.timeStamp;
  if (!quick) return;
  // Поле ввода должно получить фокус как обычно.
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  e.preventDefault();
  const target = e.target.closest('button, a, label, summary, [role="button"]');
  if (target && !target.disabled) target.click();
}, { passive: false });

// Мобильное меню: на узком экране ссылки шапки прячутся за кнопкой-«бургером».
// Кнопку добавляет скрипт — так она появляется на всех страницах сайта сразу.
(function burger() {
  const nav = document.querySelector('.nav');
  const links = nav && nav.querySelector('.nav__links');
  if (!links) return;
  if (!links.id) links.id = 'nav-links';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'nav__burger';
  btn.setAttribute('aria-label', 'Меню');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', links.id);
  btn.innerHTML = '<span></span><span></span><span></span>';
  nav.querySelector('.nav__in').append(btn);

  const close = () => { nav.classList.remove('is-open'); btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', () => {
    const open = !nav.classList.contains('is-open');
    nav.classList.toggle('is-open', open);
    btn.setAttribute('aria-expanded', String(open));
  });
  // Переход по ссылке (в том числе к разделу на этой же странице) закрывает меню.
  links.addEventListener('click', (e) => { if (e.target.closest('a')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.addEventListener('click', (e) => { if (!nav.contains(e.target)) close(); });
}());

// Живой счётчик: сколько людей сейчас за столами. Страница полностью
// работает и без него — это лишь знак, что играют прямо сейчас.
// Откуда пришёл игрок: метка utm_source, сайт-источник или приглашение.
// Запоминаем первый визит — он и есть настоящий источник.
const SOURCE_KEY = 'thp-source';
function captureSource(fallback) {
  try {
    if (localStorage.getItem(SOURCE_KEY)) return;
    const params = new URLSearchParams(location.search);
    let source = params.get('utm_source') || params.get('ref');
    if (!source && document.referrer) {
      const host = new URL(document.referrer).hostname.replace(/^www\./, '');
      if (host && host !== location.hostname) source = host;
    }
    localStorage.setItem(SOURCE_KEY, source || fallback || 'direct');
  } catch { /* без памяти браузера источник не узнать */ }
}
captureSource();

// Личная ссылка друга (?friend=Имя): запоминаем, игра передаст имя при регистрации.
try {
  const friend = new URLSearchParams(location.search).get('friend');
  if (friend && !localStorage.getItem('thp-friend')) localStorage.setItem('thp-friend', friend.slice(0, 40));
} catch { /* без памяти — без пригласившего */ }

(async function live() {
  const node = document.getElementById('live');
  if (!node) return;   // счётчик есть только на главной
  try {
    const res = await fetch('/api/rooms', { cache: 'no-store' });
    if (!res.ok) return;
    const { totals } = await res.json();
    if (!totals) return;
    const n = totals.humans || 0;   // только люди: боты за столами — не «играют»
    const word = (n % 10 === 1 && n % 100 !== 11) ? 'игрок'
      : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) ? 'игрока' : 'игроков';
    node.textContent = n > 0
      ? `Сейчас за столами: ${n.toLocaleString('ru-RU')} ${word}`
      : `Открыто столов: ${totals.tables.toLocaleString('ru-RU')}`;
    node.hidden = false;
  } catch {
    // Нет связи — счётчик просто не показываем.
  }
}());

// Карты на столе в первом экране — как настоящие (см. cardface.js).
if (window.CardFace) window.CardFace.upgrade();
