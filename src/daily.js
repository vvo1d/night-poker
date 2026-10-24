'use strict';
// Ежедневное: бонус за вход и три задания на день. Бонус растёт, если
// заходить каждый день подряд; задания меняются в полночь по Москве.
// Всё хранится в статистике игрока (stats.bonus, stats.daily).

const DAY_OFFSET = 3 * 3600 * 1000;    // сутки считаем по Москве
const DAY_MS = 24 * 3600 * 1000;

// Бонус за 1-й, 2-й … 7-й день подряд; дальше — как за седьмой.
const BONUS = [500, 750, 1000, 1500, 2000, 2500, 3000];

// Задания. event — что их двигает (см. progress), goal — сколько нужно.
const QUESTS = [
  { id: 'hands', event: 'hand', goal: 20, reward: 500, title: 'Сыграйте 20 раздач' },
  { id: 'wins', event: 'win', goal: 5, reward: 700, title: 'Выиграйте 5 раздач' },
  { id: 'showdowns', event: 'showdownWin', goal: 3, reward: 600, title: 'Выиграйте 3 вскрытия' },
  { id: 'bigpot', event: 'bigPot', goal: 1, reward: 700, title: 'Заберите банк от 20 больших блайндов' },
  { id: 'allin', event: 'allInWin', goal: 1, reward: 800, title: 'Выиграйте банк в олл-ине' },
  { id: 'combo', event: 'straightPlus', goal: 1, reward: 800, title: 'Соберите на вскрытии стрит или сильнее' },
  { id: 'friend', event: 'friendHand', goal: 10, reward: 1000, title: 'Сыграйте 10 раздач за одним столом с другом' },
  { id: 'sng', event: 'sngPlay', goal: 1, reward: 1000, title: 'Сыграйте сит-н-гоу' },
  { id: 'sngcash', event: 'sngCash', goal: 1, reward: 1500, title: 'Займите призовое место в сит-н-гоу' },
];
const BY_ID = new Map(QUESTS.map((q) => [q.id, q]));
const EASY = ['hands', 'wins'];        // одно лёгкое задание есть всегда

function dayKey(now = Date.now()) {
  return new Date(now + DAY_OFFSET).toISOString().slice(0, 10);
}

// Небольшой детерминированный генератор: у игрока одни и те же задания
// весь день, даже если сервер перезапустился.
function seeded(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function pickQuests(userId, day) {
  const rand = seeded(`${userId}:${day}`);
  const first = EASY[Math.floor(rand() * EASY.length)];
  const rest = QUESTS.map((q) => q.id).filter((id) => !EASY.includes(id));
  const out = [first];
  while (out.length < 3) {
    const id = rest.splice(Math.floor(rand() * rest.length), 1)[0];
    out.push(id);
  }
  return out.map((id) => ({ id, progress: 0, claimed: false }));
}

// Задания на сегодня. В новый день — новые.
function ensure(user, now = Date.now()) {
  const day = dayKey(now);
  const d = user.stats.daily;
  if (!d || d.day !== day) user.stats.daily = { day, quests: pickQuests(user.id, day) };
  return user.stats.daily;
}

// Игровое событие продвигает задания. Возвращает только что выполненные.
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
  if (!def) return { error: 'Такого задания сегодня нет' };
  if (q.claimed) return { error: 'Награда уже получена' };
  if (q.progress < def.goal) return { error: 'Задание ещё не выполнено' };
  q.claimed = true;
  return { ok: true, reward: def.reward };
}

// Бонус: доступен раз в день; пропустил день — серия начинается заново.
function bonusState(user, now = Date.now()) {
  const b = user.stats.bonus || { last: null, streak: 0 };
  const today = dayKey(now);
  const yesterday = dayKey(now - DAY_MS);
  const available = b.last !== today;
  const streak = available ? (b.last === yesterday ? b.streak + 1 : 1) : b.streak;
  return { available, streak, amount: BONUS[Math.min(streak, BONUS.length) - 1], today };
}

function claimBonus(user, now = Date.now()) {
  const st = bonusState(user, now);
  if (!st.available) return { error: 'Бонус за сегодня уже получен — приходите завтра' };
  user.stats.bonus = { last: st.today, streak: st.streak };
  return { ok: true, reward: st.amount, streak: st.streak };
}

// Что видит игрок: бонус, серия по дням и задания с прогрессом.
function view(user, now = Date.now()) {
  const st = bonusState(user, now);
  return {
    bonus: {
      available: st.available,
      streak: st.streak,
      amount: st.amount,
      // Сколько дадут по дням серии — чтобы было видно, ради чего заходить завтра.
      ladder: BONUS,
    },
    quests: ensure(user, now).quests.map((q) => {
      const def = BY_ID.get(q.id);
      return {
        id: q.id, title: def.title, goal: def.goal, reward: def.reward,
        progress: q.progress, done: q.progress >= def.goal, claimed: q.claimed,
      };
    }),
  };
}

module.exports = { QUESTS, BONUS, dayKey, ensure, progress, claimQuest, bonusState, claimBonus, view };
