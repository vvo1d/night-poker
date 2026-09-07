'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const START_CHIPS = 10000;
const RELOAD_CHIPS = 2000; // бесплатное пополнение для игроков без фишек

class Store {
  constructor() {
    this.users = new Map();      // id -> user
    this.byName = new Map();     // имя в нижнем регистре -> id
    this.sessions = new Map();   // токен -> { userId, created }
    this.saveTimer = null;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      for (const u of raw.users || []) {
        this.users.set(u.id, u);
        this.byName.set(u.name.toLowerCase(), u.id);
      }
      console.log(`Загружено игроков: ${this.users.size}`);
    } catch {
      // Первый запуск — файла ещё нет.
    }
  }

  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const tmp = `${USERS_FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ users: [...this.users.values()] }, null, 2));
        fs.renameSync(tmp, USERS_FILE);
      } catch (err) {
        console.error('Не удалось сохранить данные игроков:', err.message);
      }
    }, 500);
  }

  hash(password, salt) {
    return crypto.scryptSync(password, salt, 64).toString('hex');
  }

  register(name, password) {
    name = String(name || '').trim();
    password = String(password || '');
    if (name.length < 3 || name.length > 16) return { error: 'Имя — от 3 до 16 символов' };
    if (!/^[\p{L}\p{N}_ -]+$/u.test(name)) return { error: 'В имени только буквы, цифры, пробел, дефис и _' };
    if (password.length < 6) return { error: 'Пароль — минимум 6 символов' };
    if (this.byName.has(name.toLowerCase())) return { error: 'Такое имя уже занято' };

    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id: crypto.randomUUID(),
      name,
      salt,
      hash: this.hash(password, salt),
      chips: START_CHIPS,
      handsPlayed: 0,
      createdAt: Date.now(),
    };
    this.users.set(user.id, user);
    this.byName.set(name.toLowerCase(), user.id);
    this.save();
    return { user };
  }

  login(name, password) {
    const id = this.byName.get(String(name || '').trim().toLowerCase());
    const user = id && this.users.get(id);
    if (!user) return { error: 'Игрок с таким именем не найден' };
    const attempt = Buffer.from(this.hash(String(password || ''), user.salt), 'hex');
    const stored = Buffer.from(user.hash, 'hex');
    if (attempt.length !== stored.length || !crypto.timingSafeEqual(attempt, stored)) {
      return { error: 'Неверный пароль' };
    }
    return { user };
  }

  createSession(userId) {
    const token = crypto.randomBytes(24).toString('hex');
    this.sessions.set(token, { userId, created: Date.now(), roomId: null });
    return token;
  }

  session(token) { return token ? this.sessions.get(token) || null : null; }
  destroySession(token) { this.sessions.delete(token); }
  user(id) { return this.users.get(id) || null; }

  addChips(userId, amount) {
    const u = this.users.get(userId);
    if (!u) return;
    u.chips += amount;
    this.save();
  }

  reload(userId) {
    const u = this.users.get(userId);
    if (!u) return { error: 'Игрок не найден' };
    if (u.chips >= 200) return { error: 'Пополнение доступно, когда в банке меньше 200 фишек' };
    u.chips += RELOAD_CHIPS;
    this.save();
    return { ok: true, chips: u.chips };
  }

  publicUser(id) {
    const u = this.users.get(id);
    if (!u) return null;
    return { id: u.id, name: u.name, chips: u.chips, handsPlayed: u.handsPlayed };
  }

  leaderboard(limit = 10) {
    return [...this.users.values()]
      .sort((a, b) => b.chips - a.chips)
      .slice(0, limit)
      .map((u) => ({ name: u.name, chips: u.chips }));
  }
}

module.exports = { Store, START_CHIPS, RELOAD_CHIPS };
