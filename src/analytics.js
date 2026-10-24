'use strict';
// Собственная аналитика: всё считается по игрокам в памяти, отдельной базы
// событий нет. У игрока есть дата регистрации, дни, когда он заходил,
// момент первой посадки за стол и источник прихода — этого хватает на
// регистрации, воронку, удержание и источники.

const { dayKey } = require('./daily');

const DAY_MS = 24 * 3600 * 1000;

function shiftDay(day, delta) {
  const t = Date.parse(`${day}T12:00:00Z`) + delta * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

function report(allUsers, { now = Date.now(), days = 30, online = 0, handsByDay = new Map() } = {}) {
  const users = [...allUsers];   // может прийти перебор Map — по нему проходим не один раз
  const today = dayKey(now);
  const range = [];
  for (let i = days - 1; i >= 0; i--) range.push(shiftDay(today, -i));
  const inRange = new Set(range);

  const regs = new Map(range.map((d) => [d, 0]));
  const active = new Map(range.map((d) => [d, 0]));
  const firstSits = new Map(range.map((d) => [d, 0]));
  const cohorts = new Map();      // день регистрации -> { n, d1, d7 }
  const sources = new Map();      // источник -> { n, sat, d1 }
  const funnel = { registered: 0, sat: 0, played10: 0, returnedD1: 0 };
  let total = 0;

  for (const u of users) {
    total += 1;
    const meta = u.meta || {};
    const daysSet = new Set(meta.days || []);
    for (const d of daysSet) if (active.has(d)) active.set(d, active.get(d) + 1);

    const reg = dayKey(u.createdAt);
    const satDay = meta.firstSitAt ? dayKey(meta.firstSitAt) : null;
    if (satDay && firstSits.has(satDay)) firstSits.set(satDay, firstSits.get(satDay) + 1);
    if (!inRange.has(reg)) continue;

    regs.set(reg, regs.get(reg) + 1);
    const sat = !!meta.firstSitAt || u.handsPlayed > 0;
    const d1 = daysSet.has(shiftDay(reg, 1));
    const d7 = daysSet.has(shiftDay(reg, 7));

    funnel.registered += 1;
    if (sat) funnel.sat += 1;
    if (u.handsPlayed >= 10) funnel.played10 += 1;
    // Удержание считаем только по тем, у кого «завтра» уже наступило.
    if (shiftDay(reg, 1) < today && d1) funnel.returnedD1 += 1;

    const c = cohorts.get(reg) || { n: 0, d1: 0, d7: 0 };
    c.n += 1;
    if (d1) c.d1 += 1;
    if (d7) c.d7 += 1;
    cohorts.set(reg, c);

    const src = meta.source || 'прямой заход';
    const s = sources.get(src) || { n: 0, sat: 0, d1: 0, eligible: 0 };
    s.n += 1;
    if (sat) s.sat += 1;
    // «Вернулся назавтра» считаем только у тех, для кого завтра уже наступило.
    if (shiftDay(reg, 1) < today) { s.eligible += 1; if (d1) s.d1 += 1; }
    sources.set(src, s);
  }

  const eligibleD1 = range.filter((d) => shiftDay(d, 1) < today)
    .reduce((sum, d) => sum + (cohorts.get(d)?.n || 0), 0);

  return {
    generatedAt: now,
    today,
    totals: {
      users: total,
      online,
      registeredToday: regs.get(today) || 0,
      registered7: range.slice(-7).reduce((s, d) => s + regs.get(d), 0),
      registered30: funnel.registered,
      activeToday: active.get(today) || 0,
      active7: users.filter((u) => (u.meta?.days || []).some((d) => d >= shiftDay(today, -6))).length,
      handsToday: handsByDay.get(today) || 0,
    },
    series: range.map((d) => ({
      day: d,
      registered: regs.get(d),
      active: active.get(d),
      firstSits: firstSits.get(d),
      hands: handsByDay.get(d) || 0,
    })),
    funnel: {
      ...funnel,
      satPct: pct(funnel.sat, funnel.registered),
      played10Pct: pct(funnel.played10, funnel.registered),
      returnedD1Pct: pct(funnel.returnedD1, eligibleD1),
    },
    // Когорты последних двух недель: из пришедших в этот день — сколько вернулись.
    cohorts: range.slice(-14).map((d) => {
      const c = cohorts.get(d) || { n: 0, d1: 0, d7: 0 };
      return {
        day: d,
        n: c.n,
        d1: shiftDay(d, 1) < today ? pct(c.d1, c.n) : null,
        d7: shiftDay(d, 7) < today ? pct(c.d7, c.n) : null,
      };
    }),
    sources: [...sources.entries()]
      .map(([source, s]) => ({ source, n: s.n, satPct: pct(s.sat, s.n), d1Pct: pct(s.d1, s.eligible) }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 15),
  };
}

module.exports = { report, shiftDay };
