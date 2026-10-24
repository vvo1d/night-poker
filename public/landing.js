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

// Живой счётчик: сколько людей сейчас за столами. Страница полностью
// работает и без него — это лишь знак, что играют прямо сейчас.
(async function live() {
  const node = document.getElementById('live');
  if (!node) return;
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
