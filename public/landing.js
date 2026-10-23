'use strict';
// Живой счётчик на главной: сколько людей сейчас за столами. Страница
// полностью работает и без него — это лишь знак, что играют прямо сейчас.

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
