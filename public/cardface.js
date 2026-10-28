'use strict';
// Лицо карты — минимализм: высокий ранг и масть в левом верхнем углу, крупная
// масть в правом нижнем — одинаково у всех карт, от двойки до туза.
// Веером внахлёст открытой остаётся левая полоса с индексом — карту видно и в Омахе.
// Общий для стола (app.js), повтора раздачи (replay.js), главной и заставки.
// Размеры — в долях ширины карты (cqw, см. cards.css): одна разметка на все размеры.

(function () {
  const GLYPH = { s: '♠', h: '♥', d: '♦', c: '♣' };

  function span(cls, text) {
    const n = document.createElement('span');
    n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function index(rank, glyph) {
    const box = span('card__idx');
    box.append(span(`card__idx-r${rank.length > 1 ? ' is-ten' : ''}`, rank), span('card__idx-s', glyph));
    return box;
  }

  // Заполняет лицевую сторону карты code ('Ah', 'Td', 'Qs', …): индекс слева
  // сверху, крупная масть справа снизу.
  function fill(front, code) {
    const glyph = GLYPH[code[1]];
    const rank = code[0] === 'T' ? '10' : code[0];
    // Один шаблон для всех карт: индекс слева сверху, крупная масть справа снизу.
    front.append(span('card__big', glyph), index(rank, glyph));
    front.setAttribute('aria-label', `${rank}${glyph}`);
  }

  // Статичные карты (главная, заставка загрузки): <span data-card="As">A♠</span>
  // превращаются в настоящие; без скриптов остаётся простая надпись.
  function upgrade(root = document) {
    for (const node of root.querySelectorAll('[data-card]')) {
      node.textContent = '';
      node.classList.add('card--real');
      fill(node, node.dataset.card);
    }
  }

  window.CardFace = { fill, upgrade, GLYPH };
}());
