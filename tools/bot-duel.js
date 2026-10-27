'use strict';
// Боты разных уровней играют друг против друга — проверяем, что «сильный»
// правда сильнее. Результат — выигрыш в больших блайндах на 100 раздач.
//
//   node tools/bot-duel.js 20000        # раздач (по умолчанию 10000)
const { Table } = require('../src/table');
const { STYLES } = require('../src/bot');

const HANDS = Number(process.argv[2]) || 10000;
// Состав: по умолчанию все уровни; можно задать списком: node tools/bot-duel.js 5000 regular,pro
const LINEUP = process.argv[3] ? process.argv[3].split(',') : Object.keys(STYLES);
const BB = 10;
const STACK = 100 * BB;

const table = new Table({ id: 'duel', name: 'Дуэль', maxSeats: LINEUP.length, sb: BB / 2, bb: BB, minBuyIn: 20 * BB, maxBuyIn: 200 * BB, timeout: 1 });
LINEUP.forEach((style, i) => {
  table.sit({ id: `bot-${style}`, name: `Бот-${style}`, isBot: true }, i, STACK);
  table.seats[i].botStyle = style;
});

const net = Object.fromEntries(LINEUP.map((s) => [s, 0]));
let now = Date.now();
let hands = 0;
let last = 0;
const started = Date.now();
while (hands < HANDS) {
  now += 2000;
  table.tick(now);
  if (table.handId !== last) { last = table.handId; hands++; }
  // Между раздачами: стек каждого возвращаем к 100 bb, разницу записываем в итог.
  if (table.phase === 'idle') {
    for (const p of table.players()) {
      net[p.botStyle] += p.stack - STACK;
      p.stack = STACK;
      p.sittingOut = false;
      p.busted = false;
    }
    table.maybeStartHand();
  }
}
console.log(`Раздач: ${hands}, за ${((Date.now() - started) / 1000).toFixed(1)} с`);
for (const s of LINEUP) {
  const bb100 = (net[s] / BB) / (hands / 100);
  console.log(`${STYLES[s].label.padEnd(9)} ${bb100 >= 0 ? '+' : ''}${bb100.toFixed(1)} bb/100`);
}
