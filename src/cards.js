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
//
// Функция вызывается миллионы раз (перебор рук соперника для силомера,
// вскрытия, боты), поэтому написана без выделения памяти и сортировок:
// ранги считаются в постоянном буфере, стрит ищется по битовой маске.
const rankCount = new Int8Array(15);   // сколько карт каждого ранга (2..14)
const suitCount = new Int8Array(4);
const SUIT_INDEX = { s: 0, h: 1, d: 2, c: 3 };

// Маски пяти подряд: от туза сверху до «колеса» A-2-3-4-5.
const STRAIGHTS = (() => {
  const out = [];
  for (let high = 14; high >= 6; high--) {
    let mask = 0;
    for (let r = high; r > high - 5; r--) mask |= 1 << r;
    out.push([mask, high]);
  }
  out.push([(1 << 14) | (1 << 5) | (1 << 4) | (1 << 3) | (1 << 2), 5]); // колесо
  return out;
})();

function score5(cards) {
  rankCount.fill(0);
  suitCount[0] = 0; suitCount[1] = 0; suitCount[2] = 0; suitCount[3] = 0;
  let mask = 0;

  for (let i = 0; i < 5; i++) {
    const card = cards[i];
    const rank = RANK_VALUE[card[0]];
    rankCount[rank] += 1;
    mask |= 1 << rank;
    suitCount[SUIT_INDEX[card[1]]] += 1;
  }

  const isFlush = suitCount[0] === 5 || suitCount[1] === 5 || suitCount[2] === 5 || suitCount[3] === 5;

  let straightHigh = 0;
  for (let i = 0; i < STRAIGHTS.length; i++) {
    if ((mask & STRAIGHTS[i][0]) === STRAIGHTS[i][0]) { straightHigh = STRAIGHTS[i][1]; break; }
  }

  // Ранги по группам, от старших к младшим: сначала четвёрки, потом тройки и так далее.
  let quad = 0; let trips = 0; let pairHigh = 0; let pairLow = 0;
  let k1 = 0; let k2 = 0; let k3 = 0;
  for (let r = 14; r >= 2; r--) {
    const n = rankCount[r];
    if (!n) continue;
    if (n === 4) quad = r;
    else if (n === 3) { if (trips) { if (!pairHigh) pairHigh = r; } else trips = r; }
    else if (n === 2) { if (!pairHigh) pairHigh = r; else if (!pairLow) pairLow = r; }
    else if (!k1) k1 = r; else if (!k2) k2 = r; else if (!k3) k3 = r;
  }

  let category;
  let a = 0; let b = 0; let c = 0; let d = 0; let e = 0;
  if (straightHigh && isFlush) { category = 8; a = straightHigh; }
  else if (quad) { category = 7; a = quad; b = k1; }
  else if (trips && pairHigh) { category = 6; a = trips; b = pairHigh; }
  else if (isFlush) {
    category = 5;
    // Флеш сравнивается по всем пяти картам сверху вниз.
    let i = 0;
    for (let r = 14; r >= 2 && i < 5; r--) {
      if (!rankCount[r]) continue;
      if (i === 0) a = r; else if (i === 1) b = r; else if (i === 2) c = r; else if (i === 3) d = r; else e = r;
      i += 1;
    }
  } else if (straightHigh) { category = 4; a = straightHigh; }
  else if (trips) { category = 3; a = trips; b = k1; c = k2; }
  else if (pairHigh && pairLow) { category = 2; a = pairHigh; b = pairLow; c = k1; }
  else if (pairHigh) { category = 1; a = pairHigh; b = k1; c = k2; d = k3; }
  else {
    category = 0;
    let i = 0;
    for (let r = 14; r >= 2 && i < 5; r--) {
      if (!rankCount[r]) continue;
      if (i === 0) a = r; else if (i === 1) b = r; else if (i === 2) c = r; else if (i === 3) d = r; else e = r;
      i += 1;
    }
  }

  return ((((category * 16 + a) * 16 + b) * 16 + c) * 16 + d) * 16 + e;
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

// Только сила руки, без лучшей пятёрки и названия: используется там,
// где результат нужен миллионами — в переборе рук соперника.
const scratch5 = new Array(5);
function bestValue(cards) {
  const n = cards.length;
  if (n === 5) return score5(cards);
  let best = -1;
  if (n === 7) {
    for (let k = 0; k < COMBOS_5_OF_7.length; k++) {
      const idx = COMBOS_5_OF_7[k];
      for (let i = 0; i < 5; i++) scratch5[i] = cards[idx[i]];
      const v = score5(scratch5);
      if (v > best) best = v;
    }
    return best;
  }
  // Шесть карт: шесть пятёрок.
  for (let skip = 0; skip < n; skip++) {
    let at = 0;
    for (let i = 0; i < n; i++) if (i !== skip) scratch5[at++] = cards[i];
    const v = score5(scratch5);
    if (v > best) best = v;
  }
  return best;
}

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
// поэтому значения рук соперника считаются один раз на стол и на улицу.
// Храним только числа: тысяча пар — это четыре килобайта, а не мегабайты объектов.
function opponentValues(board, cache) {
  const key = board.join('');
  if (cache && cache.key === key) return cache;

  const rest = freshDeck().filter((c) => !board.includes(c));
  const n = rest.length;
  const values = new Int32Array((n * (n - 1)) / 2);
  const hand = [null, null, ...board];
  let k = 0;
  for (let i = 0; i < n; i++) {
    hand[0] = rest[i];
    for (let j = i + 1; j < n; j++) {
      hand[1] = rest[j];
      values[k++] = bestValue(hand);
    }
  }
  const built = { key, rest, values };
  if (cache) Object.assign(cache, built);
  return built;
}

// Доля рук соперника, которые проигрывают нашей на текущем борде (ничья — половина).
// Перебор честный: все пары карт из оставшейся колоды.
function shareBeaten(hole, board, cache) {
  const { rest, values } = opponentValues(board, cache);
  const mine = bestValue([...hole, ...board]);
  const skipA = rest.indexOf(hole[0]);
  const skipB = rest.indexOf(hole[1]);

  const n = rest.length;
  let k = 0;
  let score = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const skipI = i === skipA || i === skipB;
    for (let j = i + 1; j < n; j++, k++) {
      if (skipI || j === skipA || j === skipB) continue;
      const value = values[k];
      total += 1;
      if (value < mine) score += 1;
      else if (value === mine) score += 0.5;
    }
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
// withStrength=false отдаёт только название и карты комбинации: перебор рук
// соперника — самая тяжёлая арифметика, и если игрок выключил силомер,
// считать её незачем.
function handInfo(hole, board, cache, withStrength = true) {
  if (!hole || hole.length < 2) return null;
  if (!board.length) {
    const pair = hole[0][0] === hole[1][0];
    return {
      name: describeHole(hole),
      cards: pair ? hole.slice() : [],
      core: pair ? hole.slice() : [],
      category: pair ? 1 : 0,
      usesHole: 2,
      strength: withStrength ? holeStrength(hole) : null,
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
    strength: withStrength ? shareBeaten(hole, board, cache) : null,
    exact: true,
  };
}

module.exports = {
  freshDeck, shuffle, evaluate, score5, rankOf, suitOf,
  handInfo, holeStrength, shareBeaten, describeHole, coreCards, bestValue,
  RANKS, SUITS, CATEGORY_NAMES,
};
