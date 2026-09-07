'use strict';
const { evaluate, rankOf, holeStrength } = require('./cards');

const BOT_NAMES = [
  'Ада', 'Борис', 'Вера', 'Гоша', 'Дина', 'Ева', 'Жора', 'Зоя',
  'Игнат', 'Клим', 'Лада', 'Марта', 'Ника', 'Осип', 'Пётр', 'Рита',
];

function botThinkingTime() { return 900 + Math.random() * 1800; }

const CATEGORY_STRENGTH = [0.14, 0.34, 0.55, 0.68, 0.76, 0.82, 0.9, 0.96, 0.99];

function postflopStrength(hole, board) {
  const res = evaluate([...hole, ...board]);
  const category = Math.floor(res.value / 16 ** 5);
  let strength = CATEGORY_STRENGTH[category];
  // Если лучшая пятёрка целиком лежит на столе, рука ничего не стоит.
  const usesHole = res.cards.filter((c) => hole.includes(c)).length;
  if (usesHole === 0) strength = Math.min(strength, 0.3);
  else if (usesHole === 1 && category <= 1) strength -= 0.05;
  if (category === 0) {
    const high = Math.max(...hole.map(rankOf));
    strength = 0.06 + (high - 2) / 60;
  }
  return Math.max(0.02, Math.min(0.99, strength));
}

function decideBotAction(table, p) {
  const legal = table.legalActions(p);
  if (!legal) return { action: 'fold' };

  const strength = table.board.length
    ? postflopStrength(p.cards, table.board)
    : holeStrength(p.cards);

  const pot = Math.max(table.bb, legal.pot);
  const toCall = legal.toCall;
  const mood = (Math.random() - 0.5) * 0.16; // немного непредсказуемости
  const s = Math.max(0, Math.min(1, strength + mood));
  const canRaise = legal.minRaiseTo !== undefined;

  const raiseTo = (fraction) => {
    const target = Math.round((p.bet + toCall) + pot * fraction);
    return Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, target));
  };

  if (toCall === 0) {
    // Никто не поставил: бет с сильной рукой или редкий блеф.
    const aggression = s > 0.62 ? 0.7 : s > 0.45 ? 0.3 : 0.1;
    if (canRaise && Math.random() < aggression) {
      return { action: 'raise', amount: raiseTo(s > 0.85 ? 0.75 : 0.5) };
    }
    return { action: 'check' };
  }

  const potOdds = toCall / (pot + toCall);
  const cheap = toCall <= table.bb && p.stack > toCall * 6;

  if (s > 0.8 && canRaise && Math.random() < 0.6) {
    return { action: 'raise', amount: raiseTo(0.8) };
  }
  if (s > 0.62 && canRaise && Math.random() < 0.25) {
    return { action: 'raise', amount: raiseTo(0.6) };
  }
  if (s >= potOdds + 0.06 || (cheap && s > 0.2)) {
    return { action: 'call' };
  }
  if (Math.random() < 0.05 && canRaise && toCall < pot * 0.4) {
    return { action: 'raise', amount: raiseTo(0.7) }; // блеф
  }
  return { action: 'fold' };
}

module.exports = { decideBotAction, botThinkingTime, BOT_NAMES };
