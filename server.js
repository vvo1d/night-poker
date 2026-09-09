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

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const ROOM_CONFIGS = [
  { id: 'novice', name: 'Новичок', maxSeats: 9, sb: 1, bb: 2, minBuyIn: 40, maxBuyIn: 200, timeout: 25 },
  { id: 'quiet', name: 'Тихий стол', maxSeats: 4, sb: 2, bb: 5, minBuyIn: 100, maxBuyIn: 500, timeout: 40 },
  { id: 'six', name: 'Шестёрка', maxSeats: 6, sb: 5, bb: 10, minBuyIn: 200, maxBuyIn: 1000, timeout: 25 },
  { id: 'heads', name: 'Хедз-ап', maxSeats: 2, sb: 10, bb: 20, minBuyIn: 400, maxBuyIn: 2000, timeout: 20 },
  { id: 'turbo', name: 'Турбо', maxSeats: 9, sb: 25, bb: 50, minBuyIn: 1000, maxBuyIn: 5000, timeout: 12 },
  { id: 'high', name: 'Высокие ставки', maxSeats: 6, sb: 50, bb: 100, minBuyIn: 2000, maxBuyIn: 10000, timeout: 25 },
];

const store = new Store();

// Уровень ставок — это не один стол, а сколько нужно. Столы заводятся по мере
// прихода игроков и убираются, когда пустеют: иначе десять тысяч человек
// просто некуда посадить.
const TABLE_IDLE_MS = 60_000;   // сколько пустой стол ждёт, прежде чем закрыться
const EVAL_PER_TICK = 8;        // тяжёлых разборов руки за тик (по ~4 мс каждый)

const levels = new Map();       // levelId -> { cfg, tables: Set<Table> }
const tables = new Map();       // tableId -> Table
const playerTable = new Map();  // userId -> Table (чтобы не перебирать все столы)
let tableSeq = 0;

for (const cfg of ROOM_CONFIGS) levels.set(cfg.id, { cfg, tables: new Set() });

function createTable(level) {
  const n = ++tableSeq;
  const table = new Table({ ...level.cfg, id: `${level.cfg.id}#${n}`, name: `${level.cfg.name} · стол ${n}` }, {
    onChipsReturn: (player, chips) => {
      if (!player.isBot && chips > 0) store.addChips(player.userId, chips);
    },
    onHandStart: (players) => {
      for (const p of players) if (!p.isBot) store.countHand(p.userId);
    },
    onSeat: (player, t) => { if (!player.isBot) playerTable.set(player.userId, t); },
    onUnseat: (player) => { if (!player.isBot) playerTable.delete(player.userId); },
  });
  table.levelId = level.cfg.id;
  table.emptyAt = Date.now();
  level.tables.add(table);
  tables.set(table.id, table);
  return table;
}

// Сажаем к самому полному столу со свободным местом: пустые столы не плодятся,
// а игра остаётся живой.
function pickTable(level) {
  let best = null;
  for (const table of level.tables) {
    if (table.occupied() >= table.maxSeats) continue;
    if (!best || table.occupied() > best.occupied()) best = table;
  }
  return best || createTable(level);
}

function dropIdleTables(now) {
  for (const level of levels.values()) {
    if (level.tables.size <= 1) continue;
    for (const table of level.tables) {
      if (table.occupied() || !table.emptyAt || now - table.emptyAt < TABLE_IDLE_MS) continue;
      if (level.tables.size <= 1) break;
      level.tables.delete(table);
      tables.delete(table.id);
    }
  }
}

for (const level of levels.values()) createTable(level);

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

function levelInfo(level) {
  let players = 0;
  let humans = 0;
  let free = 0;
  let playing = 0;
  for (const table of level.tables) {
    const busy = table.occupied();
    players += busy;
    humans += table.humans();
    free += table.maxSeats - busy;
    if (table.phase !== 'idle') playing += 1;
  }
  const cfg = level.cfg;
  return {
    id: cfg.id,
    name: cfg.name,
    maxSeats: cfg.maxSeats,
    sb: cfg.sb,
    bb: cfg.bb,
    minBuyIn: cfg.minBuyIn,
    maxBuyIn: cfg.maxBuyIn,
    tables: level.tables.size,
    players,
    humans,
    free,
    playing,
  };
}

function lobbySnapshot(now = Date.now()) {
  if (lobbyJson && now - lobbyAt < LOBBY_EVERY) return lobbyJson;
  lobbyAt = now;
  const next = JSON.stringify({
    rooms: [...levels.values()].map(levelInfo),
    leaderboard: store.leaderboard(),
  });
  if (next !== lobbyJson) {
    lobbyJson = next;
    lobbyFrame = `event: lobby\ndata: ${next}\n\n`;
    lobbyVersion += 1;
  }
  return lobbyJson;
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
      const level = levels.get(body.roomId) || (tables.get(body.roomId)
        ? levels.get(tables.get(body.roomId).levelId) : null);
      if (!level) return { error: 'Комната не найдена' };
      // Если попросили конкретный стол и там есть место — сажаем туда.
      const wanted = tables.get(body.roomId);
      const table = wanted && wanted.occupied() < wanted.maxSeats ? wanted : pickTable(level);
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
      const buyIn = Math.round(Number(body.buyIn) || 0);
      const fresh = store.user(user.id);
      if (buyIn > fresh.chips) return { error: 'В банке недостаточно фишек' };
      // Место можно не выбирать: тогда сажаем на первое свободное.
      let seat = Number(body.seat);
      if (!Number.isInteger(seat) || seat < 0) seat = table.seats.findIndex((x) => x === null);
      if (seat < 0) return { error: 'Свободных мест нет' };
      const res = table.sit({ id: user.id, name: user.name }, seat, buyIn);
      if (res.error) return res;
      store.addChips(user.id, -buyIn);
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
      const seat = table.seats.findIndex((s) => s === null);
      if (seat < 0) return { error: 'Свободных мест нет' };
      const taken = new Set(table.players().map((p) => p.name));
      const name = BOT_NAMES.find((n) => !taken.has(n)) || `Бот-${seat + 1}`;
      const stack = Math.round((table.minBuyIn + table.maxBuyIn) / 2);
      return table.sit({ id: `bot-${crypto.randomUUID()}`, name, isBot: true }, seat, stack);
    }
    case 'kickBot': {
      const table = room();
      if (!table) return { error: 'Сначала войдите в комнату' };
      const p = table.bySeat(Number(body.seat));
      if (!p || !p.isBot) return { error: 'На этом месте не бот' };
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
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`;
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
    if (!emitRaw(client, table.frameFor(table.byUser(user.id)))) return; // повторим в следующий тик
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
    if (table.phase === 'idle') {
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
        if (now - rec.lastSeen > 180_000) table.leave(p.userId);
      }
    }
  }

  dropIdleTables(now);

  if (now - purgedAt > 300_000) {
    purgedAt = now;
    store.purgeSessions(now);
    store.saveSessions();
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

server.listen(PORT, 1024, () => {
  console.log(`Покер-сервер работает: http://localhost:${PORT}`);
  console.log(`Уровней ставок: ${levels.size}, столов открыто: ${tables.size}`);
});
