'use strict';
// Карты кодируются строкой: ранг + масть, например "As", "Td", "2c".
// Ранги: 2..9, T, J, Q, K, A. Масти: s (пики), h (черви), d (бубны), c (трефы).

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['s', 'h', 'd', 'c'];

const RANK_VALUE = {};
RANKS.forEach((r, i) => { RANK_VALUE[r] = i + 2; }); // 2..14

const CATEGORY_NAMES = [
  'Старшая карта',
  'Пара',
  'Две пары',
  'Тройка',
  'Стрит',
  'Флеш',
  'Фулл-хаус',
  'Каре',
  'Стрит-флеш',
];

// Названия рангов: множественное число для комбинаций, единственное — для стартовой руки.
const RANK_PLURAL = {
  2: 'двоек', 3: 'троек', 4: 'четвёрок', 5: 'пятёрок', 6: 'шестёрок', 7: 'семёрок',
  8: 'восьмёрок', 9: 'девяток', 10: 'десяток', 11: 'валетов', 12: 'дам', 13: 'королей', 14: 'тузов',
};

const RANK_WORD = {
  14: 'туз', 13: 'король', 12: 'дама', 11: 'валет', 10: 'десятка', 9: 'девятка',
  8: 'восьмёрка', 7: 'семёрка', 6: 'шестёрка', 5: 'пятёрка', 4: 'четвёрка', 3: 'тройка', 2: 'двойка',
};

function freshDeck() {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  return deck;
}

// Перемешивание Фишера—Йетса на криптостойком источнике случайности.
const { randomInt } = require('node:crypto');
function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function rankOf(card) { return RANK_VALUE[card[0]]; }
function suitOf(card) { return card[1]; }

// Оценка ровно пяти карт -> целое число, чем больше, тем сильнее.
function score5(cards) {
  const ranks = cards.map(rankOf).sort((a, b) => b - a);
  const suits = cards.map(suitOf);
  const isFlush = suits.every((s) => s === suits[0]);

  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  // Сортируем группы: сначала по количеству, потом по рангу.
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  const uniq = [...counts.keys()].sort((a, b) => b - a);
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    // «Колесо»: A-2-3-4-5, туз считается младшим.
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5;
  }

  let category;
  let kickers;
  if (straightHigh && isFlush) { category = 8; kickers = [straightHigh]; }
  else if (groups[0][1] === 4) { category = 7; kickers = [groups[0][0], groups[1][0]]; }
  else if (groups[0][1] === 3 && groups[1][1] === 2) { category = 6; kickers = [groups[0][0], groups[1][0]]; }
  else if (isFlush) { category = 5; kickers = ranks; }
  else if (straightHigh) { category = 4; kickers = [straightHigh]; }
  else if (groups[0][1] === 3) { category = 3; kickers = [groups[0][0], ...groups.slice(1).map((g) => g[0])]; }
  else if (groups[0][1] === 2 && groups[1][1] === 2) { category = 2; kickers = [groups[0][0], groups[1][0], groups[2][0]]; }
  else if (groups[0][1] === 2) { category = 1; kickers = groups.map((g) => g[0]); }
  else { category = 0; kickers = ranks; }

  let value = category;
  for (let i = 0; i < 5; i++) value = value * 16 + (kickers[i] || 0);
  return value;
}

const COMBOS_5_OF_7 = (() => {
  const out = [];
  for (let a = 0; a < 7; a++)
    for (let b = a + 1; b < 7; b++)
      for (let c = b + 1; c < 7; c++)
        for (let d = c + 1; d < 7; d++)
          for (let e = d + 1; e < 7; e++) out.push([a, b, c, d, e]);
  return out;
})();

// Лучшая пятёрка из 5..7 карт. Возвращает { value, cards, name }.
function evaluate(cards) {
  if (cards.length < 5) throw new Error('Нужно минимум 5 карт');
  let best = -1;
  let bestCards = null;
  if (cards.length === 7) {
    for (const idx of COMBOS_5_OF_7) {
      const hand = idx.map((i) => cards[i]);
      const v = score5(hand);
      if (v > best) { best = v; bestCards = hand; }
    }
  } else {
    const n = cards.length;
    const idx = [0, 1, 2, 3, 4];
    const rec = (start, chosen) => {
      if (chosen.length === 5) {
        const v = score5(chosen);
        if (v > best) { best = v; bestCards = chosen.slice(); }
        return;
      }
      for (let i = start; i < n; i++) { chosen.push(cards[i]); rec(i + 1, chosen); chosen.pop(); }
    };
    void idx;
    rec(0, []);
  }
  const category = Math.floor(best / 16 ** 5);
  return { value: best, cards: bestCards, name: describe(category, bestCards) };
}

function describe(category, cards) {
  const base = CATEGORY_NAMES[category];
  if (!cards) return base;
  const ranks = cards.map(rankOf).sort((a, b) => b - a);
  const label = (v) => RANK_PLURAL[v] || String(v);
  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  switch (category) {
    case 8: return ranks[0] === 14 && ranks[4] === 10 ? 'Флеш-рояль' : 'Стрит-флеш';
    case 7: return `Каре ${label(groups[0][0])}`;
    case 6: return `Фулл-хаус, ${label(groups[0][0])} на ${label(groups[1][0])}`;
    case 3: return `Тройка ${label(groups[0][0])}`;
    case 1: return `Пара ${label(groups[0][0])}`;
    default: return base;
  }
}


// ——— сила руки ———

// Оценка стартовой руки по формуле Чена, приведённая к 0..1.
function holeStrength(cards) {
  const [a, b] = cards.map(rankOf).sort((x, y) => y - x);
  const suited = suitOf(cards[0]) === suitOf(cards[1]);
  const points = (r) => (r === 14 ? 10 : r === 13 ? 8 : r === 12 ? 7 : r === 11 ? 6 : r / 2);
  let score = points(a);
  if (a === b) score = Math.max(5, score * 2);
  if (suited) score += 2;
  const gap = a - b - 1;
  if (a !== b) {
    score -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
    if (gap <= 1 && a < 12) score += 1;
  }
  return Math.max(0, Math.min(1, (Math.ceil(score) + 2) / 22));
}

function describeHole(cards) {
  const [a, b] = cards.map(rankOf).sort((x, y) => y - x);
  const word = (v) => RANK_WORD[v] || String(v);
  const up = (t) => t[0].toUpperCase() + t.slice(1);
  if (a === b) return `Пара ${RANK_PLURAL[a]}`;
  const suited = suitOf(cards[0]) === suitOf(cards[1]);
  return `${up(word(a))} и ${word(b)}, ${suited ? 'одномастные' : 'разномастные'}`;
}

// Сила руки на конкретном борде одна и та же для всех, кто за ним сидит,
// поэтому значения рук соперника считаются один раз на борд.
const boardCache = new Map();

function opponentValues(board) {
  const key = board.join('');
  const cached = boardCache.get(key);
  if (cached) return cached;
  const rest = freshDeck().filter((c) => !board.includes(c));
  const rows = [];
  for (let i = 0; i < rest.length; i++) {
    for (let j = i + 1; j < rest.length; j++) {
      rows.push([rest[i], rest[j], evaluate([rest[i], rest[j], ...board]).value]);
    }
  }
  boardCache.set(key, rows);
  if (boardCache.size > 8) boardCache.delete(boardCache.keys().next().value);
  return rows;
}

// Доля рук соперника, которые проигрывают нашей на текущем борде (ничья — половина).
// Перебор честный: все пары карт из оставшейся колоды.
function shareBeaten(hole, board) {
  const mine = evaluate([...hole, ...board]).value;
  let score = 0;
  let total = 0;
  for (const [a, b, value] of opponentValues(board)) {
    if (a === hole[0] || a === hole[1] || b === hole[0] || b === hole[1]) continue;
    total += 1;
    if (value < mine) score += 1;
    else if (value === mine) score += 0.5;
  }
  return total ? score / total : 0;
}

// Ядро комбинации без кикеров: пара — две карты, каре — четыре, стрит и флеш — все пять.
function coreCards(category, cards) {
  if (!cards || category === 0) return [];
  if (category === 4 || category === 5 || category === 6 || category === 8) return cards.slice();
  const counts = new Map();
  for (const c of cards) counts.set(c[0], (counts.get(c[0]) || 0) + 1);
  return cards.filter((c) => counts.get(c[0]) > 1);
}

// Что за рука собралась и насколько она хороша: имя, пятёрка для подсветки, сила 0..1.
function handInfo(hole, board) {
  if (!hole || hole.length < 2) return null;
  if (!board.length) {
    const pair = hole[0][0] === hole[1][0];
    return {
      name: describeHole(hole),
      cards: pair ? hole.slice() : [],
      core: pair ? hole.slice() : [],
      category: pair ? 1 : 0,
      usesHole: 2,
      strength: holeStrength(hole),
      exact: false,
    };
  }
  const res = evaluate([...hole, ...board]);
  const category = Math.floor(res.value / 16 ** 5);
  return {
    name: res.name,
    cards: res.cards,
    core: coreCards(category, res.cards),
    category,
    usesHole: res.cards.filter((c) => hole.includes(c)).length,
    strength: shareBeaten(hole, board),
    exact: true,
  };
}

module.exports = {
  freshDeck, shuffle, evaluate, score5, rankOf, suitOf,
  handInfo, holeStrength, shareBeaten, describeHole, coreCards,
  RANKS, SUITS, CATEGORY_NAMES,
};
