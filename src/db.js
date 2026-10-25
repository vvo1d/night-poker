'use strict';
// Где лежат игроки. Движка два:
//
//   sqlite — настоящая база, встроенная в Node с версии 22.5. Основной путь.
//   files  — снимок JSON плюс журнал дозаписи. Запасной, для Node без SQLite.
//
// Оба отдают одинаковый интерфейс, поэтому хранилище о разнице не знает.
// Зависимостей нет ни в том, ни в другом случае.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_DB = process.env.DB_FILE || path.join(DATA_DIR, 'poker.db');

// ——— SQLite ———

// Схема растёт шагами: новый шаг дописывается в конец, номер применённого
// хранится в самой базе. Обновление происходит при запуске.
const MIGRATIONS = [
  (db) => db.exec(`
    CREATE TABLE users (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      name_lower   TEXT NOT NULL,
      salt         TEXT NOT NULL,
      hash         TEXT NOT NULL,
      chips        INTEGER NOT NULL,
      hands_played INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX users_name ON users (name_lower);
    CREATE INDEX users_chips ON users (chips DESC);

    CREATE TABLE sessions (
      token   TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      created INTEGER NOT NULL,
      seen    INTEGER NOT NULL
    );
    CREATE INDEX sessions_seen ON sessions (seen);
  `),
  // Кабинет игрока: статистика, ачивки и друзья. Это небольшие JSON-поля:
  // читаются целиком при старте, а искать по ним базе незачем.
  (db) => db.exec(`
    ALTER TABLE users ADD COLUMN stats TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE users ADD COLUMN achievements TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE users ADD COLUMN friends TEXT NOT NULL DEFAULT '[]';
  `),
  // Привязка к Telegram: { id, username } или NULL.
  (db) => db.exec(`
    ALTER TABLE users ADD COLUMN telegram TEXT;
  `),
  // Служебное по игроку: откуда пришёл, в какие дни играл, бан, сезон.
  (db) => db.exec(`
    ALTER TABLE users ADD COLUMN meta TEXT NOT NULL DEFAULT '{}';
  `),
  // История раздач: сама раздача, у каждого участника — его последние раздачи,
  // и ссылки «поделиться» (раздача, которой поделились, хранится без срока).
  (db) => db.exec(`
    CREATE TABLE hands (
      id   TEXT PRIMARY KEY,
      at   INTEGER NOT NULL,
      data TEXT NOT NULL,
      keep INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX hands_at ON hands (at);
    CREATE TABLE user_hands (
      user_id TEXT NOT NULL,
      hand_id TEXT NOT NULL,
      at      INTEGER NOT NULL,
      PRIMARY KEY (user_id, hand_id)
    );
    CREATE INDEX user_hands_recent ON user_hands (user_id, at DESC);
    CREATE TABLE hand_shares (
      code    TEXT PRIMARY KEY,
      hand_id TEXT NOT NULL,
      seat    INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      at      INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX hand_shares_owner ON hand_shares (hand_id, user_id);
  `),
];

const HANDS_PER_USER = 20;

function parseJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

let warningsFiltered = false;

// node:sqlite помечен экспериментальным и печатает предупреждение при загрузке.
// Оно ничего не сообщает, а в журнале сервера только мешает.
function hideExperimentalWarning() {
  if (warningsFiltered) return;
  warningsFiltered = true;
  const others = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (w) => {
    if (/SQLite is an experimental/.test(w.message)) return;
    for (const listener of others) listener(w);
  });
}

function loadSqlite() {
  try {
    // node:sqlite появился в Node 22.5. На более старых версиях его просто нет.
    hideExperimentalWarning();
    const sqlite = require('node:sqlite');
    return sqlite && sqlite.DatabaseSync ? sqlite : null;
  } catch {
    return null;
  }
}

function sqliteBackend(file = DEFAULT_DB) {
  const sqlite = loadSqlite();
  if (!sqlite) return null;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');    // чтение не ждёт записи
  db.exec('PRAGMA synchronous = NORMAL');  // для игры достаточно, заметно быстрее
  db.exec('PRAGMA foreign_keys = ON');

  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let step = version; step < MIGRATIONS.length; step++) {
    MIGRATIONS[step](db);
    db.exec(`PRAGMA user_version = ${step + 1}`);
  }

  const sql = {
    saveUser: db.prepare(`INSERT INTO users
      (id, name, name_lower, salt, hash, chips, hands_played, created_at, stats, achievements, friends, telegram, meta)
      VALUES ($id, $name, $nameLower, $salt, $hash, $chips, $hands, $created, $stats, $achievements, $friends, $telegram, $meta)
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name, name_lower = excluded.name_lower, salt = excluded.salt, hash = excluded.hash,
        chips = excluded.chips, hands_played = excluded.hands_played,
        stats = excluded.stats, achievements = excluded.achievements, friends = excluded.friends,
        telegram = excluded.telegram, meta = excluded.meta`),
    saveSession: db.prepare(`INSERT INTO sessions (token, user_id, created, seen)
      VALUES ($token, $userId, $created, $seen)
      ON CONFLICT (token) DO UPDATE SET seen = excluded.seen`),
    dropSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    allUsers: db.prepare('SELECT * FROM users'),
    liveSessions: db.prepare('SELECT * FROM sessions WHERE seen > ?'),
    top: db.prepare('SELECT name, chips FROM users ORDER BY chips DESC LIMIT ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM users'),
    addHand: db.prepare('INSERT OR IGNORE INTO hands (id, at, data) VALUES (?, ?, ?)'),
    linkHand: db.prepare('INSERT OR IGNORE INTO user_hands (user_id, hand_id, at) VALUES (?, ?, ?)'),
    trimHands: db.prepare(`DELETE FROM user_hands WHERE user_id = ? AND hand_id NOT IN
      (SELECT hand_id FROM user_hands WHERE user_id = ? ORDER BY at DESC LIMIT ${HANDS_PER_USER})`),
    recentHands: db.prepare(`SELECT h.id, h.data FROM user_hands u JOIN hands h ON h.id = u.hand_id
      WHERE u.user_id = ? ORDER BY u.at DESC LIMIT ?`),
    getHand: db.prepare('SELECT id, data FROM hands WHERE id = ?'),
    keepHand: db.prepare('UPDATE hands SET keep = 1 WHERE id = ?'),
    shareOf: db.prepare('SELECT code FROM hand_shares WHERE hand_id = ? AND user_id = ?'),
    addShare: db.prepare('INSERT INTO hand_shares (code, hand_id, seat, user_id, at) VALUES (?, ?, ?, ?, ?)'),
    getShare: db.prepare('SELECT hand_id, seat FROM hand_shares WHERE code = ?'),
    pruneHands: db.prepare('DELETE FROM hands WHERE at < ? AND keep = 0'),
    pruneLinks: db.prepare('DELETE FROM user_hands WHERE at < ?'),
  };

  importOldFiles(db, sql, path.dirname(file));

  return {
    kind: 'sqlite',
    where: file,

    load(sessionTtl) {
      const users = sql.allUsers.all().map((row) => ({
        id: row.id,
        name: row.name,
        salt: row.salt,
        hash: row.hash,
        chips: row.chips,
        handsPlayed: row.hands_played,
        createdAt: row.created_at,
        stats: parseJson(row.stats, {}),
        achievements: parseJson(row.achievements, {}),
        friends: parseJson(row.friends, []),
        tg: row.telegram ? parseJson(row.telegram, null) : null,
        meta: parseJson(row.meta, {}),
      }));
      const sessions = sql.liveSessions.all(Date.now() - sessionTtl)
        .map((row) => [row.token, { userId: row.user_id, created: row.created, seen: row.seen, roomId: null }]);
      return { users, sessions };
    },

    // Всё накопленное пишется одной транзакцией: тысяча изменений стоит
    // столько же обращений к диску, сколько одно.
    save({ users, sessions, gone }) {
      db.exec('BEGIN');
      try {
        for (const u of users) {
          sql.saveUser.run({
            id: u.id, name: u.name, nameLower: u.name.toLowerCase(), salt: u.salt, hash: u.hash,
            chips: Math.round(u.chips), hands: Math.round(u.handsPlayed), created: u.createdAt,
            stats: JSON.stringify(u.stats || {}),
            achievements: JSON.stringify(u.achievements || {}),
            // Друзья и заявки в обе стороны — одним полем.
            friends: JSON.stringify({ list: u.friends || [], in: u.friendsIn || [], out: u.friendsOut || [] }),
            telegram: u.tg ? JSON.stringify(u.tg) : null,
            meta: JSON.stringify(u.meta || {}),
          });
        }
        for (const [token, s] of sessions) {
          sql.saveSession.run({ token, userId: s.userId, created: s.created, seen: s.seen });
        }
        for (const token of gone) sql.dropSession.run(token);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    top(limit) { return sql.top.all(limit); },

    // ——— история раздач ———
    saveHand(id, at, data, userIds) {
      db.exec('BEGIN');
      try {
        sql.addHand.run(id, at, JSON.stringify(data));
        for (const uid of userIds) {
          sql.linkHand.run(uid, id, at);
          sql.trimHands.run(uid, uid);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    recentHands(userId, limit = HANDS_PER_USER) {
      return sql.recentHands.all(userId, limit).map((row) => ({ id: row.id, ...parseJson(row.data, {}) }));
    },
    getHand(id) {
      const row = sql.getHand.get(id);
      return row ? { id: row.id, ...parseJson(row.data, {}) } : null;
    },
    // Ссылка «поделиться»: одна на игрока и раздачу; раздача с ней больше не удаляется.
    shareHand(handId, seat, userId, code) {
      const had = sql.shareOf.get(handId, userId);
      if (had) return had.code;
      sql.addShare.run(code, handId, seat, userId, Date.now());
      sql.keepHand.run(handId);
      return code;
    },
    getShare(code) {
      const row = sql.getShare.get(code);
      return row ? { handId: row.hand_id, seat: row.seat } : null;
    },
    pruneHands(before) {
      sql.pruneHands.run(before);
      sql.pruneLinks.run(before);
    },

    close() { db.close(); },
  };
}

// Переезд со старого хранения: снимок JSON плюс журнал дозаписи.
// Файлы не удаляем, а переименовываем — чтобы было куда вернуться.
function importOldFiles(db, sql, dir) {
  if (sql.count.get().n > 0) return;

  const usersFile = path.join(dir, 'users.json');
  const journalFile = path.join(dir, 'users.log');
  const sessionsFile = path.join(dir, 'sessions.json');

  const users = readOldUsers(usersFile, journalFile);
  if (!users.size) return;

  const insert = db.prepare(`INSERT OR REPLACE INTO users
    (id, name, name_lower, salt, hash, chips, hands_played, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const addSession = db.prepare('INSERT OR REPLACE INTO sessions (token, user_id, created, seen) VALUES (?, ?, ?, ?)');

  db.exec('BEGIN');
  try {
    for (const u of users.values()) {
      insert.run(u.id, u.name, u.name.toLowerCase(), u.salt, u.hash,
        Math.round(u.chips || 0), Math.round(u.handsPlayed || 0), u.createdAt || Date.now());
    }
    let sessions = 0;
    try {
      for (const [token, rec] of JSON.parse(fs.readFileSync(sessionsFile, 'utf8'))) {
        if (!users.has(rec.userId)) continue;
        addSession.run(token, rec.userId, rec.created || Date.now(), rec.seen || Date.now());
        sessions += 1;
      }
    } catch { /* сессий нет */ }
    db.exec('COMMIT');
    console.log(`Перенесено в базу: игроков ${users.size}, сессий ${sessions}`);
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('Не удалось перенести старые данные:', err.message);
    return;
  }

  for (const file of [usersFile, journalFile, sessionsFile]) {
    try { fs.renameSync(file, `${file}.imported`); } catch { /* файла не было */ }
  }
}

function readOldUsers(usersFile, journalFile) {
  const users = new Map();
  try {
    for (const u of JSON.parse(fs.readFileSync(usersFile, 'utf8')).users || []) users.set(u.id, u);
  } catch { /* снимка нет */ }
  try {
    for (const line of fs.readFileSync(journalFile, 'utf8').split('\n')) {
      if (!line) continue;
      try { const u = JSON.parse(line); users.set(u.id, u); } catch { /* обрезанная строка в конце */ }
    }
  } catch { /* журнала нет */ }
  return users;
}

// ——— файлы ———

const SNAPSHOT_EVERY = 60_000;   // как часто переписывается полный снимок
const JOURNAL_LIMIT = 20_000;    // после стольких записей журнал сворачивается

function fileBackend(dir = DATA_DIR) {
  const usersFile = path.join(dir, 'users.json');
  const journalFile = path.join(dir, 'users.log');
  const sessionsFile = path.join(dir, 'sessions.json');

  let journalCount = 0;
  let snapshotAt = Date.now();
  let known = new Map();   // что лежит в файлах — нужно для снимка

  const handsFile = path.join(dir, 'hands.json');
  const hands = { byId: new Map(), byUser: new Map(), shares: new Map() };
  try {
    const raw = JSON.parse(fs.readFileSync(handsFile, 'utf8'));
    hands.byId = new Map(raw.byId || []);
    hands.byUser = new Map(raw.byUser || []);
    hands.shares = new Map(raw.shares || []);
  } catch { /* истории ещё нет */ }
  let handsTimer = null;
  const writeHands = () => {
    clearTimeout(handsTimer);
    handsTimer = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${handsFile}.tmp`, JSON.stringify({
        byId: [...hands.byId], byUser: [...hands.byUser], shares: [...hands.shares],
      }));
      fs.renameSync(`${handsFile}.tmp`, handsFile);
    } catch (err) { console.error('Не удалось сохранить историю раздач:', err.message); }
  };
  const saveHandsSoon = () => {
    if (handsTimer) return;
    handsTimer = setTimeout(writeHands, 5000);
    handsTimer.unref();   // запись истории не должна держать процесс при остановке
  };

  const snapshot = async () => {
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${usersFile}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ users: [...known.values()] }));
    await fsp.rename(tmp, usersFile);
    await fsp.rm(journalFile, { force: true });
    journalCount = 0;
    snapshotAt = Date.now();
  };

  return {
    kind: 'файлы',
    where: usersFile,

    load(sessionTtl) {
      known = readOldUsers(usersFile, journalFile);
      journalCount = known.size;
      const users = [...known.values()];
      let sessions = [];
      try {
        const now = Date.now();
        sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'))
          .filter(([, rec]) => known.has(rec.userId) && now - rec.seen < sessionTtl)
          .map(([token, rec]) => [token, { ...rec, roomId: null }]);
      } catch { /* сессий нет */ }
      return { users, sessions };
    },

    // Изменение — это одна дописанная строка; полный снимок пишется редко.
    async save({ users, sessions, gone, allSessions }) {
      await fsp.mkdir(dir, { recursive: true });
      for (const u of users) known.set(u.id, u);

      if (journalCount + users.length > JOURNAL_LIMIT || Date.now() - snapshotAt > SNAPSHOT_EVERY) {
        await snapshot();
      } else if (users.length) {
        await fsp.appendFile(journalFile, `${users.map((u) => JSON.stringify(u)).join('\n')}\n`);
        journalCount += users.length;
      }

      if (sessions.length || gone.length) {
        const tmp = `${sessionsFile}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(allSessions()));
        await fsp.rename(tmp, sessionsFile);
      }
    },

    top(limit, users) {
      return [...users.values()]
        .sort((a, b) => b.chips - a.chips)
        .slice(0, limit)
        .map((u) => ({ name: u.name, chips: u.chips }));
    },

    // ——— история раздач: в памяти и файлом hands.json (запасной путь) ———
    saveHand(id, at, data, userIds) {
      if (!hands.byId.has(id)) hands.byId.set(id, { id, at, data, keep: false });
      for (const uid of userIds) {
        const list = (hands.byUser.get(uid) || []).filter((x) => x !== id);
        list.unshift(id);
        hands.byUser.set(uid, list.slice(0, HANDS_PER_USER));
      }
      saveHandsSoon();
    },
    recentHands(userId, limit = HANDS_PER_USER) {
      return (hands.byUser.get(userId) || []).slice(0, limit)
        .map((id) => hands.byId.get(id)).filter(Boolean).map((h) => ({ id: h.id, ...h.data }));
    },
    getHand(id) {
      const h = hands.byId.get(id);
      return h ? { id: h.id, ...h.data } : null;
    },
    shareHand(handId, seat, userId, code) {
      for (const [c, x] of hands.shares) if (x.handId === handId && x.userId === userId) return c;
      hands.shares.set(code, { handId, seat, userId });
      const h = hands.byId.get(handId);
      if (h) h.keep = true;
      saveHandsSoon();
      return code;
    },
    getShare(code) {
      const x = hands.shares.get(code);
      return x ? { handId: x.handId, seat: x.seat } : null;
    },
    pruneHands(before) {
      for (const [id, h] of hands.byId) if (h.at < before && !h.keep) hands.byId.delete(id);
      for (const [uid, list] of hands.byUser) hands.byUser.set(uid, list.filter((id) => hands.byId.has(id)));
      saveHandsSoon();
    },

    async close() { await snapshot(); writeHands(); },
  };
}

// Основной путь — база; если её в этой версии Node нет, работаем на файлах.
// Оба движка кладут данные в одну и ту же папку, заданную DB_FILE.
function openStorage(file = DEFAULT_DB) {
  return sqliteBackend(file) || fileBackend(path.dirname(file));
}

module.exports = { openStorage, sqliteBackend, fileBackend, hasSqlite: () => !!loadSqlite() };
