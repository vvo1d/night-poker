'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { Store } = require('./src/store');
const { Table } = require('./src/table');
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
const rooms = new Map();
for (const cfg of ROOM_CONFIGS) {
  const table = new Table(cfg, {
    onChipsReturn: (player, chips) => {
      if (!player.isBot && chips > 0) store.addChips(player.userId, chips);
    },
    onHandStart: (players) => {
      for (const p of players) {
        const user = p.isBot ? null : store.user(p.userId);
        if (user) { user.handsPlayed += 1; store.save(); }
      }
    },
  });
  rooms.set(cfg.id, table);
}

const clients = new Set();          // открытые SSE-соединения
const presence = new Map();         // userId -> { conns, lastSeen }

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

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Доступ запрещён');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Страница не найдена');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
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
  for (const table of rooms.values()) if (table.byUser(userId)) return table;
  return null;
}

// ——— команды за столом ———

async function handleCommand(ctx, body) {
  const { session, user } = ctx;
  const cmd = body.cmd;
  const room = () => rooms.get(session.roomId);

  switch (cmd) {
    case 'enterRoom': {
      const table = rooms.get(body.roomId);
      if (!table) return { error: 'Комната не найдена' };
      const seated = tableOfUser(user.id);
      if (seated && seated.id !== table.id) return { error: `Вы уже играете в комнате «${seated.name}»` };
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
      const res = table.sit({ id: user.id, name: user.name }, Number(body.seat), buyIn);
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
      const { user, error } = store.register(body.name, body.password);
      if (error) return send(res, 400, { error });
      const token = store.createSession(user.id);
      return send(res, 200, { user: store.publicUser(user.id) }, { 'Set-Cookie': sessionCookie(token) });
    }

    if (route === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      const { user, error } = store.login(body.name, body.password);
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

    if (route === '/api/rooms' && req.method === 'GET') {
      return send(res, 200, { rooms: [...rooms.values()].map((t) => t.lobbyInfo()) });
    }

    if (route === '/api/cmd' && req.method === 'POST') {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
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

  const client = { res, ctx, lastTable: -1, lastLobby: '', lastUser: '', lastRoom: undefined, lastLogId: 0 };
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
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    clients.delete(client);
  }
}

function pushTo(client, force = false) {
  const { session, user } = client.ctx;
  const fresh = store.publicUser(user.id);
  if (!fresh) return;

  const userKey = JSON.stringify(fresh);
  if (force || userKey !== client.lastUser) {
    client.lastUser = userKey;
    emit(client, 'user', fresh);
  }

  if (session.roomId) {
    const table = rooms.get(session.roomId);
    if (table && (force || table.version !== client.lastTable || client.lastRoom !== session.roomId)) {
      const fresh = client.lastRoom !== session.roomId;
      client.lastTable = table.version;
      client.lastRoom = session.roomId;

      const state = table.publicState(user.id);
      // Ленту шлём кусочками: при первом кадре — хвост истории, дальше только новое.
      const full = state.log;
      state.log = fresh || force
        ? full.slice(-120)
        : full.filter((line) => line.id > client.lastLogId);
      state.logReset = fresh || force;
      if (full.length) client.lastLogId = full[full.length - 1].id;

      emit(client, 'table', state);
    }
  } else {
    const lobby = [...rooms.values()].map((t) => t.lobbyInfo());
    const key = JSON.stringify(lobby);
    if (force || key !== client.lastLobby || client.lastRoom !== null) {
      client.lastLobby = key;
      client.lastRoom = null;
      client.lastTable = -1;
      emit(client, 'lobby', { rooms: lobby, leaderboard: store.leaderboard() });
    }
  }
}

function pushAll() { for (const client of clients) pushTo(client); }

// ——— игровой цикл ———

setInterval(() => {
  const now = Date.now();
  for (const table of rooms.values()) {
    table.tick(now);

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
    for (const p of table.players()) {
      if (p.isBot) continue;
      const rec = presence.get(p.userId);
      if (!rec || rec.conns > 0) continue;
      if (now - rec.lastSeen > 45_000 && !p.sittingOut) table.setSittingOut(p.userId, true);
      if (now - rec.lastSeen > 180_000) table.leave(p.userId);
    }
  }
  pushAll();
}, 250);

setInterval(() => {
  for (const client of clients) {
    try { client.res.write(': ping\n\n'); } catch { clients.delete(client); }
  }
}, 20_000);

server.listen(PORT, () => {
  console.log(`Покер-сервер работает: http://localhost:${PORT}`);
  console.log(`Комнат открыто: ${rooms.size}`);
});
