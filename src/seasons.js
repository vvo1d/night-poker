'use strict';
// Сезоны и лиги. Сезон — календарный месяц по Москве. Очки идут за игру,
// а не за фишки в банке: каждый месяц все начинают с нуля, и новичок на
// равных с тем, у кого миллионы. В конце сезона — награда по лиге.
//
// Состояние сезона хранится у игрока в meta.season, прошлые итоги — в meta.seasons.

const { dayKey } = require('./daily');

// С ноября 2026 лиги втрое дороже: «Бриллиант» — для тех, кто играет почти каждый день
// и берёт турниры. Октябрьский сезон доигрывается по прежним порогам.
const LEAGUES = [
  { id: 'bronze', name: 'Бронза', min: 0, reward: 0 },
  { id: 'silver', name: 'Серебро', min: 300, reward: 2000 },
  { id: 'gold', name: 'Золото', min: 900, reward: 5000 },
  { id: 'platinum', name: 'Платина', min: 2000, reward: 12000 },
  { id: 'diamond', name: 'Бриллиант', min: 4000, reward: 30000 },
];
const OLD_LEAGUES = [
  { id: 'bronze', name: 'Бронза', min: 0, reward: 0 },
  { id: 'silver', name: 'Серебро', min: 100, reward: 2000 },
  { id: 'gold', name: 'Золото', min: 300, reward: 5000 },
  { id: 'platinum', name: 'Платина', min: 700, reward: 10000 },
  { id: 'diamond', name: 'Бриллиант', min: 1500, reward: 25000 },
];
const NEW_LEAGUES_FROM = '2026-11';
const leaguesFor = (key) => (key < NEW_LEAGUES_FROM ? OLD_LEAGUES : LEAGUES);

// За что дают очки.
const POINTS = {
  hand: 1,             // сыгранная раздача
  winVsHuman: 2,       // выигранный банк, где был соперник-человек
  quest: 5,            // забранное задание дня
};
const HAND_CAP = 100;  // очков за раздачи в день: игра сутками без перерыва не делает чемпионом
const SNG_PLACES = [40, 25, 15];   // sit-n-go: 1-е, 2-е, 3-е место

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август',
  'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

function seasonKey(now = Date.now()) { return dayKey(now).slice(0, 7); }

function seasonName(key) {
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS[m - 1][0].toUpperCase()}${MONTHS[m - 1].slice(1)} ${y}`;
}

// Конец сезона — полночь по Москве первого числа следующего месяца.
function seasonEnds(key) {
  const [y, m] = key.split('-').map(Number);
  return Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) - 3 * 3600 * 1000;
}

function leagueOf(points, key = seasonKey()) {
  const list = leaguesFor(key);
  let league = list[0];
  for (const l of list) if (points >= l.min) league = l;
  return league;
}

// Сезон игрока на сегодня. Если он из прошлого месяца — подводим итог
// и возвращаем его, чтобы вызвавший выдал награду.
function ensure(user, now = Date.now()) {
  const key = seasonKey(now);
  const cur = user.meta.season;
  let finished = null;
  if (cur && cur.key !== key) {
    finished = finish(user, cur);
  }
  if (!cur || cur.key !== key) user.meta.season = { key, points: 0, day: null, dayHand: 0 };
  return finished;
}

function finish(user, season) {
  if (!season.points) return null;
  const league = leagueOf(season.points, season.key);
  const result = { key: season.key, name: seasonName(season.key), points: season.points, league: league.id, reward: league.reward };
  user.meta.seasons = [...(user.meta.seasons || []), result].slice(-24);
  return result;
}

// Начислить очки. kind 'hand' и 'winVsHuman' упираются в дневной потолок.
function add(user, kind, amount = POINTS[kind] || 0, now = Date.now()) {
  const finished = ensure(user, now);
  const s = user.meta.season;
  if (kind === 'hand' || kind === 'winVsHuman') {
    const day = dayKey(now);
    if (s.day !== day) { s.day = day; s.dayHand = 0; }
    amount = Math.max(0, Math.min(amount, HAND_CAP - s.dayHand));
    s.dayHand += amount;
  }
  s.points += amount;
  return finished;
}

// Очки за место в sit-n-go: полные — если соперники люди, меньше — если боты.
function sngPoints(place, humans, seats) {
  const base = SNG_PLACES[place - 1] || 0;
  if (!base || humans < 2) return 0;
  return Math.round(base * (humans / seats));
}

function view(user, now = Date.now()) {
  const key = seasonKey(now);
  const s = user.meta.season && user.meta.season.key === key ? user.meta.season : { points: 0 };
  const list = leaguesFor(key);
  const league = leagueOf(s.points, key);
  const next = list[list.indexOf(league) + 1] || null;
  return {
    key,
    name: seasonName(key),
    endsAt: seasonEnds(key),
    points: s.points,
    league: { id: league.id, name: league.name, reward: league.reward, min: league.min },
    next: next ? { id: next.id, name: next.name, min: next.min, reward: next.reward } : null,
    history: (user.meta.seasons || []).slice(-6).reverse(),
  };
}

module.exports = { LEAGUES, leaguesFor, POINTS, HAND_CAP, seasonKey, seasonName, seasonEnds, leagueOf, ensure, add, sngPoints, view };
