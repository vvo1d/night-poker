'use strict';
// Пароли считаются на пуле потоков libuv: четырёх потоков по умолчанию мало,
// когда в час пик заходят тысячи игроков.
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '16';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { Store, REF_HANDS } = require('./src/store');
const { CATALOG: SHOP_CATALOG } = require('./src/shop');
const { Table, setEvalBudget, REACTIONS, PHRASES, SIT_OUT_MS } = require('./src/table');
const { CHARACTERS: BOT_CHARACTERS, RESIDENTS: RESIDENT_LIST, BOT_DISCLAIMER } = require('./src/bot');
const { Tournament, SNG_STACK, SNG_TIMEOUT, SNG_BUY_INS, SPIN_STACK, SPIN_TIMEOUT } = require('./src/tournament');
const { ACHIEVEMENTS, achievementView, tierTotal } = require('./src/achievements');
const { Snapshot, mttRefunds, tableRecord, refunds } = require('./src/snapshot');
const telegram = require('./src/telegram');
const { LoginGuard, waitText } = require('./src/limits');
const analytics = require('./src/analytics');
const { dayKey } = require('./src/daily');
const seasons = require('./src/seasons');
const { createAdmin } = require('./src/admin');
const pages = require('./src/pages');
const { MttManager } = require('./src/mtt');
const { createResidentsConfig } = require('./src/residents-config');
const { createVk } = require('./src/vk');

const PORT = Number(process.env.PORT) || 3000;
// За обратным прокси сервер стоит слушать только петлю, чтобы снаружи
// нельзя было постучаться мимо прокси.
const HOST = process.env.HOST || '0.0.0.0';
// По HTTPS cookie должна помечаться Secure, по HTTP — нет, иначе браузер её не сохранит.
const SECURE_COOKIE = process.env.COOKIE_SECURE === '1';
const PUBLIC_DIR = path.join(__dirname, 'public');
// Telegram включается токеном бота; адрес сайта нужен для кнопок «Играть» в боте.
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
// Вход через Telegram скрыт, пока Telegram недоступен в РФ: включается TELEGRAM_LOGIN=on.
const TG_LOGIN = process.env.TELEGRAM_LOGIN === 'on';
// Вход через VK ID: ID приложения из кабинета id.vk.com. Адрес возврата должен
// совпадать с указанным в настройках приложения (по умолчанию — APP_URL/auth/vk/callback).
const APP_URL = process.env.APP_URL || 'https://thpoker.ru';
// Режим вебхука: Telegram сам приносит сообщения на /api/telegram/webhook.
// Нужен, если хостинг не выпускает сервер к api.telegram.org.
const TG_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
// Номер счётчика Яндекс Метрики: если задан, счётчик встаёт на все страницы сайта.
// По умолчанию — счётчик сайта; YANDEX_METRIKA_ID=off выключает его (например, на своей машине).
const METRIKA_ID = (() => {
  const v = process.env.YANDEX_METRIKA_ID;
  if (v === 'off') return '';
  return /^\d+$/.test(v || '') ? v : '113767079';
})();

// Столы заведения: стоят всегда, даже пустые, — чтобы было куда сесть сразу.
const ROOM_CONFIGS = [
  { id: 'novice', name: 'Новичок', maxSeats: 9, sb: 1, bb: 2, minBuyIn: 40, maxBuyIn: 200, timeout: 25 },
  { id: 'quiet', name: 'Тихий стол', maxSeats: 4, sb: 2, bb: 5, minBuyIn: 100, maxBuyIn: 500, timeout: 40 },
  { id: 'six', name: 'Шестёрка', maxSeats: 6, sb: 5, bb: 10, minBuyIn: 200, maxBuyIn: 1000, timeout: 25 },
  { id: 'heads', name: 'Хедз-ап', maxSeats: 2, sb: 10, bb: 20, minBuyIn: 400, maxBuyIn: 2000, timeout: 20 },
  { id: 'turbo', name: 'Турбо', maxSeats: 9, sb: 25, bb: 50, minBuyIn: 1000, maxBuyIn: 5000, timeout: 12 },
  { id: 'high', name: 'Высокие ставки', maxSeats: 6, sb: 50, bb: 100, minBuyIn: 2000, maxBuyIn: 10000, timeout: 25 },
  // Омаха пот-лимит: четыре карты на руках.
  { id: 'omaha', name: 'Омаха', maxSeats: 6, sb: 5, bb: 10, minBuyIn: 200, maxBuyIn: 1000, timeout: 30, game: 'omaha' },
  { id: 'omaha-high', name: 'Омаха 25/50', maxSeats: 6, sb: 25, bb: 50, minBuyIn: 1000, maxBuyIn: 5000, timeout: 30, game: 'omaha' },
];

// Из чего игрок собирает свой стол. Закупка — от 20 до 100 больших блайндов.
const STAKES = [[1, 2], [2, 5], [5, 10], [10, 20], [25, 50], [50, 100], [100, 200]];   // подсказки в форме
// Круглые ряды значений: «67», «666» или «120» не годятся — только привычные ступени.
// Большой блайнд — ряд 1-2-5 (малый — половина: 1/2, 2/5, 5/10, 25/50 …).
const BLIND_STEPS = [2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000];
// Взнос sit-n-go — ряд 1-2-2,5-5: 10, 20, 25, 50, 100 … 1 000 000.
const BUY_IN_STEPS = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10_000, 20_000, 25_000,
  50_000, 100_000, 200_000, 250_000, 500_000, 1_000_000];
const CASH_SEATS = [2, 4, 6, 9];
const SNG_SEATS = [6, 9];
const TIMEOUTS = [12, 25, 40];

const store = new Store();
// Приглашённый друг сыграл первые раздачи — пригласившему пишет бот (если Telegram привязан).
store.onReferral = (inviter, friend, paid) => notify(inviter.id, paid
  ? `${friend.name} сыграл ${REF_HANDS} раздач по вашему приглашению — вам +${paid} фишек!`
  : `${friend.name} сыграл ${REF_HANDS} раздач по вашему приглашению.`);
// Новый уровень — значок уровня на месте за столом обновляется сразу.
store.onLevel = (u) => refreshSeatAvatar(u.id);

// Столы живут, пока они нужны: свой стол игрок заводит сам, пустой закрывается.
const CASH_IDLE_MS = 5 * 60_000;     // пустой кэш-стол ждёт столько, прежде чем закрыться
const SNG_IDLE_MS = 10 * 60_000;     // турнир, на который никто не записался
const SNG_DONE_MS = 2 * 60_000;      // законченный турнир ещё висит с итогами
const TABLES_PER_USER = 3;           // сколько своих столов без игроков можно держать открытыми
const TABLES_PER_USER_MAX = 10;      // и сколько своих столов всего — даже если за всеми играют
const TABLES_MAX = 5000;
const BOTS_ONLY_MS = 60_000;         // стол, где остались одни боты, столько ждёт людей, потом боты уходят
const QUICK_PLAYERS = 5;             // «Играть сейчас»: столько игроков за столом вместе с вами (добираем ботами)
const HOUSE_SNG_FILL_MS = 30_000;    // sit-n-go заведения: через столько после первой записи места занимают боты
// Sit-n-go заведения — всегда есть свободный турнир на каждый взнос.
const HOUSE_SNGS = [
  { key: 'sng6-100', seats: 6, buyIn: 100, name: 'Быстрый турнир' },
  { key: 'sng6-500', seats: 6, buyIn: 500, name: 'Средний турнир' },
  { key: 'sng9-1000', seats: 9, buyIn: 1000, name: 'Большой турнир' },
  // Спины — на троих, места добираются быстрее: это формат «сел и играешь».
  { key: 'spin-100', seats: 3, buyIn: 100, name: 'Спин', spin: true, fillMs: 10_000 },
  { key: 'spin-1000', seats: 3, buyIn: 1000, name: 'Спин', spin: true, fillMs: 10_000 },
  // Омаха пот-лимит — те же sit-n-go, четыре карты на руках.
  { key: 'omaha6-100', seats: 6, buyIn: 100, name: 'Омаха · быстрый', game: 'omaha' },
  { key: 'omaha6-1000', seats: 6, buyIn: 1000, name: 'Омаха · большой', game: 'omaha' },
];
const LOBBY_LIMIT = 150;             // столько столов уходит в лобби — самые живые
const EVAL_PER_TICK = 8;             // тяжёлых разборов руки за тик (по ~4 мс каждый)

const handsByDay = new Map();   // день -> раздач сыграно (для админки; живёт до перезапуска)
const tables = new Map();       // tableId -> Table, в порядке создания
const playerTable = new Map();  // userId -> Table (чтобы не перебирать все столы)
const invites = new Map();      // код приглашения -> Table
let tableSeq = 0;

// Код приглашения: короткий, без похожих символов, угадать перебором нельзя.
const INVITE_ABC = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function inviteCode() {
  let code;
  do {
    code = Array.from(crypto.randomBytes(10), (b) => INVITE_ABC[b % INVITE_ABC.length]).join('');
  } while (invites.has(code));
  return code;
}

function dropTable(table) {
  tables.delete(table.id);
  invites.delete(table.invite);
  // Кто ещё числился за этим столом — свободен: иначе у друзей висело бы «за столом», которого нет.
  for (const [userId, t] of playerTable) if (t === table) playerTable.delete(userId);
}

// Чьи фишки и статистику ведёт хранилище: людей и ботов-резидентов (у них свой банк).
const tracked = (p) => !p.isBot || !!p.resident;

function createTable(cfg, {
  owner = null, sng = 0, buyIn, spin = false, invite = null, privateTable = false, createdAt = 0, mttTour = null, mttId = null,
} = {}) {
  const n = ++tableSeq;
  // Стол турнира по расписанию получает «переходник» от турнира, sit-n-go — свой Tournament.
  const tour = mttTour || (sng ? new Tournament(sng, {
    pay: (player, amount, place) => { if (tracked(player)) store.addChips(player.userId, amount, `Приз за ${place} место: ${cfg.name}`); },
    onStart: (players) => {
      for (const p of players) {
        if (!tracked(p)) continue;
        store.recordSng(p.userId, { start: true });
        if (p.isBot) continue;
        // Записался и ушёл — бот напомнит, что турнир начался.
        if (!isOnline(p.userId)) notify(p.userId, `Турнир начался — вас ждут за столом. Пока вас нет, блайнды списываются.`);
      }
    },
    onPlace: (player, place, prize) => {
      if (tracked(player)) store.recordSng(player.userId, { place, prize, humans: tour.humans, seats: tour.seats });
    },
  }, buyIn, { spin }) : null);
  const table = new Table({ ...cfg, id: cfg.id || `t${n}`, tour }, {
    onChipsReturn: (player, chips) => {
      if (!tracked(player)) return;
      // Турнирные фишки в банк не уходят. До старта уход из-за стола — отмена регистрации.
      if (tour) { if (tour.status === 'registering') store.addChips(player.userId, tour.buyIn, `Возврат взноса: ${cfg.name}`); return; }
      if (chips > 0) store.addChips(player.userId, chips, `Со стола «${cfg.name}»`);
    },
    onHandStart: (players) => {
      handsByDay.set(dayKey(), (handsByDay.get(dayKey()) || 0) + 1);
      for (const p of players) if (tracked(p)) store.countHand(p.userId);
    },
    onHandEnd: (results) => {
      const humans = results.filter((r) => !r.player.isBot).map((r) => r.player.userId);
      for (const r of results) {
        if (!tracked(r.player)) continue;
        // Сыграл раздачу за одним столом с другом — для задания дня.
        const me = store.user(r.player.userId);
        const withFriend = !!me && humans.some((id) => id !== me.id && me.friends.includes(id));
        store.recordHand(r.player.userId, { ...r, cash: !tour, withFriend, withHuman: humans.some((id) => id !== r.player.userId) });
      }
    },
    // Сыгранная раздача — в историю участников («Последние раздачи»).
    onHandRecord: (record) => store.saveHand(record),
    onSeat: (player, t) => {
      if (!tracked(player)) return;
      playerTable.set(player.userId, t);
      player.avatar = store.avatarUrl(store.user(player.userId));   // аватар — на месте за столом
      player.frame = store.frameOf(store.user(player.userId));       // и рамка из магазина
      player.level = store.levelOf(store.user(player.userId));       // и уровень
    },
    // Пересаженного в турнире уже записали за новый стол — старый не должен его стереть.
    onUnseat: (player, t) => { if (tracked(player) && playerTable.get(player.userId) === t) playerTable.delete(player.userId); },
  });
  table.house = !owner && !mttId;
  table.mttId = mttId;
  table.ownerId = owner ? owner.id : null;
  table.ownerName = owner ? owner.name : null;
  table.private = !!privateTable;          // приватный стол не виден в лобби — только по ссылке
  table.invite = invite || inviteCode();
  table.createdAt = createdAt || Date.now();
  table.emptyAt = Date.now();
  tables.set(table.id, table);
  invites.set(table.invite, table);
  return table;
}

// Свой стол: кэш с выбранными блайндами или sit-n-go на 6 или 9 мест.
// Стол «пустует», если за ним нет людей, кроме самого хозяина. Только такие столы
// упираются в лимит: стол, где играют другие, — живой, и ради него новый не запрещаем.
function idleFor(table, user) {
  return !table.players().some((p) => !p.isBot && p.userId !== user.id);
}

function createUserTable(user, body) {
  const owned = [...tables.values()].filter((t) => t.ownerId === user.id);
  if (owned.length >= TABLES_PER_USER_MAX) return { error: `У вас уже ${TABLES_PER_USER_MAX} столов — закройте какой-нибудь` };
  if (owned.filter((t) => idleFor(t, user)).length >= TABLES_PER_USER) {
    return { error: `У вас уже ${TABLES_PER_USER} стола без игроков — закройте ненужный в «Моих столах» или позовите друзей` };
  }
  if (tables.size >= TABLES_MAX) return { error: 'Свободных столов нет, попробуйте позже' };

  const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 24);
  const privateTable = !!body.private;
  if (body.kind === 'sng') {
    const seats = Number(body.seats);
    if (!SNG_SEATS.includes(seats)) return { error: 'Sit-n-go бывает на 6 или 9 мест' };
    const buyIn = Number(body.buyIn);
    if (!BUY_IN_STEPS.includes(buyIn)) return { error: 'Выберите взнос из ряда: 10, 20, 25, 50, 100 … 1 000 000' };
    const game = body.game === 'omaha' ? 'omaha' : 'holdem';
    return createSngTable(name || `${game === 'omaha' ? 'Омаха' : 'Sit-n-go'} на ${seats}`, seats, buyIn, { owner: user, privateTable, game });
  }

  const seats = Number(body.seats);
  // Большой блайнд — любое целое в пределах; малый — половина (вниз). Старые клиенты шлют номер подсказки.
  const bb = body.bb !== undefined ? Number(body.bb) : (STAKES[Number(body.stake)] || [])[1];
  const timeout = Number(body.timeout);
  if (!CASH_SEATS.includes(seats)) return { error: 'Мест за столом может быть 2, 4, 6 или 9' };
  if (!BLIND_STEPS.includes(bb)) return { error: 'Выберите блайнды из ряда: 1/2, 2/5, 5/10 … 50 000/100 000' };
  if (!TIMEOUTS.includes(timeout)) return { error: 'Выберите время на ход' };
  const sb = Math.max(1, Math.floor(bb / 2));
  const game = body.game === 'omaha' ? 'omaha' : 'holdem';
  return createTable({
    name: name || `${game === 'omaha' ? 'Омаха' : 'Стол'} ${user.name}`,
    maxSeats: seats, sb, bb, minBuyIn: bb * 20, maxBuyIn: bb * 100, timeout, game,
  }, { owner: user, privateTable });
}

function createSngTable(name, seats, buyIn, opts = {}) {
  const stack = opts.spin ? SPIN_STACK : SNG_STACK;
  const table = createTable({
    name, maxSeats: seats, sb: 0, bb: 0, minBuyIn: stack, maxBuyIn: stack, timeout: opts.spin ? SPIN_TIMEOUT : SNG_TIMEOUT,
    game: opts.game === 'omaha' ? 'omaha' : 'holdem',
  }, { ...opts, sng: seats, buyIn });
  [table.sb, table.bb] = table.tour.blinds();
  return table;
}

// Кого из ботов сажать — по ставкам стола: на маленьких — новички и любители,
// чтобы новым игрокам было по силам; на крупных — регуляры, акулы и профи.
// Вес — сколько «билетов в шляпе» у каждого уровня.
const BOT_MIX = [
  { upTo: 2, mix: { novice: 6, amateur: 3, regular: 1 } },
  { upTo: 10, mix: { novice: 3, amateur: 4, regular: 2, shark: 1 } },
  { upTo: 50, mix: { novice: 1, amateur: 3, regular: 4, shark: 2, pro: 1 } },
  // И на крупных ставках иногда садится «рыба» — как в жизни: есть на ком заработать.
  { upTo: Infinity, mix: { novice: 1, amateur: 2, regular: 3, shark: 4, pro: 3 } },
];
function botMixFor(table) {
  const tour = table.tour;
  // Турниры: по взносу — дешёвые как маленькие столы, дорогие как крупные; спины — вперемешку.
  const level = tour ? (tour.spin ? 10 : Math.min(100, (tour.buyIn || 100) / 20)) : table.bb;
  return BOT_MIX.find((m) => level <= m.upTo).mix;
}

// Посадить бота на первое свободное место. Игрок нажал «Позвать ботов» — садится бот
// с пометкой (персонаж подходящего уровня). Стол сам добирает соперников (быстрая игра,
// турниры заведения) — сначала зовёт свободного резидента, как будто подсел живой игрок.
function addBotTo(table, { residentsOk = false, residentsOnly = false } = {}) {
  // Садятся на случайное свободное место — как люди, а не подряд.
  const empty = table.seats.map((s, i) => (s === null ? i : -1)).filter((i) => i >= 0);
  if (!empty.length) return { error: 'Свободных мест нет' };
  const seat = empty[Math.floor(Math.random() * empty.length)];
  const taken = new Set(table.players().map((p) => p.name));
  const mix = botMixFor(table);
  const pool = BOT_CHARACTERS.filter((c) => !taken.has(c.name) && mix[c.style]);
  let pick = null;
  const total = pool.reduce((sum, c) => sum + mix[c.style], 0);
  let roll = Math.random() * total;
  for (const c of pool) { roll -= mix[c.style]; if (roll < 0) { pick = c; break; } }
  const resident = residentsOk || residentsOnly ? pickResident(table, mix) : null;
  if (resident) {
    const res = sitResident(resident, table, seat);
    if (!res.error) return res;
  }
  if (residentsOnly) return { error: 'Свободных резидентов нет' };
  if (!pick) pick = { name: EXTRA_BOT_NAMES.find((n) => !taken.has(n)) || `Бот-${seat + 1}`, style: 'amateur' };
  const stack = table.tour ? table.tour.stack : Math.round((table.minBuyIn + table.maxBuyIn) / 2);
  const res = table.sit({ id: `bot-${crypto.randomUUID()}`, name: pick.name, isBot: true }, seat, stack);
  if (!res.error) table.seats[seat].botStyle = pick.style;
  return res;
}

// ——— боты-резиденты ———
// Персонажи живут как игроки: у каждого аккаунт, банк и профиль (с пометкой «бот»).
// Сами садятся за столы — к людям и друг к другу, — открывают свои столы, играют
// сессию 10–40 минут, уходят и через какое-то время возвращаются. Если их ни разу
// не позвали, за столами одновременно сидит несколько резидентов — в лобби есть жизнь.
// Все числа поведения — в настройках (админка → «Резиденты», data/residents.json):
// банк нового резидента и любимые ставки по уровням, длина сессий, куда садятся и т. д.
const residentsCfg = createResidentsConfig(store.dataDir, RESIDENT_LIST.map((r) => r.key));
const RS = residentsCfg.settings;
const residentBB = (style) => [RS.bbMin[style], RS.bbMax[style]];
const between = ([lo, hi]) => lo + Math.random() * (hi - lo);
const EXTRA_BOT_NAMES = ['Лёва', 'Мира', 'Нил', 'Оля', 'Паша', 'Рома', 'Сима', 'Тима', 'Уля', 'Фима', 'Хана', 'Ян'];
const residents = new Map();   // ключ -> { userId, style, off, until, restUntil }
const residentByUser = new Map();
// Список из bot.js с правками из админки (ник, уровень, выключен). Вызывается
// при старте и после сохранения состава — аккаунты переименовываются на месте.
function applyRoster() {
  const roster = residentsCfg.roster();
  for (const base of RESIDENT_LIST) {
    const r = { ...base, ...roster[base.key] };
    const u = store.ensureResident(r, RS.bank[r.style]);
    if (!u) { residents.delete(base.key); continue; }
    const had = residents.get(base.key);
    if (had) Object.assign(had, { userId: u.id, style: r.style, off: !!r.off });
    else residents.set(base.key, { userId: u.id, key: base.key, style: r.style, off: !!r.off, until: 0, restUntil: 0 });
  }
  residentByUser.clear();
  for (const r of residents.values()) residentByUser.set(r.userId, r);
}
applyRoster();
const isResidentOwner = (t) => !!t.ownerId && residentByUser.has(t.ownerId);

// Записан на турнир по расписанию, который вот-вот начнётся, — за другие столы не садится.
const MTT_HOLD_MS = 3 * 60_000;
let mttsReady = false;
function mttSoon(r, now = Date.now()) {
  if (!mttsReady) return null;   // столы заведения создаются раньше турниров
  for (const m of mtts.list.values()) {
    if (m.status === 'registering' && m.entries.has(r.userId) && m.startAt - now < MTT_HOLD_MS) return m;
  }
  return null;
}
const residentFree = (r, now = Date.now()) => RS.enabled && !r.off && !tableOfUser(r.userId)
  && now >= r.restUntil && !r.pending && !mttSoon(r, now);

function pickResident(table, mix) {
  const now = Date.now();
  const pool = [...residents.values()].filter((r) => residentFree(r, now) && mix[r.style]
    && store.user(r.userId).chips >= (table.tour ? table.tour.buyIn : table.minBuyIn));
  if (!pool.length) return null;
  const total = pool.reduce((sum, r) => sum + mix[r.style], 0);
  let roll = Math.random() * total;
  for (const r of pool) { roll -= mix[r.style]; if (roll < 0) return r; }
  return pool[0];
}

// Посадить резидента: закупка или взнос — из его банка, как у человека.
function sitResident(r, table, seat) {
  const tour = table.tour;
  if (tour && tour.status !== 'registering') return { error: 'Турнир уже идёт' };
  if (!Number.isInteger(seat) || seat < 0) seat = table.seats.findIndex((x) => x === null);
  if (seat < 0) return { error: 'Свободных мест нет' };
  const u = store.user(r.userId);
  const want = tour ? tour.buyIn : Math.min(table.maxBuyIn, Math.max(table.minBuyIn, Math.round(table.bb * (40 + Math.random() * 60))));
  if (u.chips < want) return { error: 'Мало фишек' };
  const stack = tour ? tour.stack : want;
  store.addChips(u.id, -want, tour ? `Взнос: ${table.name}` : `За стол «${table.name}»`);
  const res = table.sit({ id: u.id, name: u.name, isBot: true, resident: true, botStyle: r.style }, seat, stack);
  if (res.error) { store.addChips(u.id, want, 'Посадка не удалась — возврат'); return res; }
  r.until = Date.now() + between(RS.sessionMin) * 60_000;
  return res;
}

// Проигрался за кэш-столом — докупается из банка; не на что — встаёт.
function residentRebuy(table, p) {
  const u = store.user(p.userId);
  const want = Math.min(table.maxBuyIn - p.stack, Math.round(table.bb * 60));
  if (u && u.chips >= want && want > 0) {
    store.addChips(u.id, -want, `Докупка за стол «${table.name}»`);
    p.stack += want;
    p.sittingOut = false;
    p.busted = false;
    table.maybeStartHand();
  } else {
    table.leave(p.userId);
  }
}

// Столы, где сидят люди, — в приоритете: резиденты подсаживаются туда постепенно
// (по умолчанию раз в 8–25 с), но не до полного стола — заполняют примерно 35–65% мест.
// Свободных нет — кто-нибудь встаёт из-за стола, где одни резиденты, и пересаживается.
function residentsToHumans(now) {
  if (!RS.enabled || !RS.humanTables) return;
  for (const t of tables.values()) {
    if (t.tour || t.mttId || t.private || !t.humans() || t.occupied() >= t.maxSeats - 1) continue;
    // У каждого стола своя доля в пределах настройки — постоянная, чтобы столы не «дышали».
    if (t.residentRoll === undefined) t.residentRoll = Math.random();
    const [lo, hi] = RS.humanShare;
    const cap = t.maxSeats <= 2 ? 1 : Math.round(t.maxSeats * (lo + t.residentRoll * (hi - lo)) / 100);
    const have = t.players().filter((p) => p.resident).length;
    if (have >= cap) continue;
    if (!t.nextResidentAt) { t.nextResidentAt = now + between(RS.humanJoinSec) * 600; continue; }
    if (now < t.nextResidentAt) continue;
    t.nextResidentAt = now + between(RS.humanJoinSec) * 1000;
    const canPay = (r) => store.user(r.userId).chips >= t.minBuyIn * 2;
    const free = [...residents.values()].filter((r) => residentFree(r, now) && canPay(r));
    if (free.length) { sitResident(free[Math.floor(Math.random() * free.length)], t); continue; }
    // Пересадка: резидент из-за стола без людей, между раздачами.
    const mover = [...residents.values()].find((r) => {
      const at = tableOfUser(r.userId);
      return at && at !== t && !at.tour && !at.humans() && at.phase === 'idle' && canPay(r) && !r.pending && !r.off;
    });
    if (mover) { tableOfUser(mover.userId).leave(mover.userId); sitResident(mover, t); }
  }
}

// Приглашение резидента-друга: отвечает через несколько секунд, может и отказаться.
// Свободен — садится сразу; играет — доигрывает раздачу (в турнире — турнир) и приходит.
const RESIDENT_NO = ['Сейчас не могу, в другой раз', 'Уже ухожу, извини', 'Не мои ставки, пас', 'Чуть позже загляну'];
function inviteResident(user, friend, table) {
  const r = residentByUser.get(friend.id);
  const tell = (text) => emitToUser(user.id, 'notice', { text });
  if (!isOnline(friend.id)) return { ok: true, online: false, note: `${friend.name} сейчас не в сети` };
  if (r.pending) return { ok: true, online: true, note: `${friend.name} уже позвали за другой стол` };
  const busy = tableOfUser(friend.id);
  const price = table.tour ? table.tour.buyIn : table.minBuyIn;
  const [lo, hi] = residentBB(r.style);
  let yes = RS.inviteYes / 100;
  if (!table.tour && (table.bb < lo / 2 || table.bb > hi * 2)) yes = RS.inviteOffStakes / 100;
  if (!RS.enabled || r.off || mttSoon(r)) yes = 0;
  if (busy) yes -= 0.15;
  if (store.user(friend.id).chips < price) yes = 0;
  setTimeout(() => {
    if (!tables.has(table.id)) return;
    if (Math.random() >= yes) { tell(`${friend.name}: «${RESIDENT_NO[Math.floor(Math.random() * RESIDENT_NO.length)]}»`); return; }
    if (!tableOfUser(friend.id)) {
      const res = sitResident(r, table);
      tell(res.error ? `${friend.name} хотел сесть, но за столом нет места` : `${friend.name} принял приглашение и сел за стол`);
      return;
    }
    r.pending = { tableId: table.id, inviterId: user.id, until: Date.now() + 15 * 60_000 };
    const at = tableOfUser(friend.id);
    tell(`${friend.name}: «Доиграю ${at.tour && at.tour.status === 'running' ? 'турнир' : 'раздачу'} и подойду»`);
  }, 3000 + Math.random() * 5000);
  return { ok: true, online: true, note: `${friend.name} получил приглашение` };
}

// Обещал подойти: доигрывает и садится за стол, куда звали.
function residentInvites(now) {
  for (const r of residents.values()) {
    const p = r.pending;
    if (!p) continue;
    const target = tables.get(p.tableId);
    const tell = (text) => emitToUser(p.inviterId, 'notice', { text });
    const name = store.user(r.userId).name;
    if (!target || now > p.until) { r.pending = null; continue; }
    const at = tableOfUser(r.userId);
    if (at === target) { r.pending = null; continue; }
    if (at) {
      if (at.tour && at.tour.status === 'running') continue;       // доигрывает турнир
      if (at.phase !== 'idle') continue;                           // доигрывает раздачу
      at.leave(r.userId);
    }
    r.pending = null;
    const res = sitResident(r, target);
    tell(res.error ? `${name} пришёл, но за вашим столом нет места` : `${name} подошёл и сел за ваш стол`);
  }
}

// Турниры по расписанию: резиденты записываются заранее — по одному, вразброс
// за mttRegMin минут до старта, — платят взнос из своего банка, как люди.
// За 3 минуты до старта больше никуда не садятся, а сидящие встают между раздачами.
function residentsMtt(now) {
  for (const m of mtts.list.values()) {
    if (m.status !== 'registering') continue;
    const left = m.startAt - now;
    for (const e of m.entries.values()) {
      const r = e.resident && residentByUser.get(e.userId);
      const t = r && left < MTT_HOLD_MS && tableOfUser(r.userId);
      if (t && !t.mttId && !(t.tour && t.tour.status === 'running') && t.phase === 'idle') t.leave(r.userId);
    }
    if (!RS.enabled || !RS.mtt || left > RS.mttRegMin * 60_000 || left < 60_000) continue;
    if (RS.mttNeedHuman && ![...m.entries.values()].some((e) => !e.isBot)) continue;
    if (m.residentRoll === undefined) m.residentRoll = Math.random();
    const goal = Math.round(RS.mttCount[0] + m.residentRoll * (RS.mttCount[1] - RS.mttCount[0]));
    const have = [...m.entries.values()].filter((e) => e.resident).length;
    if (have >= goal) continue;
    // Вероятность за обход такая, чтобы недостающие успели записаться к старту.
    const ticksLeft = Math.max(1, (left - 60_000) / (RS.tickSec * 1000));
    if (Math.random() > Math.min(1, ((goal - have) / ticksLeft) * 1.5)) continue;
    const busy = new Set();
    for (const o of mtts.list.values()) if (o.status === 'registering') for (const id of o.entries.keys()) busy.add(id);
    const pool = [...residents.values()].filter((r) => !r.off && !busy.has(r.userId)
      && store.user(r.userId).chips >= m.buyIn * 3);
    if (!pool.length) continue;
    const r = pool[Math.floor(Math.random() * pool.length)];
    const u = store.user(r.userId);
    const res = m.register({ userId: u.id, name: u.name, isBot: true, resident: true, botStyle: r.style }, u.chips);
    if (res.pay) store.addChips(u.id, -res.pay, `Взнос: ${m.name}`);
  }
}

// Старт турнира: записанные резиденты освобождаются от других столов. Из идущего
// sit-n-go не уйти — тогда запись снимается, взнос возвращается.
function residentsBeforeMtt(m) {
  for (const e of [...m.entries.values()]) {
    if (!e.resident) continue;
    const t = tableOfUser(e.userId);
    if (!t || t.mttId) continue;
    if (t.tour && t.tour.status === 'running') m.unregister(e.userId);
    else t.leave(e.userId);
  }
}

// Раз в несколько секунд: кто-то встаёт, кто-то садится.
let residentsAt = 0;
function residentsTick(now) {
  if (now - residentsAt < RS.tickSec * 1000) return;
  residentsAt = now;
  const all = [...residents.values()];
  // Банк кончился почти совсем — раз в сутки «приходят деньги» (это боты, им можно).
  for (const r of all) {
    const u = store.user(r.userId);
    if (u && u.chips < 200 && !tableOfUser(r.userId)) store.reload(u.id);   // как у людей — бесплатное пополнение
  }
  // Сессия вышла — встаём (из идущего турнира — нет, доигрываем). Резидентов выключили
  // в админке — встают так же, между раздачами.
  for (const r of all) {
    const t = tableOfUser(r.userId);
    const stop = !RS.enabled || r.off;
    if (!t || (now < r.until && !stop) || (t.tour && t.tour.status === 'running')) continue;
    if (stop && t.phase !== 'idle') continue;
    t.leave(r.userId);
    r.restUntil = now + between(RS.restMin) * 60_000;
    r.onlineUntil = stop ? 0 : now + between(RS.onlineAfterMin) * 60_000;   // ещё побудет «в сети» — его можно позвать
  }
  residentsMtt(now);
  if (!RS.enabled) return;
  residentInvites(now);
  residentsToHumans(now);
  // Сидит один за своим столом дольше aloneMin минут — никто не пришёл, встаёт.
  for (const r of all) {
    const t = tableOfUser(r.userId);
    if (!t || t.tour || t.occupied() > 1) { r.aloneSince = 0; continue; }
    if (!r.aloneSince) r.aloneSince = now;
    else if (now - r.aloneSince > RS.aloneMin * 60_000) { t.leave(r.userId); r.restUntil = now + between(RS.restMin) * 60_000; r.aloneSince = 0; }
  }
  // За столами турниров по расписанию резиденты не в счёт: там своя запись.
  const seated = all.filter((r) => { const t = tableOfUser(r.userId); return t && !t.mttId; }).length;
  const humansOnline = [...presence.values()].filter((p) => p.conns > 0).length;
  const target = Math.min(RS.online[1], RS.online[0] + Math.ceil(humansOnline / RS.perHumans));
  if (seated >= target) return;
  const free = all.filter((r) => residentFree(r, now));
  if (!free.length) return;
  const r = free[Math.floor(Math.random() * free.length)];
  // Кто-то из резидентов ждёт соперников один — подсаживаемся к нему в первую очередь.
  const lonely = [...tables.values()].find((t) => !t.tour && !t.private && t.occupied() === 1
    && t.players()[0].resident && t.occupied() < t.maxSeats && store.user(r.userId).chips >= t.minBuyIn * 2);
  if (lonely) { sitResident(r, lonely); return; }
  const [lo, hi] = residentBB(r.style);
  const bank = store.user(r.userId).chips;
  const fits = (t) => !t.tour && !t.mttId && !t.private && t.occupied() < t.maxSeats
    && t.bb >= lo && t.bb <= hi && bank >= t.minBuyIn * 2;
  const open = [...tables.values()].filter(fits);
  // Куда: к людям — охотнее всего, к другим резидентам — тоже, иначе — свой стол.
  const withHumans = open.filter((t) => t.humans() > 0);
  const withResidents = open.filter((t) => t.players().some((p) => p.resident) && !t.humans());
  const roll = Math.random() * 100;
  let table = roll < RS.preferHumans && withHumans.length ? withHumans[Math.floor(Math.random() * withHumans.length)]
    : roll < RS.preferHumans + RS.preferResidents && withResidents.length ? withResidents[Math.floor(Math.random() * withResidents.length)] : null;
  if (!table) {
    const ownTables = [...tables.values()].filter((t) => isResidentOwner(t) && t.occupied()).length;
    if (ownTables < RS.ownTablesMax && Math.random() * 100 < RS.ownTableChance) {
      const stakes = BLIND_STEPS.filter((bb) => bb >= lo && bb <= hi && bank >= bb * 100);
      if (stakes.length) {
        const bb = stakes[Math.floor(Math.random() * Math.min(3, stakes.length))];
        const owner = store.user(r.userId);
        const made = createUserTable(owner, { kind: 'cash', seats: [6, 6, 9, 4][Math.floor(Math.random() * 4)], bb, timeout: 25 });
        if (!made.error) table = made;
      }
    }
    if (!table && open.length) table = open[Math.floor(Math.random() * open.length)];
  }
  if (table) sitResident(r, table);
}

// Посадить игрока: взнос или закупка списывается из банка до посадки —
// последний участник sit-n-go сразу запускает турнир.
function seatUser(user, table, buyIn, seat) {
  const tour = table.tour;
  if (tour && tour.status !== 'registering') return { error: 'Регистрация на турнир закрыта' };
  const pay = tour ? tour.buyIn : buyIn;
  const stack = tour ? tour.stack : pay;
  const fresh = store.user(user.id);
  if (pay > fresh.chips) return { error: 'В банке недостаточно фишек' };
  if (!Number.isInteger(seat) || seat < 0) seat = table.seats.findIndex((x) => x === null);
  if (seat < 0) return { error: 'Свободных мест нет' };
  store.addChips(user.id, -pay, tour ? `Взнос: ${table.name}` : `За стол «${table.name}»`);
  const res = table.sit({ id: user.id, name: user.name }, seat, stack);
  if (res.error) { store.addChips(user.id, pay, 'Посадка не удалась — возврат'); return res; }
  store.markSit(user);
  // Sit-n-go заведения: таймер добора ботов идёт с первой записи — сразу, а не со следующего обхода.
  if (!table.mttId && !table.private && tour && tour.status === 'registering' && !tour.fillAt) {
    tour.fillAt = Date.now() + (table.fillMs || HOUSE_SNG_FILL_MS);
    table.touch();
  }
  return { ok: true };
}

// «Играть сейчас»: кэш-стол заведения по банку игрока — закупка не больше
// четверти банка, — и боты, чтобы раздача началась сразу.
function quickPlay(user, session) {
  const seated = tableOfUser(user.id);
  if (seated) { session.roomId = seated.id; return { ok: true, roomId: seated.id }; }
  const chips = store.user(user.id).chips;
  // Сначала — открытый кэш-стол, где уже играют люди и ставки по карману
  // (закупка — не больше половины банка): живые игроки должны встречаться,
  // а не сидеть каждый за своим столом с ботами. Больше людей — выше в очереди,
  // при равенстве — ставки покрупнее из тех, что по карману.
  const open = (t) => !t.tour && !t.mttId && !t.private && t.game !== 'omaha'
    && t.maxSeats >= 4 && t.occupied() < t.maxSeats;
  const withPeople = [...tables.values()]
    .filter((t) => open(t) && t.humans() > 0 && t.minBuyIn * 2 <= chips)
    .sort((a, b) => b.humans() - a.humans() || b.bb - a.bb);
  // Людей нигде нет — стол заведения по банку, соперников доберут боты.
  const cash = [...tables.values()].filter((t) => open(t) && t.house).sort((a, b) => a.bb - b.bb);
  if (!withPeople.length && !cash.length) return { error: 'Свободных столов нет, попробуйте позже' };
  const fit = cash.filter((t) => t.maxBuyIn * 4 <= chips);
  const table = withPeople[0] || (fit.length ? fit[fit.length - 1] : cash[0]);
  const buyIn = Math.min(table.maxBuyIn, chips);
  if (buyIn < table.minBuyIn) return { error: 'В банке мало фишек — пополните его в шапке', reload: true };
  const res = seatUser(user, table, buyIn);
  if (res.error) return res;
  while (table.occupied() < Math.min(QUICK_PLAYERS, table.maxSeats) && !addBotTo(table, { residentsOk: true }).error) { /* добираем соперников */ }
  session.roomId = table.id;
  return { ok: true, roomId: table.id };
}

// «Ещё sit-n-go»: записаться в свободный турнир заведения — с тем же взносом
// или самым близким, который по карману.
// «Ещё sit-n-go»: такой же турнир, как сыгранный, — тот же взнос, столько же мест,
// спин или нет. Сначала среди турниров заведения, потом среди открытых турниров
// игроков; нет такого — открываем новый с теми же условиями: места через полминуты
// после записи займут боты, как в турнирах заведения.
function quickSng(user, session, { buyIn, spin = false, seats = 0, name = '', game = 'holdem' }) {
  const seated = tableOfUser(user.id);
  if (seated) {
    if (!seated.tour) return { error: 'Сначала встаньте из-за кэш-стола' };
    if (seated.tour.status === 'running') return { error: 'Вы ещё играете в турнире' };
    seated.leave(user.id);   // запись на другой турнир отменяется, взнос — в банк
  }
  if (store.user(user.id).chips < buyIn) return { error: 'В банке не хватает на взнос' };
  const same = (t) => t.tour && !t.mttId && !t.private && t.tour.status === 'registering'
    && t.tour.buyIn === buyIn && !!t.tour.spin === spin && (!seats || t.maxSeats === seats)
    && (t.game || 'holdem') === game && t.occupied() < t.maxSeats;
  const open = [...tables.values()].filter(same).sort((a, b) => !!b.houseSng - !!a.houseSng);
  let table = open[0];
  if (!table) {
    const okSeats = spin ? seats === 3 : SNG_SEATS.includes(seats);
    const okBuyIn = BUY_IN_STEPS.includes(buyIn) || HOUSE_SNGS.some((tpl) => tpl.buyIn === buyIn);
    if (!okSeats || !okBuyIn) return { error: 'Такого турнира сейчас нет — выберите в лобби' };
    if (tables.size >= TABLES_MAX) return { error: 'Свободных столов нет, попробуйте позже' };
    table = createSngTable(String(name || `Sit-n-go на ${seats}`).slice(0, 24), seats, buyIn, { spin, game });
    table.houseSng = 'custom';
    table.fillMs = HOUSE_SNG_FILL_MS;
  }
  const res = seatUser(user, table);
  if (res.error) return res;
  session.roomId = table.id;
  return { ok: true, roomId: table.id };
}

// Sit-n-go заведения: у каждого шаблона всегда есть турнир с открытой записью.
// Записался хотя бы один человек — через полминуты свободные места занимают боты
// и турнир стартует. Ушли все люди — таймер сбрасывается.
function maintainHouseSngs(now) {
  for (const tpl of HOUSE_SNGS) {
    if ([...tables.values()].some((t) => t.houseSng === tpl.key && t.tour.status === 'registering')) continue;
    const table = createSngTable(tpl.name, tpl.seats, tpl.buyIn, { spin: !!tpl.spin, game: tpl.game });
    table.houseSng = tpl.key;
    table.fillMs = tpl.fillMs || HOUSE_SNG_FILL_MS;
  }
  // Добор соперников в sit-n-go с открытой записью (заведения и открытые турниры игроков):
  // записался человек — резиденты занимают случайные места постепенно, за fillMs; что
  // осталось к концу — добирают боты, и турнир стартует. Ушли все люди — таймер сбрасывается.
  for (const open of tables.values()) {
    const tour = open.tour;
    if (!tour || open.mttId || open.private || tour.status !== 'registering') continue;
    if (!open.humans()) { if (tour.fillAt) { tour.fillAt = 0; open.nextJoinAt = 0; open.touch(); } continue; }
    const span = open.fillMs || HOUSE_SNG_FILL_MS;
    if (!tour.fillAt) { tour.fillAt = now + span; open.touch(); }
    if (!open.nextJoinAt) open.nextJoinAt = now + span * (0.08 + Math.random() * 0.15);
    if (now >= tour.fillAt) {
      while (open.occupied() < open.maxSeats && !addBotTo(open, { residentsOk: RS.sngJoin }).error) { /* до полного стола — турнир стартует */ }
      open.maybeStartHand();
      continue;
    }
    const free = open.maxSeats - open.occupied();
    if (free > 1 && now >= open.nextJoinAt) {
      if (RS.sngJoin) addBotTo(open, { residentsOnly: true });
      const left = tour.fillAt - now;
      open.nextJoinAt = now + (left / Math.max(1, free)) * (0.4 + Math.random() * 0.9);
    }
  }
}

// Боты без людей: за кэш-столом, где не осталось ни одного человека, боты
// ждут минуту и уходят — иначе стол играл бы сам с собой вечно.
// Sit-n-go заведения, из которого вылетели все люди, доигрывать незачем.
function dropLonelyBots(now) {
  for (const table of tables.values()) {
    if (table.mttId || table.humans() || !table.occupied()) { table.botsOnlyAt = 0; continue; }
    // Резиденты играют и без людей — уходят сами по своему расписанию (см. residentsTick).
    if (!table.tour && table.players().some((p) => p.resident)) { table.botsOnlyAt = 0; continue; }
    if (table.tour && !(table.houseSng && table.tour.status === 'running')) continue;
    // Резиденты доигрывают турнир сами — стол не закрываем.
    if (table.tour && table.players().some((p) => p.resident)) continue;
    if (!table.botsOnlyAt) { table.botsOnlyAt = now; continue; }
    if (now - table.botsOnlyAt < BOTS_ONLY_MS) continue;
    if (table.tour) { dropTable(table); continue; }
    for (const p of table.players()) {
      if (p.inHand && table.phase !== 'idle') p.leaving = true;
      else table.removePlayer(p);
    }
  }
}

// Пустые столы игроков закрываются, столы заведения стоят всегда
// (кроме сыгранных sit-n-go заведения — на их место встают новые).
function dropIdleTables(now) {
  for (const table of tables.values()) {
    if ((table.house && !table.houseSng) || table.mttId || table.occupied()) continue;
    // Турнир шаблона заведения с открытой записью стоит всегда; открытый по «Ещё sit-n-go»
    // закрывается, как обычный, если все ушли до старта.
    if (table.houseSng && table.houseSng !== 'custom' && table.tour.status === 'registering') continue;
    const tour = table.tour;
    const idle = tour
      ? (tour.status === 'finished' ? now - tour.finishedAt > SNG_DONE_MS
        : tour.status === 'registering' && table.emptyAt && now - table.emptyAt > SNG_IDLE_MS)
      : table.emptyAt && now - table.emptyAt > CASH_IDLE_MS;
    if (idle) dropTable(table);
  }
}

for (const cfg of ROOM_CONFIGS) createTable(cfg);

// ——— турниры по расписанию ———

const mtts = new MttManager({
  createTable: (cfg, tour, mtt) => createTable(cfg, { mttTour: tour, mttId: mtt.id }),
  dropTable: (table) => dropTable(table),
  pay: (entry, amount) => store.addChips(entry.userId, amount, 'Приз в турнире по расписанию'),
  refund: (entry, amount) => store.addChips(entry.userId, amount, 'Возврат: турнир по расписанию'),
  record: (entry, info) => store.recordMtt(entry.userId, info),
  notify: (userId, text) => notify(userId, text),
  isOnline: (userId) => isOnline(userId),
  beforeStart: (mtt) => residentsBeforeMtt(mtt),
});
mttsReady = true;

// Что из турниров кладётся в снимок рядом со столами.
function mttSnapshot() {
  return {
    mtts: mtts.snapshot().filter((m) => m.status === 'registering'),
    mttsRunning: [...mtts.list.values()].filter((m) => m.status === 'running').map((m) => ({
      id: m.id,
      poolLeft: m.prizes.reduce((a, b) => a + b, 0) - m.places.reduce((s, p) => s + p.prize, 0),
    })),
  };
}
function saveSnapshot() { return snapshot.save(tables, mttSnapshot()); }

// ——— Telegram ———

const bot = TG_TOKEN
  ? new telegram.Bot(TG_TOKEN, { appUrl: APP_URL, username: process.env.TELEGRAM_BOT_NAME || null })
  : null;

// Сообщение игроку в Telegram, если он привязан и бот работает.
function notify(userId, text) {
  const u = store.user(userId);
  if (!bot || !bot.running || !u || !u.tg) return;
  bot.notify(u.tg.id, text);
}

// Подпись от виджета на сайте или от Mini App — оба пути дают одного и того же игрока.
function telegramIdentity(body) {
  if (!TG_TOKEN || !TG_LOGIN) return null;
  if (body.initData) return telegram.verifyWebApp(body.initData, TG_TOKEN);
  return telegram.verifyLogin(body.data, TG_TOKEN);
}

// ——— снимок столов: фишки переживают перезапуск ———

const snapshot = new Snapshot(store.dataDir);

// Стол игрока из снимка открывается заново пустым — с тем же адресом и приглашением.
const presence = new Map();         // userId -> { conns, lastSeen }

function reopenTable(rec) {
  if (tables.has(rec.id) || invites.has(rec.invite)) return false;
  const owner = rec.ownerId && store.user(rec.ownerId);
  if (!owner) return false;
  const cfg = {
    id: rec.id, name: rec.name, maxSeats: rec.maxSeats, sb: rec.sb, bb: rec.bb,
    minBuyIn: rec.minBuyIn, maxBuyIn: rec.maxBuyIn, timeout: rec.timeout, game: rec.game,
  };
  const opts = { owner, invite: rec.invite, privateTable: rec.private, createdAt: rec.createdAt };
  if (rec.sng) {
    const table = createTable(cfg, { ...opts, sng: rec.sng.seats, buyIn: rec.sng.buyIn });
    [table.sb, table.bb] = table.tour.blinds();
  } else {
    createTable(cfg, opts);
  }
  return true;
}

// Стол из снимка — вместе с игроками: кэш — со стеками на тех же местах,
// sit-n-go — с регистрациями, а идущий — с уровнем, временем, местами и множителем.
// Недоигранная раздача отменяется: вложенное в неё уже лежит в стеках снимка.
// Если стол поднять нельзя (хозяин пропал и т. п.) — фишки вернутся по-старому.
function restoreTable(rec) {
  const sng = rec.sng;
  const humans = rec.players.filter((p) => !p.isBot);
  if (sng && sng.status === 'finished') return false;
  if (!humans.length) return false;
  if (rec.players.some((p) => !Number.isInteger(p.seat))) return false;   // снимок старого формата

  let table = tables.get(rec.id);
  if (!table) {
    if (rec.house && rec.houseSng) {
      table = createTable({
        id: rec.id, name: rec.name, maxSeats: rec.maxSeats, sb: 0, bb: 0,
        minBuyIn: rec.minBuyIn, maxBuyIn: rec.maxBuyIn, timeout: rec.timeout, game: rec.game,
      }, { sng: sng.seats, buyIn: sng.buyIn, spin: !!sng.spin, invite: rec.invite, createdAt: rec.createdAt });
      table.houseSng = rec.houseSng;
      table.fillMs = rec.fillMs || HOUSE_SNG_FILL_MS;
      [table.sb, table.bb] = table.tour.blinds();
    } else if (!rec.house && reopenTable(rec)) {
      table = tables.get(rec.id);
    }
  }
  if (!table || !!table.tour !== !!sng) return false;

  if (sng && sng.status === 'running') {
    const tour = table.tour;
    tour.status = 'running';
    tour.startedAt = Date.now() - (sng.elapsed || 0);
    tour.level = sng.level || 0;
    tour.levelAt = tour.startedAt + tour.level * tour.levelMs;
    tour.places = sng.places || [];
    tour.humans = sng.humans || humans.length;
    if (tour.spin) tour.multiplier = sng.multiplier || 2;
    tour.prizes = sng.prizes && sng.prizes.length ? sng.prizes : tour.prizes;
    [table.sb, table.bb] = tour.blinds();
    table.minRaise = table.bb;
  }
  for (const p of rec.players) {
    table.restoreSeat({ id: p.userId, name: p.name, isBot: p.isBot, resident: p.resident, botStyle: p.botStyle }, p.seat, p.chips, !!p.sittingOut);
    if (p.isBot && !p.resident && p.botStyle) table.seats[p.seat].botStyle = p.botStyle;
    // Не вернувшийся после перезапуска станет «отошедшим», а с кэш-стола — встанет (см. maintain).
    if (!p.isBot && !presence.has(p.userId)) presence.set(p.userId, { conns: 0, lastSeen: Date.now() });
  }
  table.note('Сервер перезапускался — стол восстановлен, недоигранная раздача отменена', 'result');
  table.maybeStartHand();
  return true;
}

{
  const restored = snapshot.restore({
    credit: (userId, amount) => store.addChips(userId, amount, 'Возврат после перезапуска сервера'),
    reopen: reopenTable,
    restore: restoreTable,
  });
  // Новые столы не должны занять номера восстановленных.
  for (const id of tables.keys()) {
    const n = Number(/^t(\d+)$/.exec(id)?.[1]);
    if (n > tableSeq) tableSeq = n;
  }
  if (restored) {
    // Регистрации на турниры — как были; оборвавшиеся турниры — фонд по стекам.
    mtts.restore(restored.snap.mtts || []);
    for (const r of mttRefunds(restored.snap)) {
      store.addChips(r.userId, r.amount, 'Турнир по расписанию прерван перезапуском');
      restored.players += 1;
      restored.chips += r.amount;
    }
    console.log(`Снимок столов разобран: столов поднято ${restored.tables}, игроков вернулось за столы ${restored.seated}; `
      + `фишки в банк вернулись ${restored.players} игрокам (${restored.chips})`);
    // Снимок убираем, только когда возвращённые фишки легли в базу.
    snapshot.paused = true;
    Promise.resolve(store.flush()).then(() => { snapshot.clear(); snapshot.paused = false; });
  }
}

const clients = new Set();          // открытые SSE-соединения

// ——— наблюдение за нагрузкой ———
// Задержка игрового цикла — главный признак перегрузки: если она растёт,
// сервер не успевает обслуживать столы и соединения.
const metrics = {
  lag: new Float64Array(64),
  lagAt: 0,
  pushedFrames: 0,
  pushedBytes: 0,
  serialized: 0,   // сколько раз состояние стола превращалось в JSON
  skipped: 0,      // кадров пропущено из-за медленных соединений
  startedAt: Date.now(),
};

function noteLag(ms) {
  metrics.lag[metrics.lagAt % metrics.lag.length] = ms;
  metrics.lagAt += 1;
}

function lagStats() {
  const n = Math.min(metrics.lagAt, metrics.lag.length);
  if (!n) return { p50: 0, p99: 0, max: 0 };
  const sorted = Array.from(metrics.lag.slice(0, n)).sort((a, b) => a - b);
  return {
    p50: Math.round(sorted[Math.floor(n * 0.5)] * 10) / 10,
    p99: Math.round(sorted[Math.min(n - 1, Math.floor(n * 0.99))] * 10) / 10,
    max: Math.round(sorted[n - 1] * 10) / 10,
  };
}

// ——— утилиты HTTP ———

function send(res, code, data, headers = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 10_000) { reject(new Error('Слишком большой запрос')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Некорректный JSON')); }
    });
    req.on('error', reject);
  });
}

// Тело запроса как есть — для картинок: JSON-разбор и лимит в 10 КБ им не подходят.
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    // Лишнее не храним, но дочитываем: оборванное соединение браузер покажет
    // как сбой сети, а не как понятную ошибку. Сверху объём ограничивает nginx.
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on('end', () => (size > limit ? reject(new Error('Файл слишком большой')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

// ——— аватары ———
// Картинку готовит браузер: обрезает до квадрата 256×256 и сжимает. Сервер
// проверяет формат по первым байтам файла — расширению и заголовку не верим.

const AVATAR_DIR = path.join(store.dataDir, 'avatars');
const AVATAR_MAX = 300_000;
const AVATAR_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function imageKind(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function dropAvatarFile(userId, ext) {
  try { fs.rmSync(path.join(AVATAR_DIR, `${userId}.${ext}`), { force: true }); } catch { /* файла нет */ }
}

// Гость сохранил аккаунт или привязал VK — за столом сразу новое имя.
function renameSeated(userId) {
  const table = tableOfUser(userId);
  const p = table && table.byUser(userId);
  if (!p) return;
  p.name = store.user(userId).name;
  table.touch();
}

// Новый аватар сразу виден и на месте за столом.
function refreshSeatAvatar(userId) {
  const table = tableOfUser(userId);
  const p = table && table.byUser(userId);
  if (!p) return;
  p.avatar = store.avatarUrl(store.user(userId));
  p.frame = store.frameOf(store.user(userId));
  p.level = store.levelOf(store.user(userId));
  table.touch();
}

function serveAvatar(req, res, file) {
  if (!/^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(file)) return send(res, 404, 'Нет такого файла');
  fs.readFile(path.join(AVATAR_DIR, file), (err, body) => {
    if (err) return send(res, 404, 'Нет такого файла');
    res.writeHead(200, {
      'Content-Type': AVATAR_MIME[path.extname(file).slice(1)],
      'Content-Length': body.length,
      // В адресе есть версия, поэтому файл можно кэшировать надолго.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  });
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
  '.webp': 'image/webp',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

// Страницы сайта: главная — для поиска и новичков, игра — на /play.
const PAGES = { '/': 'index.html', '/play': 'play.html', '/play/': 'play.html', '/admin': 'admin.html' };
// Старые и служебные адреса страниц ведут на основные, чтобы у поиска не было дублей.
const PAGE_ALIASES = { '/index.html': '/', '/play.html': '/play' };
// Картинки меняются редко — браузер может не переспрашивать о них сутки.
const LONG_CACHE = new Set(['.png', '.jpg', '.svg', '.ico', '.woff2', '.wav', '.webp']);

// Статика читается с диска один раз и дальше отдаётся из памяти.
// Файлы клиента маленькие, а запросов при большом онлайне много.
const staticCache = new Map(); // путь -> { body, type, etag }

// Файлы клиента меняются редко, но менять их без перезапуска сервера удобно:
// следим за папкой и сбрасываем кэш при любом изменении.
try {
  fs.watch(PUBLIC_DIR, { persistent: false }, () => staticCache.clear());
} catch {
  // Слежение недоступно — тогда кэш живёт до перезапуска.
}

// Счётчик Метрики вставляется в страницы при отдаче, а не лежит в каждом файле:
// так он один на весь сайт, включая страницы, которые собирает сервер.
function withMetrika(html) {
  if (!METRIKA_ID || html.includes('mc.yandex.ru')) return html;
  const snippet = `<!-- Yandex.Metrika counter -->
<script type="text/javascript">
    (function(m,e,t,r,i,k,a){
        m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
        m[i].l=1*new Date();
        for (var j = 0; j < document.scripts.length; j++) {if (document.scripts[j].src === r) { return; }}
        k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)
    })(window, document,'script','https://mc.yandex.ru/metrika/tag.js?id=${METRIKA_ID}', 'ym');

    ym(${METRIKA_ID}, 'init', {ssr:true, webvisor:true, clickmap:true, ecommerce:"dataLayer", referrer: document.referrer, url: location.href, accurateTrackBounce:true, trackLinks:true});
</script>
<noscript><div><img src="https://mc.yandex.ru/watch/${METRIKA_ID}" style="position:absolute; left:-9999px;" alt="" /></div></noscript>
<!-- /Yandex.Metrika counter -->
`;
  return html.replace('</head>', `${snippet}</head>`);
}

// Админку не считаем: Вебвизору незачем записывать работу администратора.
const NO_METRIKA = new Set([path.join(PUBLIC_DIR, 'admin.html')]);

function staticFile(file) {
  let entry = staticCache.get(file);
  if (entry !== undefined) return entry;
  try {
    let body = fs.readFileSync(file);
    if (path.extname(file) === '.html' && !NO_METRIKA.has(file)) body = Buffer.from(withMetrika(body.toString('utf8')));
    entry = {
      body,
      type: MIME[path.extname(file)] || 'application/octet-stream',
      etag: `"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)}"`,
    };
  } catch {
    return null;   // отсутствие файла не кэшируем: иначе добавленный файл виден только после перезапуска
  }
  staticCache.set(file, entry);
  return entry;
}

function cacheFor(file) {
  return LONG_CACHE.has(path.extname(file)) ? 'public, max-age=86400' : 'no-cache';
}

function serveStatic(req, res, urlPath) {
  if (PAGE_ALIASES[urlPath]) {
    res.writeHead(301, { Location: PAGE_ALIASES[urlPath] });
    return res.end();
  }
  // Кто уже вошёл, приходит играть, а не читать о покере: с главной — сразу за столы.
  if (urlPath === '/' && sessionOf(req)) {
    res.writeHead(302, { Location: '/play', 'Cache-Control': 'no-store', Vary: 'Cookie' });
    return res.end();
  }
  // Статьи живут по чистым адресам: /articles/ и /articles/название.
  const article = /^\/articles(?:\/([a-z0-9-]+))?\/?$/.exec(urlPath);
  const rel = PAGES[urlPath] || (article ? `articles/${article[1] || 'index'}.html` : urlPath.replace(/^\/+/, ''));
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Доступ запрещён');

  const entry = staticFile(file);
  if (!entry) return send(res, 404, 'Страница не найдена');
  if (req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, { ETag: entry.etag, 'Cache-Control': cacheFor(file) });
    return res.end();
  }
  res.writeHead(200, {
    'Content-Type': entry.type,
    'Content-Length': entry.body.length,
    'Cache-Control': cacheFor(file),
    ETag: entry.etag,
    ...(urlPath === '/' ? { Vary: 'Cookie' } : {}),
  });
  res.end(entry.body);
}

// ——— сессии ———

const loginGuard = new LoginGuard();

// Настоящий адрес игрока. За nginx сокет всегда смотрит на петлю, а адрес
// приходит заголовком X-Real-IP; верим ему только от своего прокси.
function isDirectLocal(req) {
  const remote = req.socket.remoteAddress || '';
  return (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') && !req.headers['x-real-ip'];
}

function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const forwarded = req.headers['x-real-ip'];
  return local && forwarded ? String(forwarded) : remote;
}

function sessionOf(req) {
  const token = cookies(req).sid;
  const session = store.session(token);
  if (!session) return null;
  const user = store.user(session.userId);
  if (!user || store.isBanned(user)) return null;
  return { token, session, user };
}

// Простое ведро с токенами: один игрок не должен занимать сервер бесконечными
// командами. Обычная игра — единицы команд в секунду, лимит выше с запасом.
const CMD_RATE = 25;
const CMD_BURST = 50;

function allowCommand(session, now = Date.now()) {
  const last = session.rateAt || now;
  const tokens = Math.min(CMD_BURST, (session.tokens === undefined ? CMD_BURST : session.tokens)
    + ((now - last) / 1000) * CMD_RATE);
  session.rateAt = now;
  if (tokens < 1) { session.tokens = tokens; return false; }
  session.tokens = tokens - 1;
  return true;
}

function requireAuth(req, res) {
  const ctx = sessionOf(req);
  if (!ctx) { send(res, 401, { error: 'Нужно войти в аккаунт' }); return null; }
  seen(ctx.user.id);
  return ctx;
}

// Отмечаем активность игрока: по ней решаем, кто отошёл от стола.
function seen(userId) {
  const rec = presence.get(userId) || { conns: 0, lastSeen: 0 };
  rec.lastSeen = Date.now();
  presence.set(userId, rec);
}

function tableOfUser(userId) {
  return playerTable.get(userId) || null;
}

// ——— сводка по лобби ———
// Собирается один раз и уходит всем зрителям одной строкой: пересобирать её
// на каждого из тысяч наблюдателей нельзя.
let lobbyJson = '';
let lobbyFrame = '';
let lobbyAt = 0;
let lobbyVersion = 1;
const LOBBY_EVERY = 500;

function tableInfo(table) {
  const tour = table.tour;
  return {
    id: table.id,
    kind: tour ? 'sng' : 'cash',
    game: table.game || 'holdem',
    name: table.name,
    house: table.house,
    owner: table.ownerName,
    maxSeats: table.maxSeats,
    sb: table.sb,
    bb: table.bb,
    minBuyIn: table.minBuyIn,
    maxBuyIn: table.maxBuyIn,
    timeout: table.timeout,
    // Место за местом: 0 — свободно, 1 — человек, 2 — бот.
    seats: table.seats.map((p) => (!p ? 0 : p.isBot && !p.resident ? 2 : 1)),
    playing: table.phase !== 'idle',
    watchers: table.watchers || 0,
    sng: tour ? {
      status: tour.status,
      buyIn: tour.buyIn,
      stack: tour.stack,
      prizes: tour.prizes,
      level: tour.level + 1,
      left: table.occupied(),
      winner: tour.status === 'finished' && tour.places[0] ? tour.places[0].name : null,
      fillLeft: tour.fillAt ? Math.max(0, tour.fillAt - Date.now()) : 0,
      fillMs: table.fillMs || 0,
      spin: tour.spin,
      multiplier: tour.multiplier,
    } : null,
  };
}

// В лобби уходят не все столы, а самые живые: при тысячах столов список
// иначе весил бы сотни килобайт на каждое обновление. Столы заведения
// и турниры, где идёт регистрация, видны всегда.
function lobbyTables() {
  const rank = (t) => (t.house ? 3 : t.tour && t.tour.status === 'registering' ? 2 : 0) * 100 + t.humans();
  // Столы турниров по расписанию показываются в своём разделе, не в общем списке.
  const list = [...tables.values()].filter((t) => !t.private && !t.mttId);
  if (list.length > LOBBY_LIMIT) {
    list.sort((a, b) => rank(b) - rank(a));
    list.length = LOBBY_LIMIT;
    list.sort((a, b) => a.createdAt - b.createdAt);
  }
  return list.map(tableInfo);
}

function lobbyTotals() {
  let players = 0;
  let humans = 0;
  let playing = 0;
  for (const table of tables.values()) {
    players += table.occupied();
    humans += table.humans();
    if (table.phase !== 'idle') playing += 1;
  }
  return { tables: tables.size, players, humans, playing };
}

function lobbySnapshot(now = Date.now()) {
  if (lobbyJson && now - lobbyAt < LOBBY_EVERY) return lobbyJson;
  lobbyAt = now;
  const next = JSON.stringify({
    rooms: lobbyTables(),
    totals: lobbyTotals(),
    announcement: admin.getAnnouncement(),
    stakes: STAKES,
    sngBuyIns: SNG_BUY_INS,
    blindSteps: BLIND_STEPS,
    buyInSteps: BUY_IN_STEPS,
    mtts: mtts.overview(null),
  });
  if (next !== lobbyJson) {
    lobbyJson = next;
    lobbyFrame = `event: lobby\ndata: ${next}\n\n`;
    lobbyVersion += 1;
  }
  return lobbyJson;
}

// ——— приглашения ———

// Приватный стол видят хозяин, те, кто пришёл по ссылке, и друзья
// хозяина или сидящих за столом — к другу можно подсесть без ссылки.
function canEnter(user, session, table) {
  if (!table.private || table.ownerId === user.id) return true;
  if (session.invites && session.invites.has(table.id)) return true;
  if (user.friends.includes(table.ownerId)) return true;
  return table.players().some((p) => !p.isBot && user.friends.includes(p.userId));
}

// Что видно по ссылке ещё до входа: куда зовут и кто.
function inviteInfo(table) {
  const tour = table.tour;
  return {
    name: table.name,
    owner: table.ownerName,
    kind: tour ? 'sng' : 'cash',
    sb: table.sb,
    bb: table.bb,
    maxSeats: table.maxSeats,
    players: table.occupied(),
    sng: tour ? { status: tour.status, buyIn: tour.buyIn, prizes: tour.prizes } : null,
  };
}

const { escapeHtml } = pages;

// Страница ссылки-приглашения. Мессенджер по ней строит превью («Анна зовёт
// за стол…»), а человек сразу уходит в игру с кодом приглашения.
function invitePage(req, res, code) {
  const table = invites.get(code);
  const origin = `${SECURE_COOKIE ? 'https' : 'http'}://${req.headers.host}`;
  const go = table ? `/play?join=${encodeURIComponent(code)}` : '/play';
  let title = 'Стол уже закрыт — THPoker';
  let text = 'Этот стол закрылся. Заходите в THPoker — бесплатный покер без денег: столы открыты круглосуточно.';
  if (table) {
    const info = inviteInfo(table);
    const what = info.kind === 'sng'
      ? `sit-n-go на ${info.maxSeats}, взнос ${info.sng.buyIn}`
      : `блайнды ${info.sb}/${info.bb}, ${info.maxSeats} мест`;
    title = `${info.owner || 'Друг'} зовёт за стол «${info.name}» — THPoker`;
    text = `${what}. Бесплатный покер на виртуальные фишки прямо в браузере.`;
  }
  const html = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="robots" content="noindex">
<meta name="description" content="${escapeHtml(text)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="THPoker">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(text)}">
<meta property="og:image" content="${origin}/og.png">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0; url=${escapeHtml(go)}">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/favicon-120.png" sizes="120x120" type="image/png">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1317;color:#dfe7e6;font:16px system-ui,sans-serif}a{color:#c9a24a}</style>
</head><body><p><a href="${escapeHtml(go)}">Открыть стол в THPoker</a></p>
<script>location.replace(${JSON.stringify(go)});</script></body></html>`;
  res.writeHead(table ? 200 : 404, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

// Свои столы — с приглашениями: их удобно открыть заново и позвать друзей.
function tablesOf(user) {
  const out = [];
  for (const t of tables.values()) {
    if (t.ownerId !== user.id) continue;
    out.push({ id: t.id, invite: t.invite, private: t.private, closable: !closeBlock(t, user), ...inviteInfo(t) });
  }
  return out;
}

// Почему хозяин не может закрыть стол (или null, если может): за ним играют
// другие люди, идёт турнир или на sit-n-go уже кто-то записался.
function closeBlock(table, user) {
  if (table.ownerId !== user.id) return 'Закрыть стол может только тот, кто его открыл';
  if (table.mttId || table.house) return 'Этот стол закрыть нельзя';
  if (table.tour && table.tour.status === 'running') return 'Идёт турнир — стол закроется сам, когда он закончится';
  if (!idleFor(table, user)) return 'За столом играют другие — закрыть его можно, когда они уйдут';
  return null;
}

// Закрыть свой стол: фишки хозяина — в банк (по тем же правилам, что при перезапуске),
// боты — со стола, зрители — в лобби (стола больше нет).
function closeOwnTable(table, user) {
  const why = closeBlock(table, user);
  if (why) return { error: why };
  for (const r of refunds(tableRecord(table))) store.addChips(r.userId, r.amount, `Стол «${table.name}» закрыт`);
  for (const p of table.players()) {
    table.seats[p.seat] = null;
    table.byUserId.delete(p.userId);
    table.onUnseat(p, table);
  }
  dropTable(table);
  saveSnapshot();
  return { ok: true };
}

// ——— кабинет, друзья, рейтинг ———

function isOnline(userId) {
  // Резидент «в сети», пока сидит за столом и ещё немного после.
  if (store.isBotUser(store.user(userId))) {
    const r = residentByUser.get(userId);
    return !!tableOfUser(userId) || !!(r && Date.now() < (r.onlineUntil || 0));
  }
  const rec = presence.get(userId);
  return !!(rec && rec.conns > 0);
}

// Где сейчас игрок: за каким столом сидит. Нужно, чтобы друг мог подсесть.
function whereIs(userId) {
  let table = tableOfUser(userId);
  if (table && !tables.has(table.id)) { playerTable.delete(userId); table = null; }
  return table ? { id: table.id, name: table.name, kind: table.tour ? 'sng' : 'cash' } : null;
}

function friendView(id) {
  const u = store.user(id);
  if (!u) return null;
  return { name: u.name, avatar: store.avatarUrl(u), chips: u.chips, online: isOnline(id), table: whereIs(id) };
}

// Друзья онлайн — наверх, дальше по имени.
function sortedViews(ids) {
  return ids.map(friendView).filter(Boolean)
    .sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name, 'ru'));
}

// Друзья и заявки: входящие ждут ответа, исходящие — ответа от другого.
function friendsOf(user) {
  return {
    friends: sortedViews(user.friends),
    incoming: sortedViews(user.friendsIn),
    outgoing: sortedViews(user.friendsOut),
  };
}

function profileOf(target, viewer) {
  const own = target.id === viewer.id;
  const s = target.stats;
  return {
    name: target.name,
    own,
    createdAt: target.createdAt,
    chips: target.chips,
    online: isOnline(target.id),
    table: whereIs(target.id),
    relation: own ? null : store.relation(viewer, target),
    avatar: store.avatarUrl(target),
    season: seasons.view(target),
    stats: {
      handsPlayed: target.handsPlayed,
      handsWon: s.handsWon,
      handsLost: s.handsLost,
      showdowns: s.showdowns,
      showdownsWon: s.showdownsWon,
      allInsWon: s.allInsWon,
      biggestPot: s.biggestPot,
      cashNet: s.cashNet,
      bestHand: s.bestHand ? { name: s.bestHand.name, cards: s.bestHand.cards } : null,
      sngPlayed: s.sngPlayed,
      sngCashes: s.sngCashes,
      sngWins: s.sngWins,
      sngPrizes: s.sngPrizes,
      peakChips: s.peakChips,
    },
    level: store.levelOf(target),
    achievements: ACHIEVEMENTS.map((a) => achievementView(a, target)),
    tiers: { got: tierTotal(target), of: ACHIEVEMENTS.reduce((sum, a) => sum + a.tiers.length, 0) },
    friends: own ? friendsOf(target) : null,
  };
}

// ——— команды за столом ———

async function handleCommand(ctx, body) {
  const { session, user } = ctx;
  const cmd = body.cmd;
  const room = () => tables.get(session.roomId);

  switch (cmd) {
    case 'enterRoom': {
      session.awayFrom = null;
      const seated = tableOfUser(user.id);
      if (seated) { session.roomId = seated.id; return { ok: true, roomId: seated.id }; }
      const table = tables.get(String(body.roomId));
      if (!table) return { error: 'Стол уже закрыт' };
      if (!canEnter(user, session, table)) return { error: 'Это приватный стол — попасть за него можно по ссылке-приглашению' };
      session.roomId = table.id;
      return { ok: true, roomId: table.id };
    }
    case 'join': {
      // Вход по ссылке-приглашению: код открывает и приватный стол.
      const table = invites.get(String(body.code || ''));
      if (!table) return { error: 'Стол по этой ссылке уже закрыт' };
      session.invites = session.invites || new Set();
      session.invites.add(table.id);
      const seated = tableOfUser(user.id);
      if (seated && seated !== table) {
        session.roomId = seated.id;
        return { error: 'Вы сидите за другим столом — встаньте из-за него, чтобы перейти по приглашению' };
      }
      session.roomId = table.id;
      return { ok: true, roomId: table.id };
    }
    case 'quickPlay':
      return quickPlay(user, session);
    case 'quickSng':
      return quickSng(user, session, {
        buyIn: Number(body.buyIn) || 0, spin: !!body.spin, seats: Number(body.seats) || 0, name: body.name,
        game: body.game === 'omaha' && !body.spin ? 'omaha' : 'holdem',
      });
    case 'createTable': {
      const seated = tableOfUser(user.id);
      if (seated) return { error: 'Сначала встаньте из-за текущего стола' };
      const table = createUserTable(user, body);
      if (table.error) return table;
      session.roomId = table.id;
      return { ok: true, roomId: table.id };
    }
    case 'closeTable': {
      const table = tables.get(String(body.id || session.roomId));
      if (!table) return { error: 'Стол уже закрыт' };
      const res = closeOwnTable(table, user);
      if (res.ok && session.roomId === table.id) session.roomId = null;
      return res;
    }
    case 'leaveRoom': {
      const table = room();
      // Из идущего турнира в лобби уходят «отошедшим»: место остаётся за игроком.
      // Запоминаем это, чтобы поток не вернул его к столу сам (см. pushTo).
      if (table && table.byUser(user.id)) {
        table.leave(user.id);
        if (table.byUser(user.id)) session.awayFrom = table.id;
      }
      session.roomId = null;
      return { ok: true, away: session.awayFrom && tables.get(session.awayFrom) ? { id: session.awayFrom, name: tables.get(session.awayFrom).name } : null };
    }
    case 'sit': {
      const table = room();
      if (!table) return { error: 'Сначала войдите в комнату' };
      if (tableOfUser(user.id) && tableOfUser(user.id) !== table) return { error: 'Вы уже сидите за другим столом' };
      // В турнире платят взнос, а играют турнирным стеком. Место можно не выбирать.
      return seatUser(user, table, Math.round(Number(body.buyIn) || 0), Number(body.seat));
    }
    case 'standUp': {
      const table = room();
      if (!table) return { error: 'Вы не за столом' };
      // Из идущего турнира — только сдавшись: турнирные фишки сгорают.
      return body.forfeit ? table.forfeit(user.id) : table.leave(user.id);
    }
    case 'act': {
      const table = room();
      if (!table) return { error: 'Вы не за столом' };
      return table.act(user.id, String(body.action), body.amount);
    }
    case 'prefs': {
      // Выключенный силомер экономит серверу перебор рук соперника.
      session.meter = body.meter !== false;
      return { ok: true };
    }
    case 'reveal': {
      const table = room();
      if (!table) return { error: 'Вы не за столом' };
      return table.playerReveal(user.id, !!body.show);
    }
    case 'sitOut': {
      const table = room();
      if (!table) return { error: 'Вы не за столом' };
      return table.setSittingOut(user.id, !!body.value);
    }
    case 'topUp': {
      const table = room();
      if (!table) return { error: 'Вы не за столом' };
      const seat = table.byUser(user.id);
      if (!seat) return { error: 'Вы не за столом' };
      if (table.tour) return { error: 'В турнире докупать нельзя' };
      const fresh = store.user(user.id);
      const amount = Math.min(Math.round(Number(body.amount) || 0), fresh.chips);
      if (amount <= 0) return { error: 'В банке нет фишек' };
      const res = table.addChips(user.id, amount);
      if (res.error) return res;
      store.addChips(user.id, -amount, `Докупка за стол «${table.name}»`);
      return { ok: true, pending: !!res.pending };
    }
    case 'addBot': {
      const table = room();
      if (!table) return { error: 'Сначала войдите в комнату' };
      if (table.tour && table.tour.status !== 'registering') return { error: 'Турнир уже идёт' };
      return addBotTo(table);
    }
    case 'kickBot': {
      const table = room();
      if (!table) return { error: 'Сначала войдите в комнату' };
      const p = table.bySeat(Number(body.seat));
      if (!p || !p.isBot || p.resident) return { error: 'На этом месте не бот' };
      if (table.tour && table.tour.status !== 'registering') return { error: 'Из турнира бота не убрать' };
      if (p.inHand && table.phase !== 'idle') { p.leaving = true; return { ok: true, pending: true }; }
      return table.removePlayer(p);
    }
    case 'react': {
      const table = room();
      if (!table) return { error: 'Сначала сядьте за стол' };
      return table.react(user.id, String(body.text || ''));
    }
    case 'chat': {
      const table = room();
      if (!table) return { error: 'Сначала войдите в комнату' };
      const text = String(body.text || '').trim().slice(0, 140);
      if (text) table.chat(user.name, text);
      return { ok: true };
    }
    case 'reload':
      return store.reload(user.id);
    case 'mttRegister': {
      const mtt = mtts.get(String(body.id));
      if (!mtt) return { error: 'Турнир не найден' };
      const res = mtt.register({ userId: user.id, name: user.name }, store.user(user.id).chips);
      if (res.pay) store.addChips(user.id, -res.pay, `Взнос: ${mtt.name}`);
      return res.error ? res : { ok: true };
    }
    case 'mttUnregister': {
      const mtt = mtts.get(String(body.id));
      if (!mtt) return { error: 'Турнир не найден' };
      return mtt.unregister(user.id);
    }
    case 'mttWatch': {
      // Смотреть идущий турнир — за самым полным его столом.
      const mtt = mtts.get(String(body.id));
      const info = mtt && mtt.info();
      if (!info || !info.watch) return { error: 'Сейчас смотреть нечего' };
      if (!tableOfUser(user.id)) session.roomId = info.watch;
      return { ok: true, roomId: session.roomId };
    }
    case 'claimBonus':
      return store.claimBonus(user.id);
    case 'claimQuest':
      return store.claimQuest(user.id, body.id);
    case 'callFriend':
      return callFriend(user, body.name);
    case 'shareHand':
      return store.shareHand(user.id, body.id);
    case 'claimWeekly':
      return store.claimWeekly(user.id, body.id);
    case 'claimChest':
      return store.claimChest(user.id);
    case 'shopBuy':
    case 'shopEquip': {
      const res = cmd === 'shopBuy' ? store.buyItem(user.id, body.id) : store.equipItem(user.id, body.id);
      if (res.ok && res.item.kind === 'frame') refreshSeatAvatar(user.id);
      return res;
    }
    case 'addFriend': {
      const res = store.addFriend(user.id, body.name);
      const other = store.byNameLower(body.name);
      if (res.status === 'out' && other) notify(other.id, `${user.name} хочет добавить вас в друзья в THPoker.`);
      if (res.status === 'friend' && other) notify(other.id, `${user.name} теперь у вас в друзьях.`);
      return res;
    }
    case 'acceptFriend': {
      const res = store.acceptFriend(user.id, body.name);
      const other = store.byNameLower(body.name);
      if (res.ok && other) notify(other.id, `${user.name} принял(а) вашу заявку в друзья.`);
      return res;
    }
    case 'declineFriend':
      return store.declineFriend(user.id, body.name);
    case 'removeFriend':
      return store.removeFriend(user.id, body.name);
    default:
      return { error: 'Неизвестная команда' };
  }
}

// ——— вход через VK ———

const VK_CLIENT_ID = process.env.VK_CLIENT_ID || '';
const vk = VK_CLIENT_ID
  ? createVk({ clientId: VK_CLIENT_ID, redirectUri: process.env.VK_REDIRECT_URI || `${APP_URL}/auth/vk/callback` })
  : null;

function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

// /auth/vk — уходим в VK (link=1 — привязать к тому, кто уже вошёл);
// /auth/vk/callback — VK вернул игрока: входим, создаём аккаунт или привязываем.
// Ответ — переход обратно в игру, итог — в адресе (?vk=new|linked, ?vkError=…).
async function vkRoute(req, res, route, url) {
  const back = (q) => redirect(res, `/play?${new URLSearchParams(q)}`);
  if (!vk) return back({ vkError: 'Вход через VK не настроен' });
  if (route === '/auth/vk') {
    const ctx = url.searchParams.get('link') ? sessionOf(req) : null;
    return redirect(res, vk.start({
      linkUserId: ctx ? ctx.user.id : null,
      source: String(url.searchParams.get('source') || '').slice(0, 40) || null,
      friend: String(url.searchParams.get('friend') || '').slice(0, 40) || null,
    }));
  }
  const q = Object.fromEntries(url.searchParams);
  if (q.error) return back({ vkError: 'Вход через VK отменён' });
  const result = await vk.finish(q);
  if (result.error) return back({ vkError: result.error });
  const { linkUserId, source, friend } = result.extra;
  if (linkUserId) {
    const linked = store.linkVk(linkUserId, result.vk);
    if (!linked.error) renameSeated(linkUserId);
    return back(linked.error ? { vkError: linked.error } : { vk: 'linked' });
  }
  const { user, created, error } = store.vkUser(result.vk, source, friend);
  if (error) return back({ vkError: error });
  const token = store.createSession(user.id);
  console.log(`Вход через VK: ${user.name}${created ? ' (новый)' : ''}`);
  return redirect(res, `/play${created ? '?vk=new' : ''}`, { 'Set-Cookie': sessionCookie(token) });
}

// ——— маршруты ———

const MONEY_CMDS = new Set(['sit', 'standUp', 'leaveRoom', 'topUp', 'createTable', 'addBot', 'kickBot', 'mttRegister', 'mttUnregister']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = url.pathname;

  if ((req.method === 'GET' || req.method === 'HEAD') && route.startsWith('/t/')) {
    return invitePage(req, res, decodeURIComponent(route.slice(3)).replace(/\/$/, ''));
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && route.startsWith('/avatars/')) {
    return serveAvatar(req, res, route.slice('/avatars/'.length));
  }
  if (req.method === 'GET' && (route === '/auth/vk' || route === '/auth/vk/callback')) {
    return vkRoute(req, res, route, url);
  }

  // Публичный профиль игрока — со своим превью для соцсетей.
  if ((req.method === 'GET' || req.method === 'HEAD') && route.startsWith('/u/')) {
    const user = store.byNameLower(decodeURIComponent(route.slice(3)).replace(/\/$/, ''));
    if (!user || store.isBanned(user)) return send(res, 404, 'Игрок не найден');
    const origin = `${SECURE_COOKIE ? 'https' : 'http'}://${req.headers.host}`;
    const html = withMetrika(pages.profilePage(user, origin, store.avatarUrl(user)));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'no-cache' });
    return res.end(html);
  }
  // Раздача, которой поделились: страница повтора, со своим превью для мессенджеров.
  if ((req.method === 'GET' || req.method === 'HEAD') && route.startsWith('/h/')) {
    const code = decodeURIComponent(route.slice(3)).replace(/\/$/, '');
    const hand = store.sharedHand(code);
    if (!hand) return send(res, 404, 'Раздача не найдена');
    const html = withMetrika(handPage(hand, `${SECURE_COOKIE ? 'https' : 'http'}://${req.headers.host}`, code));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'no-cache' });
    return res.end(html);
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && !route.startsWith('/api/')) return serveStatic(req, res, route);

  try {
    if (await admin.handle(req, res, route, url)) return;

    if (route === '/api/register' && req.method === 'POST') {
      const ip = clientIp(req);
      // Прямой запрос с самой машины (без nginx) — это нагрузочный тест или администратор.
      const wait = isDirectLocal(req) ? 0 : loginGuard.canRegister(ip);
      if (wait) return send(res, 429, { error: `С этого адреса уже много новых аккаунтов. Попробуйте через ${waitText(wait)}` });
      const body = await readBody(req);
      const { user, error } = await store.register(body.name, body.password, body.source, body.friend);
      if (error) return send(res, 400, { error });
      loginGuard.registered(ip);
      const token = store.createSession(user.id);
      return send(res, 200, { user: store.publicUser(user.id) }, { 'Set-Cookie': sessionCookie(token) });
    }

    // «Играть гостем» — без имени и пароля; ограничение — как у регистрации.
    if (route === '/api/guest' && req.method === 'POST') {
      const ip = clientIp(req);
      const wait = isDirectLocal(req) ? 0 : loginGuard.canRegister(ip);
      if (wait) return send(res, 429, { error: `С этого адреса уже много новых аккаунтов. Попробуйте через ${waitText(wait)}` });
      const body = await readBody(req);
      const { user } = store.createGuest(body.source, body.friend);
      loginGuard.registered(ip);
      const token = store.createSession(user.id);
      return send(res, 200, { user: store.publicUser(user.id) }, { 'Set-Cookie': sessionCookie(token) });
    }

    // Гость сохраняет аккаунт: имя и пароль. Новое имя видно и за столом.
    if (route === '/api/guest/save' && req.method === 'POST') {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      const body = await readBody(req);
      const result = await store.saveGuest(ctx.user.id, body.name, body.password);
      if (result.error) return send(res, 400, result);
      renameSeated(ctx.user.id);
      return send(res, 200, { ok: true, user: store.publicUser(ctx.user.id) });
    }

    if (route === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      const ip = clientIp(req);
      const name = String(body.name || '').trim().toLowerCase();
      const wait = loginGuard.check(ip, name);
      if (wait) return send(res, 429, { error: `Слишком много неудачных попыток. Попробуйте через ${waitText(wait)}` });
      const { user, error } = await store.login(body.name, body.password);
      if (error) { loginGuard.failed(ip, name); return send(res, 400, { error }); }
      loginGuard.succeeded(ip, name);
      const token = store.createSession(user.id);
      return send(res, 200, { user: store.publicUser(user.id) }, { 'Set-Cookie': sessionCookie(token) });
    }

    if (route === '/api/config' && req.method === 'GET') {
      return send(res, 200, {
        telegramBot: TG_LOGIN && bot && bot.username ? bot.username : null,
        telegramLogin: TG_LOGIN,
        vkLogin: !!vk,
        reactions: REACTIONS,
        phrases: PHRASES,
        botDisclaimer: BOT_DISCLAIMER,
        metrika: METRIKA_ID || null,
        shop: SHOP_CATALOG,
      });
    }

    // Вход через Telegram: виджет на сайте присылает data, Mini App — initData.
    if (route === '/api/telegram/login' && req.method === 'POST') {
      const body = await readBody(req);
      const tg = telegramIdentity(body);
      if (!tg) return send(res, 400, { error: 'Telegram не подтвердил вход — попробуйте ещё раз' });
      const { user, created, error } = store.telegramUser(tg, body.source, body.friend);
      if (error) return send(res, 403, { error });
      const token = store.createSession(user.id);
      return send(res, 200, { user: store.publicUser(user.id), created }, { 'Set-Cookie': sessionCookie(token) });
    }

    // Вебхук: Telegram присылает сообщение, ответ уходит прямо в теле ответа —
    // так бот отвечает, даже когда сервер не может сам достучаться до Telegram.
    if (route === '/api/telegram/webhook' && req.method === 'POST') {
      const secret = req.headers['x-telegram-bot-api-secret-token'] || '';
      if (!bot || !TG_WEBHOOK_SECRET || !crypto.timingSafeEqual(
        crypto.createHash('sha256').update(secret).digest(),
        crypto.createHash('sha256').update(TG_WEBHOOK_SECRET).digest(),
      )) return send(res, 403, { error: 'Нет доступа' });
      const answer = bot.reply(await readBody(req));
      return send(res, 200, answer || {});
    }

    if (route === '/api/telegram/link' && req.method === 'POST') {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      const body = await readBody(req);
      const tg = telegramIdentity(body);
      if (!tg) return send(res, 400, { error: 'Telegram не подтвердил привязку — попробуйте ещё раз' });
      const result = store.linkTelegram(ctx.user.id, tg);
      if (result.error) return send(res, 400, result);
      return send(res, 200, { ok: true, user: store.publicUser(ctx.user.id) });
    }

    if (route === '/api/logout' && req.method === 'POST') {
      const ctx = sessionOf(req);
      if (ctx) {
        const table = tableOfUser(ctx.user.id);
        if (table) table.leave(ctx.user.id);
        store.destroySession(ctx.token);
      }
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' });
    }

    if (route === '/api/me' && req.method === 'GET') {
      const ctx = sessionOf(req);
      if (!ctx) return send(res, 200, { user: null });
      return send(res, 200, {
        user: store.publicUser(ctx.user.id),
        admin: admin.isAdmin(ctx.user),
        roomId: ctx.session.roomId || (ctx.session.awayFrom ? null : (tableOfUser(ctx.user.id) || {}).id) || null,
        // Ушёл из идущего турнира в лобби — клиент покажет «вернуться к столу».
        away: (() => {
          const t = ctx.session.awayFrom && tableOfUser(ctx.user.id);
          return t && t.id === ctx.session.awayFrom ? { id: t.id, name: t.name } : null;
        })(),
        leaderboard: store.leaderboard(),
      });
    }

    if (route === '/api/health' && req.method === 'GET') {
      let seated = 0;
      let active = 0;
      for (const table of tables.values()) {
        seated += table.occupied();
        if (table.phase !== 'idle') active += 1;
      }
      const mem = process.memoryUsage();
      const cpu = process.cpuUsage();
      return send(res, 200, {
        cpuMs: Math.round((cpu.user + cpu.system) / 1000),
        uptimeSec: Math.round((Date.now() - metrics.startedAt) / 1000),
        clients: clients.size,
        users: store.users.size,
        sessions: store.sessions.size,
        pendingWrites: store.stats().pendingWrites,
        tables: tables.size,
        tablesActive: active,
        seated,
        lagMs: lagStats(),
        pushedFrames: metrics.pushedFrames,
        pushedBytes: metrics.pushedBytes,
        serialized: metrics.serialized,
        skipped: metrics.skipped,
        rssMb: Math.round(mem.rss / 1048576),
        heapMb: Math.round(mem.heapUsed / 1048576),
      });
    }

    // История фишек: за что начислялось и списывалось, свежие сверху.
    if (route === '/api/chips-log' && req.method === 'GET') {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      // Чужая история — по имени из профиля; что именно написал администратор, видно только владельцу.
      const name = url.searchParams.get('name');
      const who = name ? store.byNameLower(name) : ctx.user;
      if (!who) return send(res, 404, { error: 'Игрок не найден' });
      let entries = store.chipLog(who.id, limit);
      if (who.id !== ctx.user.id) entries = entries.map((e) => (e.reason.startsWith('Администратор') ? { ...e, reason: 'Администратор' } : e));
      return send(res, 200, { entries });
    }

    // История раздач: список своих последних, одна своя целиком, чужая — по коду ссылки.
    if (route === '/api/hands' && req.method === 'GET') {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      return send(res, 200, { hands: store.recentHands(ctx.user.id) });
    }
    if (route === '/api/hand' && req.method === 'GET') {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      const hand = store.handFor(ctx.user.id, url.searchParams.get('id'));
      return hand ? send(res, 200, { hand }) : send(res, 404, { error: 'Раздача не найдена' });
    }
    if (route === '/api/shared-hand' && req.method === 'GET') {
      const hand = store.sharedHand(url.searchParams.get('code'));
      return hand ? send(res, 200, { hand }) : send(res, 404, { error: 'Раздача не найдена' });
    }

    if (route === '/api/profile' && req.method === 'GET') {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      const name = url.searchParams.get('name');
      const target = name ? store.byNameLower(name) : ctx.user;
      if (!target) return send(res, 404, { error: 'Игрок не найден' });
      return send(res, 200, profileOf(target, ctx.user));
    }

    if (route === '/api/friends' && req.method === 'GET') {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      return send(res, 200, { ...friendsOf(ctx.user), tables: tablesOf(ctx.user) });
    }

    if (route === '/api/rating' && req.method === 'GET') {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      return send(res, 200, store.rating(url.searchParams.get('by') || 'chips', ctx.user.id));
    }

    if (route === '/api/avatar' && req.method === 'POST') {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      if (!allowCommand(ctx.session)) return send(res, 429, { error: 'Слишком часто. Подождите секунду' });
      const body = await readRaw(req, AVATAR_MAX);
      const ext = imageKind(body);
      if (!ext) return send(res, 400, { error: 'Нужна картинка JPEG, PNG или WebP' });
      fs.mkdirSync(AVATAR_DIR, { recursive: true });
      const target = path.join(AVATAR_DIR, `${ctx.user.id}.${ext}`);
      fs.writeFileSync(`${target}.tmp`, body);
      fs.renameSync(`${target}.tmp`, target);
      const old = ctx.user.meta.avatar;
      if (old && old.ext !== ext) dropAvatarFile(ctx.user.id, old.ext);
      store.setAvatar(ctx.user.id, ext);
      refreshSeatAvatar(ctx.user.id);
      pushAll();
      return send(res, 200, { ok: true, user: store.publicUser(ctx.user.id) });
    }

    // Готовый аватар из набора — вместо своего фото.
    if (route === '/api/avatar/stock' && req.method === 'POST') {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      if (!allowCommand(ctx.session)) return send(res, 429, { error: 'Слишком часто. Подождите секунду' });
      const body = await readBody(req);
      const result = store.setStockAvatar(ctx.user.id, String(body.id || ''));
      if (result.error) return send(res, 400, result);
      if (result.old) dropAvatarFile(ctx.user.id, result.old.ext);
      refreshSeatAvatar(ctx.user.id);
      pushAll();
      return send(res, 200, { ok: true, user: store.publicUser(ctx.user.id) });
    }

    if (route === '/api/avatar/remove' && req.method === 'POST') {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      const old = store.removeAvatar(ctx.user.id);
      if (old && old.ext) dropAvatarFile(ctx.user.id, old.ext);
      refreshSeatAvatar(ctx.user.id);
      pushAll();
      return send(res, 200, { ok: true, user: store.publicUser(ctx.user.id) });
    }

    if (route === '/api/mtt' && req.method === 'GET') {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      return send(res, 200, { list: mtts.overview(ctx.user.id), now: Date.now() });
    }

    if (route === '/api/invite' && req.method === 'GET') {
      const table = invites.get(url.searchParams.get('code') || '');
      if (!table) return send(res, 404, { error: 'Стол по этой ссылке уже закрыт' });
      return send(res, 200, inviteInfo(table));
    }

    if (route === '/api/rooms' && req.method === 'GET') {
      return send(res, 200, JSON.parse(lobbySnapshot()));
    }

    if (route === '/api/cmd' && req.method === 'POST') {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      if (!allowCommand(ctx.session)) return send(res, 429, { error: 'Слишком часто. Подождите секунду' });
      const body = await readBody(req);
      const result = await handleCommand(ctx, body);
      // Команды, которые двигают фишки между банком и столом, сразу попадают в снимок.
      if (MONEY_CMDS.has(body.cmd) && !result.error) saveSnapshot();
      pushAll();
      if (result.error) return send(res, 400, result);
      return send(res, 200, { ...result, user: store.publicUser(ctx.user.id) });
    }

    if (route === '/api/stream' && req.method === 'GET') {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      return openStream(req, res, ctx);
    }

    return send(res, 404, { error: 'Такого адреса нет' });
  } catch (err) {
    return send(res, 400, { error: err.message || 'Ошибка запроса' });
  }
});

function sessionCookie(token) {
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax${SECURE_COOKIE ? '; Secure' : ''}`
    + `; Max-Age=${60 * 60 * 24 * 30}`;
}

// ——— админка ———

// Резиденты в админке: настройки поведения по схеме и состав (ник, уровень, выключен).
function residentsView() {
  const roster = residentsCfg.roster();
  const now = Date.now();
  return {
    schema: residentsCfg.schema,
    levels: residentsCfg.levels,
    levelNames: residentsCfg.levelNames,
    settings: RS,
    list: RESIDENT_LIST.map((base) => {
      const r = residents.get(base.key);
      const u = r && store.user(r.userId);
      const t = r && tableOfUser(r.userId);
      const mtt = r && [...mtts.list.values()].find((m) => m.status === 'registering' && m.entries.has(r.userId));
      const own = roster[base.key] || {};
      return {
        key: base.key,
        baseName: base.name,
        baseStyle: base.style,
        name: u ? u.name : (own.name || base.name),
        style: own.style || base.style,
        off: !!own.off,
        avatar: u ? store.avatarUrl(u) : null,
        chips: u ? u.chips : 0,
        hands: u ? u.handsPlayed : 0,
        conflict: !u,
        nameTaken: !!(u && own.name && u.name !== own.name),   // желаемый ник занят живым игроком
        table: t ? t.name : null,
        restLeft: r && !t && r.restUntil > now ? r.restUntil - now : 0,
        mtt: mtt ? mtt.name : null,
      };
    }),
  };
}

async function adminResidents(req, res, ctx) {
  if (req.method === 'GET') { send(res, 200, residentsView()); return true; }
  if (req.method !== 'POST') return false;
  const body = await readBody(req);
  const by = ctx.user.name;
  let errors = [];
  if (body.action === 'settings') {
    errors = residentsCfg.update(body.settings || {});
    console.log(`Админ ${by}: изменены настройки резидентов`);
  } else if (body.action === 'reset') {
    residentsCfg.reset();
    console.log(`Админ ${by}: настройки резидентов сброшены`);
  } else if (body.action === 'roster') {
    residentsCfg.setRoster(body.roster || {});
    applyRoster();
    lobbyAt = 0;
    console.log(`Админ ${by}: изменён состав резидентов`);
  } else {
    send(res, 400, { error: 'Неизвестное действие' });
    return true;
  }
  send(res, 200, { ok: true, errors, ...residentsView() });
  return true;
}

const admin = createAdmin({
  // Убрать неприемлемый аватар — файл тоже удаляется.
  removeAvatar: (userId) => {
    const old = store.removeAvatar(userId);
    if (old && old.ext) dropAvatarFile(userId, old.ext);
    refreshSeatAvatar(userId);
    return !!old;
  },
  store,
  tables,
  handsByDay,
  send,
  readBody,
  requireAuth,
  tableOfUser,
  isOnline,
  dropTable,
  saveSnapshot: () => saveSnapshot(),
  pushAll: () => pushAll(),
  reopenHouse: (id) => {
    const cfg = ROOM_CONFIGS.find((c) => c.id === id);
    if (cfg) createTable(cfg);
  },
  // Заблокированного выкидываем из потока: следующий запрос он уже не пройдёт.
  dropStreams: (userId) => {
    for (const client of clients) {
      if (client.ctx.user.id !== userId) continue;
      try { client.res.end(); } catch { /* уже закрыт */ }
      clients.delete(client);
    }
  },
  onlineCount: () => {
    let n = 0;
    for (const rec of presence.values()) if (rec.conns > 0) n += 1;
    return n;
  },
  serverStats: () => {
    let seated = 0;
    for (const t of tables.values()) seated += t.humans();
    const mem = process.memoryUsage();
    return {
      uptimeSec: Math.round((Date.now() - metrics.startedAt) / 1000),
      connections: clients.size,
      tables: tables.size,
      seated,
      lagMs: lagStats(),
      rssMb: Math.round(mem.rss / 1048576),
      storage: store.stats().storage,
    };
  },
  // Объявление уходит в лобби — пересобираем его сводку сразу.
  announcementChanged: () => { lobbyAt = 0; pushAll(); },
  // Турниры по расписанию: список, разовый турнир, старт сейчас, отмена, боты для проверки.
  extra: async (req, res, route, url, ctx) => {
    if (route === '/api/admin/residents') return adminResidents(req, res, ctx);
    if (route === '/api/admin/mtt' && req.method === 'GET') {
      send(res, 200, { list: [...mtts.list.values()].sort((a, b) => a.startAt - b.startAt).map((m) => m.info()) });
      return true;
    }
    if (route !== '/api/admin/mtt' || req.method !== 'POST') return false;
    const body = await readBody(req);
    const by = ctx.user.name;
    if (body.action === 'create') {
      const name = String(body.name || '').trim().slice(0, 40);
      const startAt = Number(body.startAt);
      const buyIn = Math.max(0, Math.round(Number(body.buyIn) || 0));
      const guarantee = Math.max(0, Math.round(Number(body.guarantee) || 0));
      if (!name) { send(res, 400, { error: 'Нужно название' }); return true; }
      if (!Number.isFinite(startAt) || startAt < Date.now() + 60_000) { send(res, 400, { error: 'Старт — не раньше чем через минуту' }); return true; }
      const mtt = mtts.create({ name, startAt, buyIn, guarantee });
      console.log(`Админ ${by}: создан турнир «${name}» на ${new Date(startAt).toISOString()}`);
      send(res, 200, { ok: true, id: mtt.id });
      return true;
    }
    const mtt = mtts.get(String(body.id));
    if (!mtt) { send(res, 404, { error: 'Турнир не найден' }); return true; }
    if (body.action === 'cancel') {
      if (mtt.status !== 'registering' && mtt.status !== 'running') { send(res, 400, { error: 'Турнир уже закончился' }); return true; }
      mtt.cancel('отменён администратором');
      console.log(`Админ ${by}: отменён турнир «${mtt.name}»`);
    } else if (body.action === 'start') {
      if (mtt.status !== 'registering') { send(res, 400, { error: 'Турнир уже идёт' }); return true; }
      if (mtt.entries.size < 2) { send(res, 400, { error: 'Нужно хотя бы два участника' }); return true; }
      mtt.startAt = Date.now();
      mtts.tick();
    } else if (body.action === 'bots') {
      if (mtt.status !== 'registering') { send(res, 400, { error: 'Регистрация закрыта' }); return true; }
      mtt.addBots(Math.min(50, Math.max(1, Number(body.count) || 5)));
    } else {
      send(res, 400, { error: 'Неизвестное действие' });
      return true;
    }
    saveSnapshot();
    pushAll();
    send(res, 200, { ok: true });
    return true;
  },
});

// ——— поток событий ———

function openStream(req, res, ctx) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': поток открыт\n\n');

  const client = { res, ctx, lastTable: -1, lastLobby: 0, lastUserVersion: -1, lastRoom: undefined, lastLogId: 0 };
  clients.add(client);

  store.markActive(ctx.user);
  const p = presence.get(ctx.user.id) || { conns: 0, lastSeen: Date.now() };
  p.conns += 1;
  p.lastSeen = Date.now();
  presence.set(ctx.user.id, p);

  pushTo(client, true);

  req.on('close', () => {
    clients.delete(client);
    const rec = presence.get(ctx.user.id);
    if (rec) { rec.conns -= 1; rec.lastSeen = Date.now(); }
  });
}

function emit(client, event, data) {
  emitRaw(client, `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

// Готовая строка события пишется как есть: одна и та же уходит тысячам соединений.
// Если клиент не успевает читать, пропускаем кадр: состояние всё равно
// придёт целиком следующим, а буфер сокета не разрастётся.
function emitRaw(client, frame) {
  if (client.slow) { metrics.skipped += 1; return false; }
  metrics.pushedFrames += 1;
  metrics.pushedBytes += frame.length;
  try {
    if (client.res.write(frame) === false) {
      client.slow = true;
      client.res.once('drain', () => { client.slow = false; });
    }
    return true;
  } catch {
    clients.delete(client);
    return false;
  }
}

function pushTo(client, force = false) {
  const { session, user } = client.ctx;

  // Состояние игрока меняется редко — сравниваем версию, а не собранный JSON.
  const version = store.userVersion(user.id);
  if (version < 0) return;
  if (force || version !== client.lastUserVersion) {
    client.lastUserVersion = version;
    emitRaw(client, store.publicUserFrame(user.id));
  }

  // Турнир по расписанию сам сажает и пересаживает игрока: экран идёт за ним.
  const seatedAt = playerTable.get(user.id);
  if (seatedAt && seatedAt.mttId && session.followTable !== seatedAt.id) {
    session.followTable = seatedAt.id;
    session.roomId = seatedAt.id;
  }
  // Сидит за столом, а сессия о нём не знает (например, после перезапуска сервера) — к столу.
  if (seatedAt && !session.roomId && session.awayFrom !== seatedAt.id) session.roomId = seatedAt.id;

  if (session.roomId) {
    const table = tables.get(session.roomId);
    if (!table) { session.roomId = null; return; }   // стол закрылся, пока игрок думал
    const fresh = force || client.lastRoom !== session.roomId;
    if (!fresh && table.version === client.lastTable) return;

    if (table.frameVersion !== table.version) metrics.serialized += 1;
    // Один и тот же кадр уходит всем зрителям стола, личная часть — только своему месту.
    const seat = table.byUser(user.id);
    if (!emitRaw(client, table.frameFor(seat, session.meter !== false))) return; // повторим в следующий тик
    client.lastTable = table.version;
    client.lastRoom = session.roomId;

    const logFrame = table.logFrameSince(client.lastLogId, fresh);
    if (logFrame) {
      client.lastLogId = table.logSeq;
      emitRaw(client, logFrame);
    }
    return;
  }

  if (force || client.lastLobby !== lobbyVersion || client.lastRoom !== null) {
    client.lastLobby = lobbyVersion;
    client.lastRoom = null;
    client.lastTable = -1;
    emitRaw(client, lobbyFrame);
  }
}

function pushAll() {
  lobbySnapshot();                       // одна сборка на всех зрителей лобби
  for (const client of clients) pushTo(client);
}

// ——— игровой цикл ———

let tickExpected = Date.now() + 250;
let maintainedAt = 0;
let purgedAt = Date.now();

// Обслуживание столов: боты, отвалившиеся игроки, закрытие пустых столов.
// Это перебор всех столов, поэтому он идёт раз в две секунды, а не каждый тик.
// Зрители: кто открыл стол, но не сидит за ним. Собираем по открытым соединениям
// и отдаём столу, только если список поменялся, — иначе кадры пересобирались бы зря.
const AUDIENCE_MAX = 50;
function updateAudience() {
  const watching = new Map();   // tableId -> Map(userId -> зритель)
  for (const client of clients) {
    const { session, user } = client.ctx;
    const table = session.roomId && tables.get(session.roomId);
    if (!table || table.byUser(user.id)) continue;
    let list = watching.get(table.id);
    if (!list) { list = new Map(); watching.set(table.id, list); }
    list.set(user.id, { name: user.name, avatar: store.avatarUrl(user) });
  }
  for (const table of tables.values()) {
    const list = [...(watching.get(table.id) || new Map()).values()]
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
      .slice(0, AUDIENCE_MAX);
    const key = list.map((w) => `${w.name}:${w.avatar || ''}`).join('|');
    if (key === (table.audienceKey || '')) continue;
    table.audienceKey = key;
    table.audience = list;
    table.watchers = watching.has(table.id) ? watching.get(table.id).size : 0;
    table.touch();
  }
}

// Событие лично игроку — во все его открытые вкладки. Возвращает, был ли он на связи.
function emitToUser(userId, event, data) {
  let sent = false;
  for (const client of clients) {
    if (client.ctx.user.id === userId) { emit(client, event, data); sent = true; }
  }
  return sent;
}

// Подняли из-за стола за долгий пропуск — игроку всплывашка, если он смотрит.
function notifyLeft(p) {
  emitToUser(p.userId, 'notice', { text: 'Вы долго были «отошедшим» — мы подняли вас из-за стола, фишки вернулись в банк' });
}

// «Позвать друга» за свой стол: в сети — приглашение прямо в игре с кнопкой «К столу»,
// не в сети — сообщение от бота в Telegram (если привязан). Одного друга — не чаще раза в 30 с.
const CALL_GAP_MS = 30_000;
const lastCall = new Map();   // «кто:кого» -> когда звал
function callFriend(user, name) {
  const table = tableOfUser(user.id);
  if (!table) return { error: 'Сначала сядьте за стол' };
  const friend = store.byNameLower(String(name || ''));
  if (!friend || !user.friends.includes(friend.id)) return { error: 'Позвать можно только друга' };
  if (tableOfUser(friend.id) === table) return { error: `${friend.name} уже за этим столом` };
  const key = `${user.id}:${friend.id}`;
  const now = Date.now();
  if (now - (lastCall.get(key) || 0) < CALL_GAP_MS) return { error: 'Вы только что звали — подождите немного' };
  lastCall.set(key, now);
  if (store.isBotUser(friend)) return inviteResident(user, friend, table);
  const online = emitToUser(friend.id, 'invite', { from: user.name, table: table.name, code: table.invite });
  if (!online) notify(friend.id, `${user.name} зовёт вас за стол «${table.name}» в THPoker: ${APP_URL}/t/${table.invite}`);
  return { ok: true, online };
}

// Страница общей раздачи: заголовок и превью из итога, повтор рисует hand.js.
const HAND_KIND = { cash: 'кэш-стол', sng: 'sit-n-go', spin: 'спин', mtt: 'турнир' };
function handPage(hand, origin, code) {
  const top = hand.players.reduce((a, b) => (b.won > a.won ? b : a), hand.players[0]);
  const title = `${hand.sharedBy || 'Игрок'} делится раздачей${top && top.hand ? ` — ${top.hand}` : ''} · THPoker`;
  const desc = `${HAND_KIND[hand.kind] || 'стол'} «${hand.table}», блайнды ${hand.sb}/${hand.bb}, банк ${hand.pot}. `
    + 'Повтор раздачи по улицам — смотреть без регистрации.';
  const tpl = fs.readFileSync(path.join(PUBLIC_DIR, 'hand.html'), 'utf8');
  return tpl
    .replace('<title>Раздача · THPoker</title>', `<title>${escapeHtml(title)}</title>`)
    .replace('<!--meta-->', [
      `<meta name="description" content="${escapeHtml(desc)}">`,
      `<meta property="og:title" content="${escapeHtml(title)}">`,
      `<meta property="og:description" content="${escapeHtml(desc)}">`,
      `<meta property="og:url" content="${escapeHtml(`${origin}/h/${code}`)}">`,
      `<meta property="og:image" content="${escapeHtml(`${origin}/og.png`)}">`,
      '<meta property="og:type" content="website">',
      '<meta name="robots" content="noindex">',
    ].join('\n'));
}

let handsPrunedAt = 0;
const HANDS_KEEP_MS = 7 * 24 * 3600_000;   // обычная раздача хранится неделю; общая — без срока

function maintain(now) {
  if (now - handsPrunedAt > 3600_000) {
    handsPrunedAt = now;
    store.pruneHands(now - HANDS_KEEP_MS);
    for (const [key, at] of lastCall) if (now - at > CALL_GAP_MS) lastCall.delete(key);
  }
  updateAudience();
  for (const table of tables.values()) {
    if (table.phase === 'idle' && !table.tour) {
      for (const p of table.players()) {
        // Резидент докупается из своего банка (или уходит, если банк пуст).
        if (p.resident && p.stack < table.bb * 10) { residentRebuy(table, p); continue; }
        // Ботам возвращаем стек, чтобы стол не останавливался.
        if (p.isBot && p.stack < table.bb * 10) {
          p.stack = Math.round((table.minBuyIn + table.maxBuyIn) / 2);
          p.sittingOut = false;
          p.busted = false;
          table.maybeStartHand();
        }
      }
    }

    // Игроки без соединения: сначала «отошёл», затем выход из-за стола.
    if (table.humans()) {
      for (const p of table.players()) {
        if (p.isBot) continue;
        // Кэш-стол: отошедший встаёт через SIT_OUT_MS. Вернулся в игру — отсчёт
        // сбрасывается, снова ушёл в пропуск — начинается заново.
        if (!table.tour) {
          if (!p.sittingOut) p.sitOutAt = 0;
          else if (!p.sitOutAt) { p.sitOutAt = now; table.touch(); }
          else if (now - p.sitOutAt >= SIT_OUT_MS && !p.leaving) {
            table.leave(p.userId);
            notifyLeft(p);
            continue;
          }
        }
        const rec = presence.get(p.userId);
        if (!rec || rec.conns > 0) continue;
        if (now - rec.lastSeen > 45_000 && !p.sittingOut) table.setSittingOut(p.userId, true);
        if (now - rec.lastSeen > 180_000 && !(table.tour && table.tour.status === 'running')) table.leave(p.userId);
      }
    }
  }

  dropIdleTables(now);
  dropLonelyBots(now);
  residentsTick(now);
  maintainHouseSngs(now);
  mtts.tick(now);
  saveSnapshot();
  store.seasonSweep(now);           // в полночь первого числа — итоги сезона

  if (now - purgedAt > 300_000) {
    purgedAt = now;
    store.purgeSessions(now);
    loginGuard.purge(now);
    for (const [userId, rec] of presence) {
      if (rec.conns <= 0 && now - rec.lastSeen > 3_600_000) presence.delete(userId);
    }
  }
}

setInterval(() => {
  const now = Date.now();
  noteLag(Math.max(0, now - tickExpected));
  tickExpected = now + 250;

  // Бюджет на разбор рук: тик не должен превращаться в долгий счёт.
  setEvalBudget(EVAL_PER_TICK);
  for (const table of tables.values()) table.tick(now);

  if (now - maintainedAt >= 2000) {
    maintainedAt = now;
    maintain(now);
  }

  pushAll();
}, 250);

setInterval(() => {
  for (const client of clients) {
    try { client.res.write(': ping\n\n'); } catch { clients.delete(client); }
  }
}, 20_000);

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\nОстановка (${signal}): сохраняем игроков…`);

  // Жёсткий выход ставится первым и не отменяется ожиданием записи:
  // сервер, который перестал принимать соединения, но не умер, — худший исход.
  const hardExit = setTimeout(() => process.exit(0), 5000);
  try {
    server.close();
    for (const client of clients) { try { client.res.end(); } catch { /* уже закрыт */ } }
    clients.clear();
    // Последний снимок столов: после запуска фишки вернутся игрокам в банк.
    snapshot.paused = false;
    saveSnapshot();
    if (bot) bot.stop();
    await store.close();
  } catch (err) {
    console.error('При остановке:', err.message);
  }
  clearTimeout(hardExit);
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, HOST, 1024, () => {
  console.log(`THPoker работает: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Столов открыто: ${tables.size}`);
  if (!bot) {
    console.log('Telegram выключен: не задан TELEGRAM_BOT_TOKEN (см. /etc/night-poker.env)');
    return;
  }
  if (bot.username) console.log(`Вход через Telegram включён для @${bot.username}`);
  // Сеть или Telegram могут быть недоступны в момент запуска — пробуем ещё, пока не выйдет.
  if (TG_WEBHOOK_SECRET) {
    console.log('Telegram-бот: режим вебхука, сообщения принимаются на /api/telegram/webhook');
  }
  // При вебхуке сервер сам не опрашивает Telegram, но если выход к API есть —
  // бот сможет и присылать уведомления.
  const startBot = () => bot.start({ poll: !TG_WEBHOOK_SECRET })
    .then((name) => console.log(`Telegram-бот @${name} на связи, кнопки ведут на ${APP_URL}`))
    .catch((err) => {
      console.error(`Telegram API недоступен: ${err.message}. ${TG_WEBHOOK_SECRET
        ? 'Бот отвечает через вебхук, уведомлений не будет' : 'Новая попытка через 30 с'}`);
      if (!stopping) setTimeout(startBot, TG_WEBHOOK_SECRET ? 600_000 : 30_000);
    });
  startBot();
});
