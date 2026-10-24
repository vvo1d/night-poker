'use strict';
// Статистика игрока и ачивки. Счётчики копятся по ходу игры. Ачивка растёт
// ступенями: бронза, серебро, золото, платина — каждая следующая требует
// больше. Взятая ступень остаётся навсегда.

// Всё, что считаем по игроку. Новые поля дописываются сюда: у старых
// игроков они появятся сами со значением по умолчанию.
const DEFAULT_STATS = {
  handsWon: 0,        // забрал банк (в том числе когда все сбросили)
  handsLost: 0,       // вложил фишки и ничего не забрал
  showdowns: 0,       // дошёл до вскрытия против соперника
  showdownsWon: 0,
  allInsWon: 0,       // выиграл банк, стоя в олл-ине
  biggestPot: 0,      // самый крупный выигранный банк
  cashNet: 0,         // итог кэш-игры: выиграно минус вложено
  bestHand: null,     // { value, name, cards } — лучшая комбинация на вскрытии
  sngPlayed: 0,
  sngCashes: 0,       // призовые места
  sngWins: 0,
  sngPrizes: 0,       // сколько получено призами
  peakChips: 0,       // максимум фишек в банке
  mttPlayed: 0,       // турниры по расписанию
  mttCashes: 0,
  mttWins: 0,
  mttPrizes: 0,
};

function freshStats(saved) {
  return { ...DEFAULT_STATS, ...(saved || {}) };
}

const TIER_NAMES = ['бронза', 'серебро', 'золото', 'платина'];

// Категория комбинации по значению оценки: 0 — старшая карта … 8 — стрит-флеш.
const category = (value) => Math.floor(value / 16 ** 5);

// Ранг лучшей комбинации для лестницы «Комбинации»: флеш-рояль — отдельная ступень над стрит-флешем.
function comboRank(s) {
  if (!s.bestHand) return 0;
  return s.bestHand.name === 'Флеш-рояль' ? 9 : category(s.bestHand.value);
}

const many = (n, one, few, lots) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return lots;
};
const num = (n) => n.toLocaleString('ru-RU');

// Порядок здесь — порядок показа в кабинете. goal(n) — условие ступени словами.
// progress: false — счётчик не имеет смысла показывать полоской (лестница комбинаций).
const ACHIEVEMENTS = [
  { id: 'hands', icon: '♠', title: 'Завсегдатай', tiers: [10, 100, 1000, 10000],
    value: (s, u) => u.handsPlayed,
    goal: (n) => `Сыграть ${num(n)} ${many(n, 'раздачу', 'раздачи', 'раздач')}` },
  { id: 'wins', icon: '♣', title: 'Сборщик банков', tiers: [1, 50, 500, 5000],
    value: (s) => s.handsWon,
    goal: (n) => `Выиграть ${num(n)} ${many(n, 'раздачу', 'раздачи', 'раздач')}` },
  { id: 'showdowns', icon: '◎', title: 'Карты на стол', tiers: [5, 50, 250, 1000],
    value: (s) => s.showdownsWon,
    goal: (n) => `Выиграть ${num(n)} ${many(n, 'вскрытие', 'вскрытия', 'вскрытий')}` },
  { id: 'allins', icon: '⚡', title: 'Ва-банк', tiers: [1, 10, 50, 200],
    value: (s) => s.allInsWon,
    goal: (n) => `Выиграть ${num(n)} ${many(n, 'олл-ин', 'олл-ина', 'олл-инов')}` },
  { id: 'pot', icon: '◆', title: 'Крупный куш', tiers: [1000, 5000, 50000, 250000],
    value: (s) => s.biggestPot,
    goal: (n) => `Забрать банк от ${num(n)}` },
  { id: 'combos', icon: '♛', title: 'Комбинации', tiers: [6, 7, 8, 9], progress: false,
    value: comboRank,
    goal: (n) => `Собрать на вскрытии ${{ 6: 'фулл-хаус', 7: 'каре', 8: 'стрит-флеш', 9: 'флеш-рояль' }[n]}` },
  { id: 'sng', icon: '♜', title: 'Турнирщик', tiers: [1, 10, 50, 200],
    value: (s) => s.sngPlayed,
    goal: (n) => `Сыграть ${num(n)} sit-n-go` },
  { id: 'sng_cash', icon: '♜', title: 'В деньгах', tiers: [1, 10, 50, 200],
    value: (s) => s.sngCashes,
    goal: (n) => `Занять призовое место ${num(n)} ${many(n, 'раз', 'раза', 'раз')}` },
  { id: 'sng_win', icon: '♚', title: 'Чемпион', tiers: [1, 5, 25, 100],
    value: (s) => s.sngWins,
    goal: (n) => `Выиграть ${num(n)} sit-n-go` },
  { id: 'rich', icon: '●', title: 'Богач', tiers: [25000, 100000, 500000, 1000000],
    value: (s) => s.peakChips,
    goal: (n) => `Накопить ${num(n)} фишек в банке` },
  { id: 'friends', icon: '☺', title: 'Компанейский', tiers: [1, 5, 15, 50],
    value: (s, u) => (u.friends || []).length,
    goal: (n) => `Завести ${num(n)} ${many(n, 'друга', 'друзей', 'друзей')}` },
];

// Сколько ступеней взято при текущих счётчиках.
function reachedTier(a, user) {
  const v = a.value(user.stats, user);
  let tier = 0;
  while (tier < a.tiers.length && v >= a.tiers[tier]) tier += 1;
  return tier;
}

// Какие ачивки поднялись на новую ступень. Проверяем все разом: их немного,
// а вызывается это не чаще одного раза на раздачу игрока.
function unlockNew(user, now = Date.now()) {
  const fresh = [];
  for (const a of ACHIEVEMENTS) {
    const tier = reachedTier(a, user);
    const had = user.achievements[a.id];
    if (tier <= (had ? had.tier : 0)) continue;
    user.achievements[a.id] = { tier, at: now };
    fresh.push({ a, tier });
  }
  return fresh;
}

// Сумма взятых ступеней — по ней ачивки сравниваются в рейтинге.
function tierTotal(user) {
  let sum = 0;
  for (const rec of Object.values(user.achievements)) sum += rec.tier || 0;
  return sum;
}

// Ачивка для кабинета: ступень, прогресс к следующей и что для неё нужно.
function achievementView(a, user) {
  const rec = user.achievements[a.id];
  const tier = rec ? rec.tier : 0;
  const max = a.tiers.length;
  const next = tier < max ? a.tiers[tier] : null;
  const prev = tier > 0 ? a.tiers[tier - 1] : 0;
  const value = a.value(user.stats, user);
  return {
    id: a.id,
    icon: a.icon,
    title: a.title,
    tier,
    tiers: max,
    tierName: tier ? TIER_NAMES[tier - 1] : null,
    at: rec ? rec.at : 0,
    // Что взято и что дальше — словами.
    done: tier ? a.goal(a.tiers[tier - 1]) : null,
    goal: next !== null ? a.goal(next) : null,
    value: a.progress === false ? null : value,
    next: a.progress === false ? null : next,
    // Доля пути от прошлой ступени до следующей.
    share: next === null ? 1 : a.progress === false ? 0
      : Math.max(0, Math.min(1, (value - prev) / (next - prev))),
  };
}

module.exports = {
  DEFAULT_STATS, ACHIEVEMENTS, TIER_NAMES, freshStats, unlockNew, tierTotal, achievementView, category,
};
