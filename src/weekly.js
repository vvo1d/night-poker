'use strict';
// Задания недели: четыре задания на неделю и сундук за все четыре.
// Неделя — с понедельника по Москве. Двигаются теми же событиями, что
// и задания дня (см. daily.progress), плюс «выполнено задание дня».
// Хранится в статистике игрока (stats.weekly).

const { dayKey } = require('./daily');

const DAY_MS = 24 * 3600 * 1000;
const DAY_OFFSET = 3 * 3600 * 1000;

const QUESTS = [
  { id: 'hands', event: 'hand', goal: 150, reward: 2000, title: 'Сыграйте 150 раздач' },
  { id: 'wins', event: 'win', goal: 30, reward: 2000, title: 'Выиграйте 30 раздач' },
  { id: 'daily', event: 'dailyDone', goal: 7, reward: 3000, title: 'Выполните 7 заданий дня' },
  { id: 'tours', event: 'sngPlay', goal: 5, reward: 2500, title: 'Сыграйте 5 турниров' },
  { id: 'showdowns', event: 'showdownWin', goal: 15, reward: 2000, title: 'Выиграйте 15 вскрытий' },
  { id: 'bigpots', event: 'bigPot', goal: 5, reward: 2500, title: 'Заберите 5 банков от 20 больших блайндов' },
  { id: 'cash', event: 'sngCash', goal: 2, reward: 3000, title: 'Дважды займите призовое место в турнире' },
];
const BY_ID = new Map(QUESTS.map((q) => [q.id, q]));
const CHEST = 5000;      // сундук за все четыре задания недели

// Понедельник текущей недели по Москве — ключ недели.
function weekKey(now = Date.now()) {
  const d = new Date(now + DAY_OFFSET);
  const back = (d.getUTCDay() + 6) % 7;     // сколько дней назад был понедельник
  return dayKey(now - back * DAY_MS);
}

function weekEnds(key) {
  return Date.parse(`${key}T00:00:00Z`) - DAY_OFFSET + 7 * DAY_MS;
}

// Детерминированный выбор: одни и те же задания всю неделю, даже после перезапуска.
function seeded(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

// «Задания дня» есть всегда — неделя держится на ежедневных заходах;
// одно из лёгких (раздачи или выигрыши) и два из остальных.
function pickQuests(userId, week) {
  const rand = seeded(`${userId}:week:${week}`);
  const easy = ['hands', 'wins'][Math.floor(rand() * 2)];
  const rest = QUESTS.map((q) => q.id).filter((id) => !['hands', 'wins', 'daily'].includes(id));
  const out = ['daily', easy];
  while (out.length < 4) out.push(rest.splice(Math.floor(rand() * rest.length), 1)[0]);
  return out.map((id) => ({ id, progress: 0, claimed: false }));
}

function ensure(user, now = Date.now()) {
  const week = weekKey(now);
  const w = user.stats.weekly;
  if (!w || w.week !== week) user.stats.weekly = { week, quests: pickQuests(user.id, week), chest: false };
  return user.stats.weekly;
}

// Событие продвигает задания недели. Возвращает только что выполненные.
function progress(user, event, amount = 1, now = Date.now()) {
  const done = [];
  for (const q of ensure(user, now).quests) {
    const def = BY_ID.get(q.id);
    if (!def || def.event !== event || q.progress >= def.goal) continue;
    q.progress = Math.min(def.goal, q.progress + amount);
    if (q.progress >= def.goal) done.push(def);
  }
  return done;
}

function claimQuest(user, id, now = Date.now()) {
  const q = ensure(user, now).quests.find((x) => x.id === id);
  const def = q && BY_ID.get(q.id);
  if (!def) return { error: 'Такого задания на этой неделе нет' };
  if (q.claimed) return { error: 'Награда уже получена' };
  if (q.progress < def.goal) return { error: 'Задание ещё не выполнено' };
  q.claimed = true;
  return { ok: true, reward: def.reward };
}

// Сундук открывается, когда забраны награды за все задания недели.
function claimChest(user, now = Date.now()) {
  const w = ensure(user, now);
  if (w.chest) return { error: 'Сундук этой недели уже открыт' };
  if (!w.quests.every((q) => q.claimed)) return { error: 'Сначала выполните и заберите все задания недели' };
  w.chest = true;
  return { ok: true, reward: CHEST };
}

function view(user, now = Date.now()) {
  const w = ensure(user, now);
  return {
    week: w.week,
    endsAt: weekEnds(w.week),
    quests: w.quests.map((q) => {
      const def = BY_ID.get(q.id);
      return {
        id: q.id, title: def.title, goal: def.goal, reward: def.reward,
        progress: q.progress, done: q.progress >= def.goal, claimed: q.claimed,
      };
    }),
    chest: { reward: CHEST, ready: w.quests.every((q) => q.claimed), claimed: w.chest },
  };
}

module.exports = { QUESTS, CHEST, weekKey, weekEnds, ensure, progress, claimQuest, claimChest, view };
