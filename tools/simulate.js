'use strict';
// Прогон движка на ботах: проверяем сохранение фишек, отсутствие зависаний и ошибок.
const { Table } = require('../src/table');

const HANDS = Number(process.argv[2]) || 500;
const SEATS = Number(process.argv[3]) || 6;

const table = new Table({
  id: 'sim', name: 'Симуляция', maxSeats: SEATS, sb: 5, bb: 10,
  minBuyIn: 200, maxBuyIn: 2000, timeout: 1,
});

for (let i = 0; i < SEATS; i++) {
  table.sit({ id: `bot-${i}`, name: `Бот-${i}`, isBot: true }, i, 1000);
}

const totalChips = () => table.players().reduce((s, p) => s + p.stack, 0) + table.potTotal();
let expected = totalChips();

let now = Date.now();
let hands = 0;
let lastHand = 0;
let guard = 0;

while (hands < HANDS && guard < 4_000_000) {
  guard++;
  now += 50;
  table.tick(now);

  if (table.handId !== lastHand) { lastHand = table.handId; hands++; }

  const sum = totalChips();
  if (sum !== expected) {
    console.error(`Фишки не сходятся на раздаче #${table.handId}: ${sum} вместо ${expected}`);
    process.exit(1);
  }
  for (const p of table.players()) {
    if (p.stack < 0) { console.error('Отрицательный стек', p.name); process.exit(1); }
    if (p.bet < 0 || p.contributed < 0) { console.error('Отрицательная ставка', p.name); process.exit(1); }
  }
  // Ботов пополняем, чтобы стол не остановился.
  if (table.phase === 'idle') {
    for (const p of table.players()) {
      if (p.stack < table.bb * 2) { p.stack = 1000; p.sittingOut = false; }
    }
    expected = totalChips();
    table.maybeStartHand();
  }
}

console.log(`Сыграно раздач: ${hands}, тиков: ${guard}`);
console.log('Стеки:', table.players().map((p) => `${p.name}=${p.stack}`).join(' '));
console.log(table.log.slice(-8).map((l) => l.text).join('\n'));
if (hands < HANDS) { console.error('Стол завис: раздачи перестали начинаться'); process.exit(1); }
console.log('Проверки пройдены.');
