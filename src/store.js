'use strict';
const crypto = require('node:crypto');
const { openStorage } = require('./db');
const { freshStats, unlockNew, tierTotal, TIER_NAMES, category } = require('./achievements');
const daily = require('./daily');
const seasons = require('./seasons');

const START_CHIPS = 10000;
const RELOAD_CHIPS = 2000; // бесплатное пополнение для игроков без фишек

const WRITE_EVERY = 400;            // как часто изменения уходят в базу
const LEADERBOARD_TTL = 5_000;      // таблица лидеров пересчитывается не чаще
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const RATING_TTL = 10_000;          // рейтинг пересчитывается не чаще
const RATING_SIZE = 50;
const FRIENDS_MAX = 200;
const REQUESTS_MAX = 100;          // заявок в одну сторону — чтобы ими не засыпали

// По чему строится рейтинг. Ключ уходит клиенту, значение — как достать число.
const RATINGS = {
  chips: (u) => u.chips,
  wins: (u) => u.stats.handsWon,
  sng: (u) => u.stats.sngWins * 1e9 + u.stats.sngPrizes, // победы, при равенстве — призовые
  // Очки текущего сезона: у тех, кто в этом месяце ещё не играл, — ноль.
  season: (u) => (u.meta.season && u.meta.season.key === seasons.seasonKey() ? u.meta.season.points : 0),
};

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
    this.byTg = new Map();       // id в Telegram -> id игрока
    this.sessions = new Map();   // токен -> { userId, created, seen, roomId }

    this.dirtyUsers = new Set();
    this.dirtySessions = new Set();
    this.goneSessions = new Set();
    this.writeTimer = null;
    this.writing = null;

    this.versions = new Map();   // id -> версия (для потока), в базу не попадает
    this.publicJson = new Map(); // id -> готовое событие для потока
    this.board = { at: 0, list: [] };
    this.ratings = new Map();    // вид рейтинга -> { at, order: [id…] }
    this.news = new Map();       // id -> последняя открытая ачивка, для всплывашки

    this.load();
  }

  // Папка с данными: рядом с базой лежит и снимок столов.
  get dataDir() { return require('node:path').dirname(this.backend.where); }

  load() {
    const { users, sessions } = this.backend.load(SESSION_TTL);
    for (const user of users) {
      this.prepare(user);
      this.users.set(user.id, user);
      this.byName.set(user.name.toLowerCase(), user.id);
      if (user.tg) this.byTg.set(user.tg.id, user.id);
    }
    this.convertLegacyFriends();
    for (const user of this.users.values()) {
      // Ступени, заработанные до появления ачивок (раздачи, банк), открываем сразу.
      if (unlockNew(user).length) this.dirtyUsers.add(user.id);
    }
    // Сервер мог стоять в момент смены сезона — подводим итоги сейчас.
    this.seasonSweep();
    for (const [token, rec] of sessions) {
      if (this.users.has(rec.userId)) this.sessions.set(token, rec);
    }
    if (this.dirtyUsers.size) this.schedule();
    console.log(`Хранилище: ${this.backend.kind} (${this.backend.where})`);
    if (this.users.size) console.log(`Загружено игроков: ${this.users.size}, сессий: ${this.sessions.size}`);
  }

  // У игроков, заведённых до кабинета, полей статистики нет — дополняем.
  prepare(user) {
    user.stats = freshStats(user.stats);
    user.achievements = user.achievements || {};
    // Ачивки без ступеней (старый формат: id -> время) пересчитываются заново.
    if (Object.values(user.achievements).some((v) => typeof v !== 'object')) {
      user.achievements = {};
      this.dirtyUsers.add(user.id);
    }
    // Друзья: база отдаёт { list, in, out }, файлы — поля игрока как есть.
    // Голый список без заявок — это прежние односторонние друзья.
    const f = user.friends;
    if (f && !Array.isArray(f)) {
      user.friends = f.list || [];
      user.friendsIn = f.in || [];
      user.friendsOut = f.out || [];
    } else {
      user.friends = f || [];
      if (!user.friendsIn && user.friends.length) user.legacyFriends = true;
      user.friendsIn = user.friendsIn || [];
      user.friendsOut = user.friendsOut || [];
    }
    user.stats.peakChips = Math.max(user.stats.peakChips, user.chips);
    user.meta = user.meta || {};
    if (!Array.isArray(user.meta.days)) user.meta.days = [];
    return user;
  }

  // Раньше дружба была односторонней. Взаимные пары остаются друзьями,
  // односторонние превращаются в заявку, которую второй может принять.
  convertLegacyFriends() {
    const was = new Map();
    for (const u of this.users.values()) if (u.legacyFriends) was.set(u.id, u.friends);
    for (const [id, list] of was) {
      const u = this.users.get(id);
      u.friends = [];
      for (const other of list) {
        const o = this.users.get(other);
        if (!o) continue;
        const back = was.get(other) || o.friends;
        if (back.includes(id)) {
          if (!u.friends.includes(other)) u.friends.push(other);
        } else {
          if (!u.friendsOut.includes(other)) u.friendsOut.push(other);
          if (!o.friendsIn.includes(id)) o.friendsIn.push(id);
          this.dirtyUsers.add(other);
        }
      }
      delete u.legacyFriends;
      this.dirtyUsers.add(id);
    }
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

  async register(name, password, source = null) {
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
      meta: { source: cleanSource(source) },
    };
    this.prepare(user);
    this.users.set(user.id, user);
    this.byName.set(name.toLowerCase(), user.id);
    this.markActive(user);
    this.touch(user);
    return { user };
  }

  async login(name, password) {
    const id = this.byName.get(String(name || '').trim().toLowerCase());
    const user = id && this.users.get(id);
    if (!user) return { error: 'Игрок с таким именем не найден' };
    if (this.isBanned(user)) return { error: 'Аккаунт заблокирован' };
    if (!user.hash) return { error: 'Этот аккаунт входит через Telegram' };
    const attempt = await scrypt(String(password || ''), user.salt);
    const stored = Buffer.from(user.hash, 'hex');
    if (attempt.length !== stored.length || !crypto.timingSafeEqual(attempt, stored)) {
      return { error: 'Неверный пароль' };
    }
    return { user };
  }

  // ——— администрирование ———

  // Что сделал администратор — остаётся в истории игрока.
  adminNote(u, by, text) {
    u.meta.log = [...(u.meta.log || []), { at: Date.now(), by, text }].slice(-50);
    console.log(`Админ ${by}: ${u.name} — ${text}`);
    this.touch(u);
  }

  adjustChips(userId, amount, by, reason = '') {
    const u = this.users.get(userId);
    if (!u) return { error: 'Игрок не найден' };
    amount = Math.round(Number(amount) || 0);
    if (!amount) return { error: 'Укажите сумму' };
    if (u.chips + amount < 0) return { error: `В банке только ${u.chips}` };
    this.addChips(userId, amount);
    this.adminNote(u, by, `${amount > 0 ? '+' : ''}${amount} фишек${reason ? ` (${reason})` : ''}`);
    return { ok: true, chips: u.chips };
  }

  ban(userId, by, reason = '') {
    const u = this.users.get(userId);
    if (!u) return { error: 'Игрок не найден' };
    u.meta.banned = { at: Date.now(), by, reason: String(reason).slice(0, 200) };
    // Все его сессии закрываются сразу.
    for (const [token, s] of this.sessions) if (s.userId === userId) this.destroySession(token);
    this.adminNote(u, by, `заблокирован${reason ? `: ${reason}` : ''}`);
    return { ok: true };
  }

  unban(userId, by) {
    const u = this.users.get(userId);
    if (!u) return { error: 'Игрок не найден' };
    delete u.meta.banned;
    this.adminNote(u, by, 'разблокирован');
    return { ok: true };
  }

  // Новый пароль от администратора — например, если игрок его забыл.
  async setPassword(userId, password, by) {
    const u = this.users.get(userId);
    if (!u) return { error: 'Игрок не найден' };
    u.salt = crypto.randomBytes(16).toString('hex');
    u.hash = (await scrypt(password, u.salt)).toString('hex');
    this.adminNote(u, by, 'задан новый пароль');
    return { ok: true };
  }

  isBanned(u) { return !!(u && u.meta && u.meta.banned); }

  // ——— для аналитики ———

  // День, когда игрок заходил. Храним последние 120 дней — для удержания хватает.
  markActive(u, now = Date.now()) {
    const day = daily.dayKey(now);
    const days = u.meta.days;
    if (days[days.length - 1] === day) return;
    days.push(day);
    if (days.length > 120) days.splice(0, days.length - 120);
    this.touch(u);
  }

  // Первая посадка за стол — главный шаг воронки после регистрации.
  markSit(u, now = Date.now()) {
    if (u.meta.firstSitAt) return;
    u.meta.firstSitAt = now;
    this.touch(u);
  }

  // ——— Telegram ———

  // Имя за столом из Telegram: только разрешённые символы, 3–16 знаков, без повторов.
  nameFromTelegram(tg) {
    const clean = (s) => String(s || '').replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16);
    let base = clean(tg.username) || clean(tg.firstName);
    if (base.length < 3) base = 'Игрок';
    let name = base;
    for (let n = 2; this.byName.has(name.toLowerCase()); n++) {
      const tail = String(n);
      name = `${base.slice(0, 16 - tail.length)}${tail}`;
    }
    return name;
  }

  // Вход через Telegram: свой аккаунт, а при первом входе — новый, без пароля.
  telegramUser(tg, source = null) {
    const known = this.byTg.get(tg.id);
    if (known && this.users.has(known)) {
      const u = this.users.get(known);
      if (this.isBanned(u)) return { error: 'Аккаунт заблокирован' };
      if (tg.username && u.tg.username !== tg.username) { u.tg.username = tg.username; this.touch(u); }
      return { user: u, created: false };
    }
    const user = {
      id: crypto.randomUUID(),
      name: this.nameFromTelegram(tg),
      salt: '',
      hash: '',                       // пароля нет: такой аккаунт входит только через Telegram
      chips: START_CHIPS,
      handsPlayed: 0,
      createdAt: Date.now(),
      tg: { id: tg.id, username: tg.username || null },
      meta: { source: cleanSource(source) || 'telegram' },
    };
    this.prepare(user);
    this.markActive(user);
    this.users.set(user.id, user);
    this.byName.set(user.name.toLowerCase(), user.id);
    this.byTg.set(tg.id, user.id);
    this.touch(user);
    return { user, created: true };
  }

  // Привязать Telegram к уже существующему аккаунту — чтобы входить и так, и так.
  linkTelegram(userId, tg) {
    const u = this.users.get(userId);
    if (!u) return { error: 'Игрок не найден' };
    const other = this.byTg.get(tg.id);
    if (other && other !== userId) return { error: 'Этот Telegram уже привязан к другому аккаунту' };
    if (u.tg && u.tg.id !== tg.id) this.byTg.delete(u.tg.id);
    u.tg = { id: tg.id, username: tg.username || null };
    this.byTg.set(tg.id, userId);
    this.touch(u);
    return { ok: true };
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
    if (u.chips > u.stats.peakChips) { u.stats.peakChips = u.chips; this.checkAchievements(u); }
    this.touch(u);
  }

  // ——— статистика и ачивки ———

  // Итог раздачи для одного игрока: что вложил, что забрал, чем закончил.
  recordHand(userId, r) {
    const u = this.users.get(userId);
    if (!u) return;
    const s = u.stats;
    if (r.won > 0) {
      s.handsWon += 1;
      s.biggestPot = Math.max(s.biggestPot, r.won);
      if (r.allIn) s.allInsWon += 1;
    } else if (r.contributed > 0) {
      s.handsLost += 1;
    }
    if (r.showdown) {
      s.showdowns += 1;
      if (r.won > 0) s.showdownsWon += 1;
    }
    if (r.result && (!s.bestHand || r.result.value > s.bestHand.value)) {
      s.bestHand = { value: r.result.value, name: r.result.name, cards: r.result.cards };
    }
    if (r.cash) s.cashNet += r.won - r.contributed;

    // Задания дня.
    daily.progress(u, 'hand');
    if (r.won > 0) {
      daily.progress(u, 'win');
      if (r.showdown) daily.progress(u, 'showdownWin');
      if (r.allIn) daily.progress(u, 'allInWin');
      if (r.bb && r.won >= r.bb * 20) daily.progress(u, 'bigPot');
    }
    if (r.result && category(r.result.value) >= 4) daily.progress(u, 'straightPlus');
    if (r.withFriend) daily.progress(u, 'friendHand');

    // Очки сезона: за раздачу и за банк, выигранный у человека.
    this.seasonPoints(u, 'hand');
    if (r.won > 0 && r.withHuman) this.seasonPoints(u, 'winVsHuman');

    this.checkAchievements(u);
    this.touch(u);
  }

  // Турнир: старт или занятое место.
  recordSng(userId, { start = false, place = 0, prize = 0, humans = 0, seats = 0 }) {
    const u = this.users.get(userId);
    if (!u) return;
    const s = u.stats;
    if (start) { s.sngPlayed += 1; daily.progress(u, 'sngPlay'); }
    if (prize > 0) { s.sngCashes += 1; s.sngPrizes += prize; daily.progress(u, 'sngCash'); }
    if (place === 1) s.sngWins += 1;
    if (place) this.seasonPoints(u, 'sng', seasons.sngPoints(place, humans, seats));
    this.checkAchievements(u);
    this.touch(u);
  }

  // ——— бонус и задания дня ———

  claimBonus(userId) {
    const u = this.users.get(userId);
    if (!u) return { error: 'Игрок не найден' };
    const res = daily.claimBonus(u);
    if (res.error) return res;
    this.addChips(userId, res.reward);
    return res;
  }

  claimQuest(userId, questId) {
    const u = this.users.get(userId);
    if (!u) return { error: 'Игрок не найден' };
    const res = daily.claimQuest(u, String(questId));
    if (res.error) return res;
    this.addChips(userId, res.reward);
    this.seasonPoints(u, 'quest');
    return res;
  }

  // Турнир по расписанию: участие, место и приз.
  recordMtt(userId, { start = false, place = 0, prize = 0 }) {
    const u = this.users.get(userId);
    if (!u) return;
    const s = u.stats;
    if (start) {
      s.mttPlayed += 1;
      daily.progress(u, 'sngPlay');
      this.seasonPoints(u, 'mtt', 5);
    }
    if (prize > 0) { s.mttCashes += 1; s.mttPrizes += prize; daily.progress(u, 'sngCash'); }
    if (place === 1) s.mttWins += 1;
    if (place) this.seasonPoints(u, 'mtt', place === 1 ? 60 : prize > 0 ? 25 : 0);
    this.checkAchievements(u);
    this.touch(u);
  }

  // ——— сезоны ———

  // Очки сезона. Если по дороге закрылся прошлый сезон — выдаём за него награду.
  seasonPoints(u, kind, amount) {
    const finished = seasons.add(u, kind, amount);
    if (finished) this.seasonReward(u, finished);
    this.touch(u);
  }

  seasonReward(u, result) {
    if (result.reward > 0) this.addChips(u.id, result.reward);
    const league = seasons.LEAGUES.find((l) => l.id === result.league);
    this.news.set(u.id, {
      id: `season-${result.key}`, icon: '🏆', title: `Сезон «${result.name}» — ${league.name}`,
      tierName: result.reward ? `награда ${result.reward}` : 'спасибо за игру', at: Date.now(),
    });
    this.touch(u);
  }

  // Смена сезона: у всех, кто играл в прошлом, подводим итог и выдаём награды.
  seasonSweep(now = Date.now()) {
    const key = seasons.seasonKey(now);
    if (this.seasonChecked === key) return 0;
    this.seasonChecked = key;
    let done = 0;
    for (const u of this.users.values()) {
      if (!u.meta.season || u.meta.season.key === key) continue;
      const finished = seasons.ensure(u, now);
      if (finished) { this.seasonReward(u, finished); done += 1; } else this.touch(u);
    }
    if (done) console.log(`Сезон закрыт: награды получили ${done} игроков`);
    return done;
  }

  checkAchievements(u) {
    const fresh = unlockNew(u);
    if (fresh.length) {
      const { a, tier } = fresh[fresh.length - 1];
      this.news.set(u.id, {
        id: a.id, icon: a.icon, title: a.title, tier, tierName: TIER_NAMES[tier - 1], at: u.achievements[a.id].at,
      });
    }
  }

  // ——— друзья ———

  // Дружба взаимная: один отправляет заявку, второй принимает. Если заявка
  // уже пришла навстречу, «добавить в друзья» её и принимает.
  addFriend(userId, name) {
    const u = this.users.get(userId);
    const o = this.byNameLower(name);
    if (!u) return { error: 'Игрок не найден' };
    if (!o) return { error: 'Игрока с таким именем нет' };
    if (o.id === userId) return { error: 'Себя в друзья не добавить' };
    if (u.friends.includes(o.id)) return { ok: true, status: 'friend' };
    if (u.friendsIn.includes(o.id)) return this.acceptFriend(userId, o.name);
    if (u.friendsOut.includes(o.id)) return { ok: true, status: 'out' };
    if (u.friends.length >= FRIENDS_MAX) return { error: `В друзьях может быть до ${FRIENDS_MAX} игроков` };
    if (u.friendsOut.length >= REQUESTS_MAX) return { error: 'Слишком много заявок ждут ответа' };
    if (o.friendsIn.length >= REQUESTS_MAX) return { error: 'У этого игрока слишком много заявок' };
    u.friendsOut.push(o.id);
    o.friendsIn.push(u.id);
    this.touch(u);
    this.touch(o);
    return { ok: true, status: 'out' };
  }

  acceptFriend(userId, name) {
    const u = this.users.get(userId);
    const o = this.byNameLower(name);
    if (!u || !o || !u.friendsIn.includes(o.id)) return { error: 'Заявки от этого игрока нет' };
    if (u.friends.length >= FRIENDS_MAX || o.friends.length >= FRIENDS_MAX) {
      return { error: `В друзьях может быть до ${FRIENDS_MAX} игроков` };
    }
    this.dropRequest(o, u);
    if (!u.friends.includes(o.id)) u.friends.push(o.id);
    if (!o.friends.includes(u.id)) o.friends.push(u.id);
    for (const x of [u, o]) { this.checkAchievements(x); this.touch(x); }
    return { ok: true, status: 'friend' };
  }

  // Отклонить входящую заявку или отозвать свою — в обоих случаях заявка исчезает.
  declineFriend(userId, name) {
    const u = this.users.get(userId);
    const o = this.byNameLower(name);
    if (!u || !o) return { error: 'Игрок не найден' };
    this.dropRequest(o, u);
    this.dropRequest(u, o);
    this.touch(u);
    this.touch(o);
    return { ok: true, status: 'none' };
  }

  removeFriend(userId, name) {
    const u = this.users.get(userId);
    const o = this.byNameLower(name);
    if (!u || !o) return { error: 'Игрок не найден' };
    u.friends = u.friends.filter((id) => id !== o.id);
    o.friends = o.friends.filter((id) => id !== u.id);
    this.touch(u);
    this.touch(o);
    return { ok: true, status: 'none' };
  }

  // Заявка from → to больше не висит ни у одного из них.
  dropRequest(from, to) {
    from.friendsOut = from.friendsOut.filter((id) => id !== to.id);
    to.friendsIn = to.friendsIn.filter((id) => id !== from.id);
  }

  // Кем приходятся друг другу двое: друзья, заявка туда или обратно, никто.
  relation(u, o) {
    if (u.friends.includes(o.id)) return 'friend';
    if (u.friendsOut.includes(o.id)) return 'out';
    if (u.friendsIn.includes(o.id)) return 'in';
    return 'none';
  }

  byNameLower(name) {
    const id = this.byName.get(String(name || '').trim().toLowerCase());
    return id ? this.users.get(id) : null;
  }

  // ——— рейтинг ———

  // Полный порядок держим в кэше: из него же берётся место того, кто смотрит.
  ratingOrder(by) {
    const now = Date.now();
    let cached = this.ratings.get(by);
    if (cached && now - cached.at < RATING_TTL) return cached.order;
    const score = RATINGS[by];
    const order = [...this.users.values()]
      .sort((a, b) => score(b) - score(a) || a.createdAt - b.createdAt)
      .map((u) => u.id);
    cached = { at: now, order };
    this.ratings.set(by, cached);
    return order;
  }

  rating(by, viewerId) {
    if (!RATINGS[by]) by = 'chips';
    const order = this.ratingOrder(by);
    const row = (id, i) => {
      const u = this.users.get(id);
      if (!u) return null;
      const s = u.stats;
      return {
        place: i + 1,
        name: u.name,
        chips: u.chips,
        hands: u.handsPlayed,
        handsWon: s.handsWon,
        winRate: u.handsPlayed ? Math.round((s.handsWon / u.handsPlayed) * 100) : 0,
        sngWins: s.sngWins,
        sngPrizes: s.sngPrizes,
        achievements: tierTotal(u),
        season: RATINGS.season(u),
        league: seasons.leagueOf(RATINGS.season(u)).id,
        you: id === viewerId,
      };
    };
    const top = order.slice(0, RATING_SIZE).map(row).filter(Boolean);
    const at = order.indexOf(viewerId);
    return { by, top, me: at >= RATING_SIZE ? row(viewerId, at) : null, total: order.length };
  }

  countHand(userId) {
    const u = this.users.get(userId);
    if (!u) return;
    u.handsPlayed += 1;
    this.checkAchievements(u);
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
    return {
      id: u.id, name: u.name, chips: u.chips, handsPlayed: u.handsPlayed,
      achievement: this.news.get(id) || null,   // последняя взятая ступень — клиент покажет всплывашку
      friendRequests: u.friendsIn.length,        // входящие заявки — значок на «Кабинете»
      daily: daily.view(u),                      // бонус за вход и задания дня
      season: seasons.view(u),                   // очки и лига текущего сезона
      telegram: u.tg ? (u.tg.username ? `@${u.tg.username}` : 'привязан') : null,
      hasPassword: !!u.hash,
    };
  }

  // Готовое событие для потока: строка собирается один раз до следующего изменения.
  // В полночь задания и бонус обновляются сами, поэтому кадр помнит, за какой он день.
  publicUserFrame(id) {
    const day = daily.dayKey();
    let cached = this.publicJson.get(id);
    if (cached === undefined || cached.day !== day) {
      const view = this.publicUser(id);
      if (!view) return null;
      cached = { day, frame: `event: user\ndata: ${JSON.stringify(view)}\n\n` };
      this.publicJson.set(id, cached);
    }
    return cached.frame;
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

// Источник прихода — коротко и только безопасные символы: он попадает в отчёты.
function cleanSource(source) {
  const s = String(source || '').toLowerCase().replace(/[^a-z0-9а-яё._-]/gi, '').slice(0, 40);
  return s || null;
}

module.exports = { Store, START_CHIPS, RELOAD_CHIPS };
