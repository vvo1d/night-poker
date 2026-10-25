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

// Опыт до следующего уровня растёт плавно: 2-й уровень — за 40, дальше на 20 больше каждый раз.
function need(level) { return 40 + 20 * (level - 1); }

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

module.exports = { XP, need, levelOf, reward, ITEMS };
