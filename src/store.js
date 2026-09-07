'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const JOURNAL_FILE = path.join(DATA_DIR, 'users.log');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

const START_CHIPS = 10000;
const RELOAD_CHIPS = 2000; // бесплатное пополнение для игроков без фишек

const SNAPSHOT_EVERY = 60_000;      // как часто переписываем полный снимок
const JOURNAL_FLUSH = 400;          // как часто дописываем изменения
const JOURNAL_LIMIT = 20_000;       // после стольких записей журнал сворачивается в снимок
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

class Store {
  constructor() {
    this.users = new Map();      // id -> user
    this.byName = new Map();     // имя в нижнем регистре -> id
    this.sessions = new Map();   // токен -> { userId, created, roomId }
    this.dirty = new Set();      // кого нужно записать в журнал
    this.versions = new Map();   // id -> версия (для потока), в файл не попадает
    this.publicJson = new Map(); // id -> готовый JSON публичного вида
    this.journalCount = 0;
    this.writing = false;
    this.snapshotAt = Date.now();
    this.flushTimer = null;
    this.board = { at: 0, list: [] };
    this.load();
  }

  // ——— хранение ———
  // Снимок + журнал: изменение фишек дописывает одну строку, а не переписывает
  // файл целиком. На десяти тысячах игроков разница между килобайтом и мегабайтами.

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      for (const u of raw.users || []) this.put(u);
    } catch { /* первый запуск */ }

    try {
      const journal = fs.readFileSync(JOURNAL_FILE, 'utf8');
      let applied = 0;
      for (const line of journal.split('\n')) {
        if (!line) continue;
        try { this.put(JSON.parse(line)); applied += 1; } catch { /* обрезанная строка в конце */ }
      }
      this.journalCount = applied;
    } catch { /* журнала нет */ }

    // Сессии переживают перезапуск: иначе после каждого обновления сервера
    // тысячи игроков вылетают на экран входа.
    try {
      const saved = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      const now = Date.now();
      for (const [token, rec] of saved) {
        if (this.users.has(rec.userId) && now - rec.seen < SESSION_TTL) {
          this.sessions.set(token, { ...rec, roomId: null });
        }
      }
    } catch { /* сессий нет */ }

    if (this.users.size) {
      console.log(`Загружено игроков: ${this.users.size}, сессий: ${this.sessions.size}`);
    }
  }

  async saveSessions() {
    try {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${SESSIONS_FILE}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify([...this.sessions.entries()]));
      await fsp.rename(tmp, SESSIONS_FILE);
    } catch (err) {
      console.error('Не удалось сохранить сессии:', err.message);
    }
  }

  put(user) {
    this.publicJson.delete(user.id);
    const known = this.users.get(user.id);
    if (known && known.name !== user.name) this.byName.delete(known.name.toLowerCase());
    this.users.set(user.id, user);
    this.byName.set(user.name.toLowerCase(), user.id);
  }

  touch(user) {
    // Версия и готовый JSON живут рядом с игроком, а не внутри него:
    // в файл должны попадать только настоящие данные.
    this.versions.set(user.id, (this.versions.get(user.id) || 0) + 1);
    this.publicJson.delete(user.id);
    this.dirty.add(user.id);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), JOURNAL_FLUSH);
  }

  async flush() {
    this.flushTimer = null;
    if (this.writing || !this.dirty.size) return;
    this.writing = true;
    const batch = [...this.dirty];
    this.dirty.clear();
    try {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      const needSnapshot = this.journalCount + batch.length > JOURNAL_LIMIT
        || Date.now() - this.snapshotAt > SNAPSHOT_EVERY;
      if (needSnapshot) {
        await this.snapshot();
      } else {
        const lines = batch
          .map((id) => this.users.get(id))
          .filter(Boolean)
          .map((u) => JSON.stringify(u))
          .join('\n');
        if (lines) await fsp.appendFile(JOURNAL_FILE, `${lines}\n`);
        this.journalCount += batch.length;
      }
    } catch (err) {
      console.error('Не удалось сохранить игроков:', err.message);
      for (const id of batch) this.dirty.add(id); // попробуем в следующий раз
    } finally {
      this.writing = false;
      if (this.dirty.size && !this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), JOURNAL_FLUSH);
    }
  }

  // Полный снимок пишется редко: во временный файл и переименованием.
  async snapshot() {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${USERS_FILE}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ users: [...this.users.values()] }));
    await fsp.rename(tmp, USERS_FILE);
    await fsp.rm(JOURNAL_FILE, { force: true });
    this.journalCount = 0;
    this.snapshotAt = Date.now();
  }

  // Вызывается при остановке сервера, чтобы ничего не потерялось.
  // Снимок пишется из памяти, поэтому он заведомо новее журнала:
  // при остановке достаточно свернуть всё в него.
  async close() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.dirty.clear();
    await this.snapshot();
    await this.saveSessions();
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
    this.put(user);
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
    this.sessions.set(token, { userId, created: Date.now(), seen: Date.now(), roomId: null });
    return token;
  }

  session(token) {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    s.seen = Date.now();
    return s;
  }

  destroySession(token) { this.sessions.delete(token); }

  // Забытые сессии не должны копиться в памяти.
  purgeSessions(now = Date.now()) {
    let gone = 0;
    for (const [token, s] of this.sessions) {
      if (now - s.seen > SESSION_TTL) { this.sessions.delete(token); gone += 1; }
    }
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

  // Готовый JSON публичного вида кэшируется на самом игроке: в потоке
  // состояние игрока уходит тысячам соединений, пересобирать его каждый раз незачем.
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

  // Таблица лидеров считается перебором всех игроков, поэтому кэшируется.
  leaderboard(limit = 10) {
    const now = Date.now();
    if (now - this.board.at < LEADERBOARD_TTL) return this.board.list;
    const top = [];
    for (const u of this.users.values()) {
      if (top.length < limit) {
        top.push(u);
        if (top.length === limit) top.sort((a, b) => b.chips - a.chips);
      } else if (u.chips > top[limit - 1].chips) {
        top[limit - 1] = u;
        top.sort((a, b) => b.chips - a.chips);
      }
    }
    if (top.length < limit) top.sort((a, b) => b.chips - a.chips);
    this.board = { at: now, list: top.map((u) => ({ name: u.name, chips: u.chips })) };
    return this.board.list;
  }
}

module.exports = { Store, START_CHIPS, RELOAD_CHIPS };
