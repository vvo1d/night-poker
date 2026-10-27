'use strict';
// Выход из-за стола — для всех видов столов. Запуск: node --test tools/test-leave.js
//
// Проверяем главное: уход срабатывает сразу (игрок свободен и видит стол как
// зритель), фишки не теряются и не удваиваются, раздача доигрывается без него.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Table } = require('../src/table');
const { Tournament } = require('../src/tournament');

// Стол с «банком» игроков: всё, что стол возвращает, копится в bank.
function makeTable(cfg = {}, tour = null) {
  const bank = new Map();
  const unseated = [];
  const table = new Table({
    id: 't', name: 'Тест', maxSeats: 6, sb: 5, bb: 10, minBuyIn: 200, maxBuyIn: 1000, timeout: 25, tour, ...cfg,
  }, {
    onChipsReturn: (p, chips) => {
      if (p.isBot) return;
      if (tour) { if (tour.status === 'registering') bank.set(p.userId, (bank.get(p.userId) || 0) + tour.buyIn); return; }
      if (chips > 0) bank.set(p.userId, (bank.get(p.userId) || 0) + chips);
    },
    onUnseat: (p) => unseated.push(p.userId),
  });
  return { table, bank, unseated };
}

let clock = Date.now();
const tick = (table, ms = 400) => { clock += ms; table.tick(clock); };
// Крутим стол, пока не выполнится условие (или не кончится терпение).
function until(table, cond, steps = 2000) {
  for (let i = 0; i < steps && !cond(); i++) tick(table);
  return cond();
}
const onTable = (table) => table.players().reduce((sum, p) => sum + p.stack + (p.topUp || 0) + (p.contributed || 0), 0);
const startHand = (table) => { table.nextStepAt = 1; tick(table, 10); };

test('кэш, между раздачами: уход сразу, стек — в банк', () => {
  const { table, bank } = makeTable();
  table.sit({ id: 'h', name: 'Человек' }, 0, 500);
  const res = table.leave('h');
  assert.equal(res.ok, true);
  assert.equal(res.pending, undefined);
  assert.equal(table.byUser('h'), null);
  assert.equal(table.seats[0], null);
  assert.equal(bank.get('h'), 500);
});

test('кэш, посреди раздачи не в свой ход: сразу зритель, стек — в банк, вложенное остаётся в банке раздачи', () => {
  const { table, bank, unseated } = makeTable();
  table.sit({ id: 'h', name: 'Человек' }, 0, 500);
  table.sit({ id: 'a', name: 'Ада', isBot: true }, 1, 500);
  table.sit({ id: 'b', name: 'Борис', isBot: true }, 2, 500);
  startHand(table);
  assert.ok(table.phase === 'preflop');
  // Ждём, пока ходит не человек.
  assert.ok(until(table, () => table.actingSeat >= 0 && table.actingSeat !== 0 && table.phase !== 'idle', 50) || table.phase !== 'idle');
  const me = table.byUser('h');
  const before = onTable(table);
  const stack = me.stack;
  const res = table.leave('h');
  assert.equal(res.ok, true);
  assert.equal(table.byUser('h'), null, 'игрок сразу свободен');
  assert.ok(unseated.includes('h'), 'стол сообщил, что место освобождено');
  assert.equal(bank.get('h'), stack, 'стек вернулся сразу');
  assert.equal(onTable(table) + stack, before, 'фишки не пропали и не задвоились');
  // Раздача доигрывается, стул освобождается.
  assert.ok(until(table, () => table.seats[0] === null));
  assert.equal(bank.get('h'), stack, 'второй раз фишки не возвращаются');
});

test('кэш, в свой ход: уход = фолд, игра идёт дальше', () => {
  const { table, bank } = makeTable();
  table.sit({ id: 'h', name: 'Человек' }, 0, 500);
  table.sit({ id: 'a', name: 'Ада', isBot: true }, 1, 500);
  table.sit({ id: 'b', name: 'Борис', isBot: true }, 2, 500);
  startHand(table);
  assert.ok(until(table, () => table.actingSeat === 0, 200), 'дождались хода человека');
  const stack = table.byUser('h').stack;
  const res = table.leave('h');
  assert.equal(res.ok, true);
  assert.equal(table.byUser('h'), null);
  assert.equal(bank.get('h'), stack);
  assert.notEqual(table.actingSeat, 0, 'ход ушёл дальше');
});

test('кэш, ушёл и сразу сел обратно на другое место — новая посадка не ломается', () => {
  const { table, bank } = makeTable();
  table.sit({ id: 'h', name: 'Человек' }, 0, 500);
  table.sit({ id: 'a', name: 'Ада', isBot: true }, 1, 500);
  table.sit({ id: 'b', name: 'Борис', isBot: true }, 2, 500);
  startHand(table);
  table.leave('h');
  const back = table.sit({ id: 'h', name: 'Человек' }, 4, 300);
  assert.equal(back.ok, true);
  assert.ok(until(table, () => table.seats[0] === null), 'старый стул освободился');
  assert.equal(table.byUser('h').seat, 4, 'новая посадка жива');
  assert.ok(bank.get('h') > 0);
});

test('кэш, двое ушли в одной раздаче — оставшийся забирает банк, фишки сходятся', () => {
  const { table, bank } = makeTable();
  table.sit({ id: 'h', name: 'Человек' }, 0, 500);
  table.sit({ id: 'g', name: 'Гость' }, 1, 500);
  table.sit({ id: 'a', name: 'Ада', isBot: true }, 2, 500);
  const total = onTable(table);
  startHand(table);
  table.leave('h');
  table.leave('g');
  assert.ok(until(table, () => table.phase === 'idle' && table.occupied() === 1));
  const left = (bank.get('h') || 0) + (bank.get('g') || 0) + table.seats[2].stack;
  assert.equal(left, total, 'все 1500 фишек на месте');
});

test('кэш, уход на вскрытии: сразу зритель, выигрыш возвращается после расчёта', () => {
  const { table, bank } = makeTable();
  table.sit({ id: 'h', name: 'Человек' }, 0, 500);
  table.sit({ id: 'a', name: 'Ада', isBot: true }, 1, 500);
  const total = onTable(table);
  startHand(table);
  // Человек чекает/коллирует до вскрытия.
  assert.ok(until(table, () => {
    if (table.phase === 'showdown') return true;
    const me = table.byUser('h');
    if (me && table.actingSeat === 0) {
      const l = table.legalActions(me);
      table.act('h', l.check ? 'check' : 'call');
    }
    return false;
  }, 400));
  if (table.byUser('h')) {
    const res = table.leave('h');
    assert.equal(res.ok, true);
    assert.equal(table.byUser('h'), null);
  }
  assert.ok(until(table, () => table.seats[0] === null));
  assert.equal((bank.get('h') || 0) + table.seats[1].stack, total);
});

test('sit-n-go, регистрация: уход сразу, взнос возвращается', () => {
  const tour = new Tournament(6, {}, 500);
  const { table, bank } = makeTable({ sb: 0, bb: 0, minBuyIn: 1000, maxBuyIn: 1000 }, tour);
  table.sit({ id: 'h', name: 'Человек' }, 0, 1000);
  const res = table.leave('h');
  assert.equal(res.ok, true);
  assert.equal(table.byUser('h'), null);
  assert.equal(bank.get('h'), 500);
});

test('sit-n-go, идёт: «Встать» не выпускает (место хранится), «Покинуть турнир» — сразу с местом', () => {
  const paid = [];
  const tour = new Tournament(3, { pay: (p, a) => paid.push([p.name, a]) }, 100, { spin: true });
  const { table } = makeTable({ maxSeats: 3, sb: 0, bb: 0, minBuyIn: 500, maxBuyIn: 500, timeout: 15 }, tour);
  table.sit({ id: 'h', name: 'Человек' }, 0, 500);
  table.sit({ id: 'a', name: 'Ада', isBot: true }, 1, 500);
  table.sit({ id: 'b', name: 'Борис', isBot: true }, 2, 500);
  startHand(table);
  assert.equal(tour.status, 'running');
  const stand = table.leave('h');
  assert.ok(stand.error, 'из идущего турнира просто так не встают');
  const quit = table.forfeit('h');
  assert.equal(quit.ok, true);
  assert.ok(tour.places.some((p) => p.name === 'Человек' && p.place === 3), 'сразу получил 3 место');
  assert.ok(until(table, () => tour.status === 'finished', 4000), 'турнир доигрался без него');
});

test('sit-n-go, один на один: сдался — соперник сразу победил', () => {
  const tour = new Tournament(3, {}, 100, { spin: true });
  const { table } = makeTable({ maxSeats: 3, sb: 0, bb: 0, minBuyIn: 500, maxBuyIn: 500, timeout: 15 }, tour);
  table.sit({ id: 'h', name: 'Человек' }, 0, 500);
  table.sit({ id: 'a', name: 'Ада', isBot: true }, 1, 500);
  table.sit({ id: 'b', name: 'Борис', isBot: true }, 2, 500);
  startHand(table);
  table.forfeit('b');
  assert.ok(until(table, () => table.phase === 'idle' && table.occupied() === 2));
  startHand(table);
  table.forfeit('h');
  assert.ok(until(table, () => tour.status === 'finished'));
  assert.equal(tour.places.find((p) => p.place === 1).name, 'Ада');
});
