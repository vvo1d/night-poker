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
];

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
      (id, name, name_lower, salt, hash, chips, hands_played, created_at)
      VALUES ($id, $name, $nameLower, $salt, $hash, $chips, $hands, $created)
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name, name_lower = excluded.name_lower,
        chips = excluded.chips, hands_played = excluded.hands_played`),
    saveSession: db.prepare(`INSERT INTO sessions (token, user_id, created, seen)
      VALUES ($token, $userId, $created, $seen)
      ON CONFLICT (token) DO UPDATE SET seen = excluded.seen`),
    dropSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    allUsers: db.prepare('SELECT * FROM users'),
    liveSessions: db.prepare('SELECT * FROM sessions WHERE seen > ?'),
    top: db.prepare('SELECT name, chips FROM users ORDER BY chips DESC LIMIT ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM users'),
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

    async close() { await snapshot(); },
  };
}

// Основной путь — база; если её в этой версии Node нет, работаем на файлах.
function openStorage(file) {
  return sqliteBackend(file) || fileBackend(file ? path.dirname(file) : undefined);
}

module.exports = { openStorage, sqliteBackend, fileBackend, hasSqlite: () => !!loadSqlite() };
