'use strict';
// Турнир по расписанию с резидентами. Запуск: node --test tools/test-mtt.js
//
// Резиденты платят взнос, получают призы и места как люди; боты с пометкой — нет.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Table } = require('../src/table');
const { Mtt } = require('../src/mtt');

function makeMtt(buyIn = 100) {
  const paid = [];
  const refunded = [];
  const recorded = [];
  const tables = [];
  const mtt = new Mtt({ id: 'm', name: 'Тест', startAt: Date.now(), buyIn }, {
    createTable: (cfg, tour) => {
      const t = new Table({ id: `t${tables.length}`, ...cfg, tour }, {});
      tables.push(t);
      return t;
    },
    dropTable: () => {},
    pay: (e, a) => paid.push([e.userId, a]),
    refund: (e, a) => refunded.push([e.userId, a]),
    record: (e, info) => recorded.push([e.userId, info]),
    notify: () => {},
    isOnline: () => false,
  });
  return { mtt, paid, refunded, recorded, tables };
}

const resident = (n) => ({ userId: `r${n}`, name: `Резидент ${n}`, isBot: true, resident: true, botStyle: 'regular' });

test('резиденты: снятие с регистрации и отмена возвращают взнос', () => {
  const { mtt, refunded } = makeMtt();
  for (let i = 0; i < 3; i++) mtt.register(resident(i), 1000);
  mtt.addBots(1);
  mtt.unregister('r0');
  mtt.cancel();
  assert.deepEqual(refunded.map(([id]) => id).sort(), ['r0', 'r1', 'r2']);
});

test('резиденты садятся как резиденты, не «отходят» и получают места и призы', () => {
  const { mtt, paid, recorded, tables } = makeMtt();
  for (let i = 0; i < 4; i++) mtt.register(resident(i), 1000);
  mtt.addBots(2);
  mtt.start();
  const seated = tables.flatMap((t) => t.players());
  const res = seated.filter((p) => p.resident);
  assert.equal(res.length, 4);
  assert.ok(res.every((p) => p.isBot && p.botStyle === 'regular' && !p.sittingOut));
  assert.equal(recorded.filter(([, i]) => i.start).length, 4, 'старт записан только резидентам');
  // Вылет резидента: место с его аккаунтом, без пометки «бот», приз — в банк.
  const table = tables[0];
  const r = table.players().find((p) => p.resident);
  r.handStartStack = 0;
  mtt.bust(table, [r]);
  const place = mtt.places.find((p) => p.name === r.name);
  assert.equal(place.userId, r.userId);
  assert.equal(place.isBot, false);
  assert.ok(recorded.some(([id, i]) => id === r.userId && i.place === place.place));
  if (place.prize) assert.ok(paid.some(([id, a]) => id === r.userId && a === place.prize));
  // Бот с пометкой — место без аккаунта.
  const bot = tables.flatMap((t) => t.players()).find((p) => p.isBot && !p.resident);
  mtt.bust(tables.find((t) => t.byUser(bot.userId)), [bot]);
  assert.equal(mtt.places.find((p) => p.name === bot.name).userId, null);
});
