'use strict';
const crypto = require('node:crypto');
const { openStorage } = require('./db');

const START_CHIPS = 10000;
const RELOAD_CHIPS = 2000; // бесплатное пополнение для игроков без фишек

const WRITE_EVERY = 400;            // как часто изменения уходят в базу
const LEADERBOARD_TTL = 5_000;      // таблица лидеров пересчитывается не чаще
const SESSION_TTL = 30 * 24 * 3600 * 1000;

// Пароли считаются на пуле потоков, а не в основном цикле: иначе на входе
// сервер замирает и перестаёт обслуживать столы.
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

// Игроки живут в базе, но горячие чтения идут из памяти: состояние игрока
// уходит в поток тысячам соединений, ходить за ним в базу на каждый кадр незачем.
// Изменения копятся и уезжают в базу пачкой в одной транзакции.
class Store {
  constructor(file) {
    // Движок выбирается сам: база, если она есть в этой версии Node, иначе файлы.
    this.backend = openStorage(file);
    this.users = new Map();      // id -> игрок
    this.byName = new Map();     // имя в нижнем регистре -> id
    this.sessions = new Map();   // токен -> { userId, created, seen, roomId }

    this.dirtyUsers = new Set();
    this.dirtySessions = new Set();
    this.goneSessions = new Set();
    this.writeTimer = null;
    this.writing = null;

    this.versions = new Map();   // id -> версия (для потока), в базу не попадает
    this.publicJson = new Map(); // id -> готовое событие для потока
    this.board = { at: 0, list: [] };

    this.load();
  }

  load() {
    const { users, sessions } = this.backend.load(SESSION_TTL);
    for (const user of users) {
      this.users.set(user.id, user);
      this.byName.set(user.name.toLowerCase(), user.id);
    }
    for (const [token, rec] of sessions) {
      if (this.users.has(rec.userId)) this.sessions.set(token, rec);
    }
    console.log(`Хранилище: ${this.backend.kind} (${this.backend.where})`);
    if (this.users.size) console.log(`Загружено игроков: ${this.users.size}, сессий: ${this.sessions.size}`);
  }

  // ——— запись ———

  touch(user) {
    this.versions.set(user.id, (this.versions.get(user.id) || 0) + 1);
    this.publicJson.delete(user.id);
    this.dirtyUsers.add(user.id);
    this.schedule();
  }

  schedule() {
    if (!this.writeTimer) this.writeTimer = setTimeout(() => this.flush(), WRITE_EVERY);
  }

  // Всё накопленное уходит в хранилище пачкой: база пишет это одной
  // транзакцией, файловый движок — одной дозаписью в журнал.
  flush() {
    clearTimeout(this.writeTimer);
    this.writeTimer = null;
    if (this.writing) { this.schedule(); return this.writing; }
    if (!this.dirtyUsers.size && !this.dirtySessions.size && !this.goneSessions.size) return null;

    const users = [...this.dirtyUsers].map((id) => this.users.get(id)).filter(Boolean);
    const sessions = [...this.dirtySessions].map((token) => [token, this.sessions.get(token)]).filter(([, s]) => s);
    const gone = [...this.goneSessions];
    this.dirtyUsers.clear();
    this.dirtySessions.clear();
    this.goneSessions.clear();

    const done = (err) => {
      this.writing = null;
      if (!err) return;
      console.error('Не удалось сохранить игроков:', err.message);
      for (const u of users) this.dirtyUsers.add(u.id);
      for (const [token] of sessions) this.dirtySessions.add(token);
      for (const token of gone) this.goneSessions.add(token);
      this.schedule();
    };

    try {
      const result = this.backend.save({
        users, sessions, gone, allSessions: () => [...this.sessions.entries()],
      });
      if (result && typeof result.then === 'function') {
        this.writing = result.then(() => done(null), done);
        return this.writing;
      }
      done(null);
    } catch (err) {
      done(err);
    }
    return null;
  }

  async close() {
    await this.flush();
    if (this.writing) await this.writing;
    await this.backend.close();
  }

  // ——— аккаунты ———

  checkName(name) {
    if (name.length < 3 || name.length > 16) return 'Имя — от 3 до 16 символов';
    if (!/^[\p{L}\p{N}_ -]+$/u.test(name)) return 'В имени только буквы, цифры, пробел, дефис и _';
    return null;
  }

  async register(name, password) {
    name = String(name || '').trim();
    password = String(password || '');
    const bad = this.checkName(name);
    if (bad) return { error: bad };
    if (password.length < 6) return { error: 'Пароль — минимум 6 символов' };
    if (this.byName.has(name.toLowerCase())) return { error: 'Такое имя уже занято' };

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await scrypt(password, salt)).toString('hex');
    // Пока считался хеш, имя могли занять.
    if (this.byName.has(name.toLowerCase())) return { error: 'Такое имя уже занято' };

    const user = {
      id: crypto.randomUUID(),
      name,
      salt,
      hash,
      chips: START_CHIPS,
      handsPlayed: 0,
      createdAt: Date.now(),
    };
    this.users.set(user.id, user);
    this.byName.set(name.toLowerCase(), user.id);
    this.touch(user);
    return { user };
  }

  async login(name, password) {
    const id = this.byName.get(String(name || '').trim().toLowerCase());
    const user = id && this.users.get(id);
    if (!user) return { error: 'Игрок с таким именем не найден' };
    const attempt = await scrypt(String(password || ''), user.salt);
    const stored = Buffer.from(user.hash, 'hex');
    if (attempt.length !== stored.length || !crypto.timingSafeEqual(attempt, stored)) {
      return { error: 'Неверный пароль' };
    }
    return { user };
  }

  // ——— сессии ———

  createSession(userId) {
    const token = crypto.randomBytes(24).toString('hex');
    const now = Date.now();
    this.sessions.set(token, { userId, created: now, seen: now, roomId: null });
    this.dirtySessions.add(token);
    this.schedule();
    return token;
  }

  session(token) {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    // Отметку «виден» пишем не чаще раза в минуту: она нужна только для уборки.
    const now = Date.now();
    if (now - s.seen > 60_000) {
      s.seen = now;
      this.dirtySessions.add(token);
      this.schedule();
    } else s.seen = now;
    return s;
  }

  destroySession(token) {
    if (!this.sessions.delete(token)) return;
    this.dirtySessions.delete(token);
    this.goneSessions.add(token);
    this.schedule();
  }

  // Забытые сессии не должны копиться ни в памяти, ни в базе.
  purgeSessions(now = Date.now()) {
    let gone = 0;
    for (const [token, s] of this.sessions) {
      if (now - s.seen <= SESSION_TTL) continue;
      this.sessions.delete(token);
      this.goneSessions.add(token);
      gone += 1;
    }
    if (gone) this.schedule();
    return gone;
  }

  user(id) { return this.users.get(id) || null; }

  addChips(userId, amount) {
    const u = this.users.get(userId);
    if (!u) return;
    u.chips += amount;
    this.touch(u);
  }

  countHand(userId) {
    const u = this.users.get(userId);
    if (!u) return;
    u.handsPlayed += 1;
    this.touch(u);
  }

  reload(userId) {
    const u = this.users.get(userId);
    if (!u) return { error: 'Игрок не найден' };
    if (u.chips >= 200) return { error: 'Пополнение доступно, когда в банке меньше 200 фишек' };
    u.chips += RELOAD_CHIPS;
    this.touch(u);
    return { ok: true, chips: u.chips };
  }

  publicUser(id) {
    const u = this.users.get(id);
    if (!u) return null;
    return { id: u.id, name: u.name, chips: u.chips, handsPlayed: u.handsPlayed };
  }

  // Готовое событие для потока: строка собирается один раз до следующего изменения.
  publicUserFrame(id) {
    let frame = this.publicJson.get(id);
    if (frame === undefined) {
      const view = this.publicUser(id);
      if (!view) return null;
      frame = `event: user\ndata: ${JSON.stringify(view)}\n\n`;
      this.publicJson.set(id, frame);
    }
    return frame;
  }

  userVersion(id) {
    if (!this.users.has(id)) return -1;
    return this.versions.get(id) || 0;
  }

  // Таблица лидеров: база берёт её запросом по индексу, файловый движок —
  // перебором в памяти. В обоих случаях результат кэшируется.
  leaderboard(limit = 10) {
    const now = Date.now();
    if (now - this.board.at < LEADERBOARD_TTL) return this.board.list;
    this.flush();   // в выборку должны попасть свежие фишки
    this.board = { at: now, list: this.backend.top(limit, this.users) };
    return this.board.list;
  }

  // ——— наблюдение ———

  stats() {
    return {
      storage: this.backend.kind,
      users: this.users.size,
      sessions: this.sessions.size,
      pendingWrites: this.dirtyUsers.size + this.dirtySessions.size + this.goneSessions.size,
    };
  }
}

module.exports = { Store, START_CHIPS, RELOAD_CHIPS };
