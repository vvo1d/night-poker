'use strict';
// Пароли считаются на пуле потоков libuv: четырёх потоков по умолчанию мало,
// когда в час пик заходят тысячи игроков.
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '16';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { Store } = require('./src/store');
const { Table, setEvalBudget } = require('./src/table');
const { BOT_NAMES } = require('./src/bot');
const { Tournament, SNG_STACK, SNG_TIMEOUT, SNG_BUY_INS } = require('./src/tournament');
const { ACHIEVEMENTS, achievementView, tierTotal } = require('./src/achievements');

const PORT = Number(process.env.PORT) || 3000;
// За обратным прокси сервер стоит слушать только петлю, чтобы снаружи
// нельзя было постучаться мимо прокси.
const HOST = process.env.HOST || '0.0.0.0';
// По HTTPS cookie должна помечаться Secure, по HTTP — нет, иначе браузер её не сохранит.
const SECURE_COOKIE = process.env.COOKIE_SECURE === '1';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Столы заведения: стоят всегда, даже пустые, — чтобы было куда сесть сразу.
const ROOM_CONFIGS = [
  { id: 'novice', name: 'Новичок', maxSeats: 9, sb: 1, bb: 2, minBuyIn: 40, maxBuyIn: 200, timeout: 25 },
  { id: 'quiet', name: 'Тихий стол', maxSeats: 4, sb: 2, bb: 5, minBuyIn: 100, maxBuyIn: 500, timeout: 40 },
  { id: 'six', name: 'Шестёрка', maxSeats: 6, sb: 5, bb: 10, minBuyIn: 200, maxBuyIn: 1000, timeout: 25 },
  { id: 'heads', name: 'Хедз-ап', maxSeats: 2, sb: 10, bb: 20, minBuyIn: 400, maxBuyIn: 2000, timeout: 20 },
  { id: 'turbo', name: 'Турбо', maxSeats: 9, sb: 25, bb: 50, minBuyIn: 1000, maxBuyIn: 5000, timeout: 12 },
  { id: 'high', name: 'Высокие ставки', maxSeats: 6, sb: 50, bb: 100, minBuyIn: 2000, maxBuyIn: 10000, timeout: 25 },
];

// Из чего игрок собирает свой стол. Закупка — от 20 до 100 больших блайндов.
const STAKES = [[1, 2], [2, 5], [5, 10], [10, 20], [25, 50], [50, 100], [100, 200]];
const CASH_SEATS = [2, 4, 6, 9];
const SNG_SEATS = [6, 9];
const TIMEOUTS = [12, 25, 40];

const store = new Store();

// Столы живут, пока они нужны: свой стол игрок заводит сам, пустой закрывается.
const CASH_IDLE_MS = 5 * 60_000;     // пустой кэш-стол ждёт столько, прежде чем закрыться
const SNG_IDLE_MS = 10 * 60_000;     // турнир, на который никто не записался
const SNG_DONE_MS = 2 * 60_000;      // законченный турнир ещё висит с итогами
const TABLES_PER_USER = 3;           // сколько открытых столов может держать один игрок
const TABLES_MAX = 5000;
const LOBBY_LIMIT = 150;             // столько столов уходит в лобби — самые живые
const EVAL_PER_TICK = 8;             // тяжёлых разборов руки за тик (по ~4 мс каждый)

const tables = new Map();       // tableId -> Table, в порядке создания
const playerTable = new Map();  // userId -> Table (чтобы не перебирать все столы)
let tableSeq = 0;

function createTable(cfg, { owner = null, sng = 0, buyIn } = {}) {
  const n = ++tableSeq;
  const tour = sng ? new Tournament(sng, {
    pay: (player, amount) => { if (!player.isBot) store.addChips(player.userId, amount); },
    onStart: (players) => { for (const p of players) if (!p.isBot) store.recordSng(p.userId, { start: true }); },
    onPlace: (player, place, prize) => { if (!player.isBot) store.recordSng(player.userId, { place, prize }); },
  }, buyIn) : null;
  const table = new Table({ ...cfg, id: cfg.id || `t${n}`, tour }, {
    onChipsReturn: (player, chips) => {
      if (player.isBot) return;
      // Турнирные фишки в банк не уходят. До старта уход из-за стола — отмена регистрации.
      if (tour) { if (tour.status === 'registering') store.addChips(player.userId, tour.buyIn); return; }
      if (chips > 0) store.addChips(player.userId, chips);
    },
    onHandStart: (players) => {
      for (const p of players) if (!p.isBot) store.countHand(p.userId);
    },
    onHandEnd: (results) => {
      for (const r of results) {
        if (!r.player.isBot) store.recordHand(r.player.userId, { ...r, cash: !tour });
      }
    },
    onSeat: (player, t) => { if (!player.isBot) playerTable.set(player.userId, t); },
    onUnseat: (player) => { if (!player.isBot) playerTable.delete(player.userId); },
  });
  table.house = !owner;
  table.ownerId = owner ? owner.id : null;
  table.ownerName = owner ? owner.name : null;
  table.createdAt = Date.now();
  table.emptyAt = Date.now();
  tables.set(table.id, table);
  return table;
}

// Свой стол: кэш с выбранными блайндами или сит-н-гоу на 6 или 9 мест.
function createUserTable(user, body) {
  let owned = 0;
  for (const t of tables.values()) if (t.ownerId === user.id) owned += 1;
  if (owned >= TABLES_PER_USER) return { error: `Открыто уже ${TABLES_PER_USER} ваших стола — дождитесь, пока какой-нибудь закроется` };
  if (tables.size >= TABLES_MAX) return { error: 'Свободных столов нет, попробуйте позже' };

  const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 24);
  if (body.kind === 'sng') {
    const seats = Number(body.seats);
    if (!SNG_SEATS.includes(seats)) return { error: 'Сит-н-гоу бывает на 6 или 9 мест' };
    const buyIn = Number(body.buyIn);
    if (!SNG_BUY_INS.includes(buyIn)) return { error: 'Выберите взнос' };
    const table = createTable({
      name: name || `Сит-н-гоу на ${seats}`,
      maxSeats: seats, sb: 0, bb: 0, minBuyIn: SNG_STACK, maxBuyIn: SNG_STACK, timeout: SNG_TIMEOUT,
    }, { owner: user, sng: seats, buyIn });
    [table.sb, table.bb] = table.tour.blinds();
    return table;
  }

  const seats = Number(body.seats);
  const stake = STAKES[Number(body.stake)];
  const timeout = Number(body.timeout);
  if (!CASH_SEATS.includes(seats)) return { error: 'Мест за столом может быть 2, 4, 6 или 9' };
  if (!stake) return { error: 'Выберите блайнды' };
  if (!TIMEOUTS.includes(timeout)) return { error: 'Выберите время на ход' };
  const [sb, bb] = stake;
  return createTable({
    name: name || `Стол ${user.name}`,
    maxSeats: seats, sb, bb, minBuyIn: bb * 20, maxBuyIn: bb * 100, timeout,
  }, { owner: user });
}

// Пустые столы игроков закрываются, столы заведения стоят всегда.
function dropIdleTables(now) {
  for (const table of tables.values()) {
    if (table.house || table.occupied()) continue;
    const tour = table.tour;
    const idle = tour
      ? (tour.status === 'finished' ? now - tour.finishedAt > SNG_DONE_MS
        : tour.status === 'registering' && table.emptyAt && now - table.emptyAt > SNG_IDLE_MS)
      : table.emptyAt && now - table.emptyAt > CASH_IDLE_MS;
    if (idle) tables.delete(table.id);
  }
}

for (const cfg of ROOM_CONFIGS) createTable(cfg);

const clients = new Set();          // открытые SSE-соединения
const presence = new Map();         // userId -> { conns, lastSeen }

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
  '.woff2': 'font/woff2',
};

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

function staticFile(file) {
  let entry = staticCache.get(file);
  if (entry !== undefined) return entry;
  try {
    const body = fs.readFileSync(file);
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

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Доступ запрещён');

  const entry = staticFile(file);
  if (!entry) return send(res, 404, 'Страница не найдена');
  if (req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, { ETag: entry.etag, 'Cache-Control': 'no-cache' });
    return res.end();
  }
  res.writeHead(200, {
    'Content-Type': entry.type,
    'Content-Length': entry.body.length,
    'Cache-Control': 'no-cache',
    ETag: entry.etag,
  });
  res.end(entry.body);
}

// ——— сессии ———

function sessionOf(req) {
  const token = cookies(req).sid;
  const session = store.session(token);
  if (!session) return null;
  const user = store.user(session.userId);
  if (!user) return null;
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
    seats: table.seats.map((p) => (!p ? 0 : p.isBot ? 2 : 1)),
    playing: table.phase !== 'idle',
    sng: tour ? {
      status: tour.status,
      buyIn: tour.buyIn,
      stack: tour.stack,
      prizes: tour.prizes,
      level: tour.level + 1,
      left: table.occupied(),
      winner: tour.status === 'finished' && tour.places[0] ? tour.places[0].name : null,
    } : null,
  };
}

// В лобби уходят не все столы, а самые живые: при тысячах столов список
// иначе весил бы сотни килобайт на каждое обновление. Столы заведения
// и турниры, где идёт регистрация, видны всегда.
function lobbyTables() {
  const rank = (t) => (t.house ? 3 : t.tour && t.tour.status === 'registering' ? 2 : 0) * 100 + t.humans();
  const list = [...tables.values()];
  if (list.length > LOBBY_LIMIT) {
    list.sort((a, b) => rank(b) - rank(a));
    list.length = LOBBY_LIMIT;
    list.sort((a, b) => a.createdAt - b.createdAt);
  }
  return list.map(tableInfo);
}

function lobbyTotals() {
  let players = 0;
  let playing = 0;
  for (const table of tables.values()) {
    players += table.occupied();
    if (table.phase !== 'idle') playing += 1;
  }
  return { tables: tables.size, players, playing };
}

function lobbySnapshot(now = Date.now()) {
  if (lobbyJson && now - lobbyAt < LOBBY_EVERY) return lobbyJson;
  lobbyAt = now;
  const next = JSON.stringify({
    rooms: lobbyTables(),
    totals: lobbyTotals(),
    stakes: STAKES,
    sngBuyIns: SNG_BUY_INS,
  });
  if (next !== lobbyJson) {
    lobbyJson = next;
    lobbyFrame = `event: lobby\ndata: ${next}\n\n`;
    lobbyVersion += 1;
  }
  return lobbyJson;
}

// ——— кабинет, друзья, рейтинг ———

function isOnline(userId) {
  const rec = presence.get(userId);
  return !!(rec && rec.conns > 0);
}

// Где сейчас игрок: за каким столом сидит. Нужно, чтобы друг мог подсесть.
function whereIs(userId) {
  const table = tableOfUser(userId);
  return table ? { id: table.id, name: table.name, kind: table.tour ? 'sng' : 'cash' } : null;
}

function friendView(id) {
  const u = store.user(id);
  if (!u) return null;
  return { name: u.name, chips: u.chips, online: isOnline(id), table: whereIs(id) };
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
      const seated = tableOfUser(user.id);
      if (seated) { session.roomId = seated.id; return { ok: true, roomId: seated.id }; }
      const table = tables.get(String(body.roomId));
      if (!table) return { error: 'Стол уже закрыт' };
      session.roomId = table.id;
      return { ok: true, roomId: table.id };
    }
    case 'createTable': {
      const seated = tableOfUser(user.id);
      if (seated) return { error: 'Сначала встаньте из-за текущего стола' };
      const table = createUserTable(user, body);
      if (table.error) return table;
      session.roomId = table.id;
      return { ok: true, roomId: table.id };
    }
    case 'leaveRoom': {
      const table = room();
      if (table && table.byUser(user.id)) table.leave(user.id);
      session.roomId = null;
      return { ok: true };
    }
    case 'sit': {
      const table = room();
      if (!table) return { error: 'Сначала войдите в комнату' };
      if (tableOfUser(user.id) && tableOfUser(user.id) !== table) return { error: 'Вы уже сидите за другим столом' };
      const tour = table.tour;
      if (tour && tour.status !== 'registering') return { error: 'Регистрация на турнир закрыта' };
      // В турнире платят взнос, а играют турнирным стеком.
      const pay = tour ? tour.buyIn : Math.round(Number(body.buyIn) || 0);
      const stack = tour ? tour.stack : pay;
      const fresh = store.user(user.id);
      if (pay > fresh.chips) return { error: 'В банке недостаточно фишек' };
      // Место можно не выбирать: тогда сажаем на первое свободное.
      let seat = Number(body.seat);
      if (!Number.isInteger(seat) || seat < 0) seat = table.seats.findIndex((x) => x === null);
      if (seat < 0) return { error: 'Свободных мест нет' };
      // Взнос списываем до посадки: последний участник сразу запускает турнир.
      store.addChips(user.id, -pay);
      const res = table.sit({ id: user.id, name: user.name }, seat, stack);
      if (res.error) { store.addChips(user.id, pay); return res; }
      return { ok: true };
    }
    case 'standUp': {
      const table = room();
      if (!table) return { error: 'Вы не за столом' };
      return table.leave(user.id);
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
      store.addChips(user.id, -amount);
      return { ok: true };
    }
    case 'addBot': {
      const table = room();
      if (!table) return { error: 'Сначала войдите в комнату' };
      if (table.tour && table.tour.status !== 'registering') return { error: 'Турнир уже идёт' };
      const seat = table.seats.findIndex((s) => s === null);
      if (seat < 0) return { error: 'Свободных мест нет' };
      const taken = new Set(table.players().map((p) => p.name));
      const name = BOT_NAMES.find((n) => !taken.has(n)) || `Бот-${seat + 1}`;
      const stack = table.tour ? table.tour.stack : Math.round((table.minBuyIn + table.maxBuyIn) / 2);
      return table.sit({ id: `bot-${crypto.randomUUID()}`, name, isBot: true }, seat, stack);
    }
    case 'kickBot': {
      const table = room();
      if (!table) return { error: 'Сначала войдите в комнату' };
      const p = table.bySeat(Number(body.seat));
      if (!p || !p.isBot) return { error: 'На этом месте не бот' };
      if (table.tour && table.tour.status !== 'registering') return { error: 'Из турнира бота не убрать' };
      if (p.inHand && table.phase !== 'idle') { p.leaving = true; return { ok: true, pending: true }; }
      return table.removePlayer(p);
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
    case 'addFriend':
      return store.addFriend(user.id, body.name);
    case 'acceptFriend':
      return store.acceptFriend(user.id, body.name);
    case 'declineFriend':
      return store.declineFriend(user.id, body.name);
    case 'removeFriend':
      return store.removeFriend(user.id, body.name);
    default:
      return { error: 'Неизвестная команда' };
  }
}

// ——— маршруты ———

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = url.pathname;

  if (req.method === 'GET' && !route.startsWith('/api/')) return serveStatic(req, res, route);

  try {
    if (route === '/api/register' && req.method === 'POST') {
      const body = await readBody(req);
      const { user, error } = await store.register(body.name, body.password);
      if (error) return send(res, 400, { error });
      const token = store.createSession(user.id);
      return send(res, 200, { user: store.publicUser(user.id) }, { 'Set-Cookie': sessionCookie(token) });
    }

    if (route === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      const { user, error } = await store.login(body.name, body.password);
      if (error) return send(res, 400, { error });
      const token = store.createSession(user.id);
      return send(res, 200, { user: store.publicUser(user.id) }, { 'Set-Cookie': sessionCookie(token) });
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
        roomId: ctx.session.roomId,
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
      return send(res, 200, friendsOf(ctx.user));
    }

    if (route === '/api/rating' && req.method === 'GET') {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      return send(res, 200, store.rating(url.searchParams.get('by') || 'chips', ctx.user.id));
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
function maintain(now) {
  for (const table of tables.values()) {
    if (table.phase === 'idle' && !table.tour) {
      for (const p of table.players()) {
        // Ботам возвращаем стек, чтобы стол не останавливался.
        if (p.isBot && p.stack < table.bb * 10) {
          p.stack = Math.round((table.minBuyIn + table.maxBuyIn) / 2);
          p.sittingOut = false;
          p.busted = false;
          table.maybeStartHand();
        }
      }
    }

    // Игроки без соединения: сначала пропуск раздач, затем выход из-за стола.
    if (table.humans()) {
      for (const p of table.players()) {
        if (p.isBot) continue;
        const rec = presence.get(p.userId);
        if (!rec || rec.conns > 0) continue;
        if (now - rec.lastSeen > 45_000 && !p.sittingOut) table.setSittingOut(p.userId, true);
        if (now - rec.lastSeen > 180_000 && !(table.tour && table.tour.status === 'running')) table.leave(p.userId);
      }
    }
  }

  dropIdleTables(now);

  if (now - purgedAt > 300_000) {
    purgedAt = now;
    store.purgeSessions(now);
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
  console.log(`Покер-сервер работает: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Столов открыто: ${tables.size}`);
});
