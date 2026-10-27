'use strict';
// Уровень игрока: опыт копится за игру и не сгорает (в отличие от очков сезона).
// За каждый новый уровень — фишки, на некоторых — предмет из магазина в подарок.

// Сколько опыта дают события.
const XP = {
  hand: 1,          // сыграна раздача
  win: 2,           // выигран банк
  bonus: 5,         // забран бонус за вход
  daily: 15,        // забрана награда за задание дня
  weekly: 40,       // за задание недели
  chest: 150,       // открыт сундук недели
  tour: 10,         // сыгран турнир (sit-n-go, спин, по расписанию)
  tourCash: 20,     // призовое место в турнире
  friend: 50,       // приглашённый друг сыграл первые раздачи
};

// Опыт до следующего уровня растёт всё быстрее: 2-й уровень — за 80 (~50 раздач),
// 10-й в сумме — примерно за 3 700 опыта, 20-й — примерно за 20 000.
function need(level) { const k = level - 1; return 80 + 60 * k + 4 * k * k; }

// Прежняя кривая (до октября 2026): 40, 60, 80… — нужна, чтобы перевести опыт
// старых игроков на новую так, чтобы уровень и доля пути до следующего сохранились.
const CURVE = 2;
function oldNeed(level) { return 40 + 20 * (level - 1); }
function convertXp(xp) {
  let level = 1;
  let left = xp;
  while (left >= oldNeed(level)) { left -= oldNeed(level); level += 1; }
  let total = 0;
  for (let l = 1; l < level; l++) total += need(l);
  return total + Math.floor((left / oldNeed(level)) * need(level));
}

function levelOf(xp) {
  let level = 1;
  let left = xp;
  while (left >= need(level)) { left -= need(level); level += 1; }
  return { level, into: left, need: need(level) };
}

// Подарки из магазина на особых уровнях.
const ITEMS = {
  3: 'back-crimson',
  5: 'felt-blue',
  8: 'frame-silver',
  12: 'back-gold',
  15: 'felt-violet',
  20: 'frame-gold',
  30: 'frame-neon',
};

function reward(level) {
  return { chips: 300 * level, item: ITEMS[level] || null };
}

module.exports = { XP, need, levelOf, reward, ITEMS, CURVE, convertXp };
