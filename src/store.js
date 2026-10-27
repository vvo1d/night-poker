'use strict';
const crypto = require('node:crypto');
const { openStorage } = require('./db');
const { freshStats, unlockNew, tierTotal, TIER_NAMES, category } = require('./achievements');
const daily = require('./daily');
const seasons = require('./seasons');
const shop = require('./shop');
const weekly = require('./weekly');
const levels = require('./levels');

const START_CHIPS = 10000;
// Готовые аватары (public/stock-avatars, см. tools/gen-stock-avatars.js): 15 мужских, 15 женских.
const STOCK_AVATARS = [
  ...Array.from({ length: 15 }, (_, i) => `m${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 15 }, (_, i) => `f${String(i + 1).padStart(2, '0')}`),
];
// Версия в адресе — после перерисовки набора браузеры не покажут старые из кэша.
const STOCK_V = 2;
const stockAvatarUrl = (id) => `/stock-avatars/${id}.svg?v=${STOCK_V}`;
const RELOAD_CHIPS = 2000; // бесплатное пополнение для игроков без фишек
// Приглашение друга: новичок по ссылке сыграл REF_HANDS раздач — оба получают REF_REWARD.
const REF_HANDS = 20;
const REF_REWARD = 2000;
const REF_MAX = 50;        // за стольких друзей пригласивший получает награду (новичок — всегда)

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
    this.refNews = new Map();    // id -> последняя награда за приглашение, для всплывашки
    this.onReferral = null;      // (пригласивший, новичок, награда) — сервер напишет в Telegram
    this.levelNews = new Map();  // id -> последний взятый уровень, для всплывашки
    this.onLevel = null;         // (игрок) — уровень сменился: сервер обновит значок на месте за столом

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
    // Кривая уровней стала круче: опыт переводится один раз, уровень у игрока остаётся прежним.
    if (user.meta.xpCurve !== levels.CURVE) {
      if (user.meta.xp) user.meta.xp = levels.convertXp(user.meta.xp);
      user.meta.xpCurve = levels.CURVE;
      if (user.id) this.dirtyUsers.add(user.id);
    }
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

  async register(name, password, source = null, friend = null) {
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
    this.logStart(user);
    this.linkReferral(user, friend);
    this.touch(user);
    return { user };
  }

  // Новичок пришёл по ссылке друга: запоминаем, кто позвал, и сразу делаем их друзьями.
  linkReferral(user, friendName) {
    const o = friendName ? this.byNameLower(String(friendName)) : null;
    if (!o || o.id === user.id || this.isBanned(o)) return;
    user.meta.invitedBy = o.id;
    if (user.friends.length < FRIENDS_MAX && o.friends.length < FRIENDS_MAX) {
      user.friends.push(o.id);
      if (!o.friends.includes(user.id)) o.friends.push(user.id);
      this.checkAchievements(o);
    }
    this.touch(o);
  }

  // Награда за приглашение — когда новичок сыграл свои первые раздачи:
  // так платим за живого игрока, а не за пустую регистрацию.
  checkReferral(u) {
    const m = u.meta;
    if (!m.invitedBy || m.refPaid || u.handsPlayed < REF_HANDS) return;
    m.refPaid = Date.now();
    const o = this.users.get(m.invitedBy);
    this.addChips(u.id, REF_REWARD, 'Подарок за приглашение');
    this.refNews.set(u.id, { at: m.refPaid, name: o ? o.name : '', amount: REF_REWARD, invitee: true });
    if (!o) return;
    const ref = o.meta.ref || (o.meta.ref = { count: 0, earned: 0 });
    ref.count += 1;
    const paid = ref.count <= REF_MAX ? REF_REWARD : 0;
    if (paid) { ref.earned += paid; this.addChips(o.id, paid, `Приглашённый друг ${u.name}`); this.addXp(o, levels.XP.friend); }
    this.refNews.set(o.id, { at: m.refPaid, name: u.name, amount: paid, invitee: false });
    this.touch(o);
    if (this.onReferral) this.onReferral(o, u, paid);
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
    this.addChips(userId, amount, `Администратор${reason ? `: ${reason}` : ''}`);
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
  telegramUser(tg, source = null, friend = null) {
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
    this.logStart(user);
    this.linkReferral(user, friend);
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

  // Любое изменение банка — с причиной: она попадает в «Историю фишек» игрока.
  // Первая строка истории фишек — стартовый банк нового аккаунта.
  logStart(user) {
    try { this.backend.logChips(user.id, user.createdAt, user.chips, user.chips, 'Стартовый банк'); } catch { /* история не важнее игры */ }
  }

  addChips(userId, amount, reason = 'Прочее') {
    const u = this.users.get(userId);
    if (!u) return;
    u.chips += amount;
    if (amount) {
      try { this.backend.logChips(userId, Date.now(), Math.round(amount), Math.round(u.chips), String(reason).slice(0, 80)); } catch { /* история не важнее игры */ }
    }
    if (u.chips > u.stats.peakChips) { u.stats.peakChips = u.chips; this.checkAchievements(u); }
    this.touch(u);
  }

  // ——— статистика и ачивки ———

  // Итог раздачи для одного игрока: что вложил, что забрал, чем закончил.
  recordHand(userId, r) {
    const u = this.users.get(userId);
    if (!u) return;
    const s = u.stats;
    // Выиграл — если забрал больше, чем вложил: возврат своей же ставки не победа.
    const gain = r.won - r.contributed;
    if (r.won > 0 && gain > 0) {
      s.handsWon += 1;
      s.biggestPot = Math.max(s.biggestPot, r.won);
      if (r.allIn) s.allInsWon += 1;
    } else if (r.contributed > 0 && gain < 0) {
      s.handsLost += 1;
    }
    if (r.showdown) {
      s.showdowns += 1;
      if (gain > 0) s.showdownsWon += 1;
    }
    if (r.result && (!s.bestHand || r.result.value > s.bestHand.value)) {
      s.bestHand = { value: r.result.value, name: r.result.name, cards: r.result.cards };
    }
    if (r.cash) s.cashNet += r.won - r.contributed;

    // Задания дня и недели.
    this.track(u, 'hand');
    if (r.cash) this.track(u, 'cashHand');
    if (gain > 0) {
      this.addXp(u, levels.XP.win);
      this.track(u, 'win');
      if (r.showdown) this.track(u, 'showdownWin');
      else this.track(u, 'quietWin');                    // все сбросили — банк без вскрытия
      if (r.allIn) this.track(u, 'allInWin');
      if (r.withHuman) this.track(u, 'humanWin');
      if (r.bb && r.won >= r.bb * 20) this.track(u, 'bigPot');
      if (r.bb && r.won >= r.bb * 50) this.track(u, 'hugePot');
      if (r.bb && r.cash) this.track(u, 'bbWon', Math.floor(gain / r.bb));   // чистый выигрыш в больших блайндах
    }
    if (r.result && category(r.result.value) >= 4) this.track(u, 'straightPlus');
    if (r.result && category(r.result.value) >= 5) this.track(u, 'flushPlus');
    if (r.result && category(r.result.value) >= 6) this.track(u, 'fullHousePlus');
    if (r.withFriend) this.track(u, 'friendHand');

    // Очки сезона: за раздачу и за банк, выигранный у человека.
    this.seasonPoints(u, 'hand');
    if (gain > 0 && r.withHuman) this.seasonPoints(u, 'winVsHuman');

    this.checkAchievements(u);
    this.touch(u);
  }

  // Турнир: старт или занятое место.
  recordSng(userId, { start = false, place = 0, prize = 0, humans = 0, seats = 0 }) {
    const u = this.users.get(userId);
    if (!u) return;
    const s = u.stats;
    if (start) { s.sngPlayed += 1; this.track(u, 'sngPlay'); this.addXp(u, levels.XP.tour); }
    if (prize > 0) { s.sngCashes += 1; s.sngPrizes += prize; this.track(u, 'sngCash'); this.addXp(u, levels.XP.tourCash); }
    if (place === 1) { s.sngWins += 1; this.track(u, 'tourWin'); }
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
    this.addChips(userId, res.reward, `Бонус за вход, ${res.streak}-й день`);
    this.addXp(u, levels.XP.bonus);
    return res;
  }

  claimQuest(userId, questId) {
    const u = this.users.get(userId);
    if (!u) return { error: 'Игрок не найден' };
    const res = daily.claimQuest(u, String(questId));
    if (res.error) return res;
    this.addChips(userId, res.reward, 'Задание дня');
    this.seasonPoints(u, 'quest');
    this.addXp(u, levels.XP.daily);
    weekly.progress(u, 'dailyDone');   // задание недели «выполните 7 заданий дня»
    return res;
  }

  // Турнир по расписанию: участие, место и приз.
  recordMtt(userId, { start = false, place = 0, prize = 0 }) {
    const u = this.users.get(userId);
    if (!u) return;
    const s = u.stats;
    if (start) {
      s.mttPlayed += 1;
      this.track(u, 'sngPlay');
      this.track(u, 'mttPlay');
      this.addXp(u, levels.XP.tour);
      this.seasonPoints(u, 'mtt', 5);
    }
    if (prize > 0) { s.mttCashes += 1; s.mttPrizes += prize; this.track(u, 'sngCash'); this.addXp(u, levels.XP.tourCash); }
    if (place === 1) { s.mttWins += 1; this.track(u, 'tourWin'); }
    if (place) this.seasonPoints(u, 'mtt', place === 1 ? 60 : prize > 0 ? 25 : 0);
    this.checkAchievements(u);
    this.touch(u);
  }

  // Игровое событие двигает задания дня и недели разом.
  track(u, event, amount = 1) {
    if (amount <= 0) return;
    daily.progress(u, event, amount);
    weekly.progress(u, event, amount);
  }

  // ——— история раздач ———

  // Раздача сыграна: сохраняем её и кладём в «последние раздачи» каждому живому участнику.
  saveHand(record) {
    const uids = record.players.map((x) => x.uid).filter(Boolean);
    if (!uids.length) return null;   // одни боты — смотреть некому
    const id = crypto.randomBytes(6).toString('base64url');
    try {
      this.backend.saveHand(id, record.at, record, uids);
    } catch (err) {
      console.error('Не удалось сохранить раздачу:', err.message);
      return null;
    }
    return id;
  }

  // Что из раздачи видно: свои карты, карты, открытые на вскрытии, и карты того,
  // кто поделился ссылкой. Остальное — рубашкой. Внутренние id игроков наружу не идут.
  handView(h, { viewerId = null, revealSeat = -1 } = {}) {
    const mine = h.players.find((x) => viewerId && x.uid === viewerId);
    return {
      id: h.id, at: h.at, table: h.table, kind: h.kind, sb: h.sb, bb: h.bb, button: h.button,
      board: h.board, pot: h.pot, actions: h.actions,
      mySeat: mine ? mine.seat : revealSeat,
      players: h.players.map((x) => ({
        seat: x.seat, name: x.name, bot: x.bot, stack: x.stack,
        cards: x.shown || x.seat === revealSeat || (mine && x.seat === mine.seat) ? x.cards : null,
        shown: !!x.shown, folded: !!x.folded, won: x.won || 0, net: x.net || 0, hand: x.hand || null,
      })),
    };
  }

  // Последние раздачи игрока — коротко, для списка.
  recentHands(userId) {
    let list = [];
    try { list = this.backend.recentHands(userId); } catch { return []; }
    return list.map((h) => {
      const me = h.players.find((x) => x.uid === userId) || {};
      const top = h.players.reduce((a, b) => ((b.won || 0) > (a.won || 0) ? b : a), {});
      return {
        id: h.id, at: h.at, table: h.table, kind: h.kind, sb: h.sb, bb: h.bb,
        cards: me.cards || [], board: h.board, net: me.net || 0, pot: h.pot,
        hand: me.hand || top.hand || null, winner: top.name || null, players: h.players.length,
      };
    });
  }

  // Раздача целиком — только для её участника.
  handFor(userId, id) {
    const h = this.backend.getHand(String(id));
    if (!h || !h.players.some((x) => x.uid === userId)) return null;
    return this.handView(h, { viewerId: userId });
  }

  // Поделиться: короткий код ссылки; по ней видны карты поделившегося.
  shareHand(userId, id) {
    const h = this.backend.getHand(String(id));
    const me = h && h.players.find((x) => x.uid === userId);
    if (!me) return { error: 'Это не ваша раздача' };
    const code = this.backend.shareHand(h.id, me.seat, userId, crypto.randomBytes(6).toString('base64url'));
    return { ok: true, code };
  }

  sharedHand(code) {
    const share = this.backend.getShare(String(code));
    const h = share && this.backend.getHand(share.handId);
    if (!h) return null;
    const view = this.handView(h, { revealSeat: share.seat });
    view.sharedBy = (h.players.find((x) => x.seat === share.seat) || {}).name || null;
    return view;
  }

  pruneHands(before) {
    try { this.backend.pruneHands(before); } catch (err) { console.error('Чистка истории раздач:', err.message); }
  }

  // ——— уровень ———

  // Опыт: за каждый взятый уровень — фишки, на особых уровнях — предмет из магазина.
  addXp(u, amount) {
    if (!u || amount <= 0) return;
    const before = levels.levelOf(u.meta.xp || 0).level;
    u.meta.xp = (u.meta.xp || 0) + amount;
    const after = levels.levelOf(u.meta.xp).level;
    if (after === before) { this.touch(u); return; }
    let chips = 0;
    const items = [];
    for (let lvl = before + 1; lvl <= after; lvl++) {
      const r = levels.reward(lvl);
      chips += r.chips;
      if (r.item && !shop.view(u).owned.includes(r.item)) {
        const sh = u.meta.shop || (u.meta.shop = { owned: [], equip: {} });
        sh.owned = [...(sh.owned || []), r.item];
        items.push(shop.item(r.item).name);
      }
    }
    this.addChips(u.id, chips, `Уровень ${after}`);
    this.levelNews.set(u.id, { at: Date.now(), level: after, chips, items });
    this.touch(u);
    if (this.onLevel) this.onLevel(u);
  }

  levelOf(u) { return levels.levelOf((u && u.meta.xp) || 0).level; }

  levelView(u) {
    const l = levels.levelOf(u.meta.xp || 0);
    return { ...l, xp: u.meta.xp || 0, next: levels.reward(l.level + 1), news: this.levelNews.get(u.id) || null };
  }

  // ——— задания недели ———

  claimWeekly(userId, questId) {
    const u = this.users.get(userId);
    if (!u) return { error: 'Игрок не найден' };
    const res = weekly.claimQuest(u, String(questId));
    if (res.error) return res;
    this.addChips(userId, res.reward, 'Задание недели');
    this.addXp(u, levels.XP.weekly);
    return res;
  }

  claimChest(userId) {
    const u = this.users.get(userId);
    if (!u) return { error: 'Игрок не найден' };
    const res = weekly.claimChest(u);
    if (res.error) return res;
    this.addChips(userId, res.reward, 'Сундук недели');
    this.addXp(u, levels.XP.chest);
    return res;
  }

  // ——— сезоны ———

  // Очки сезона. Если по дороге закрылся прошлый сезон — выдаём за него награду.
  seasonPoints(u, kind, amount) {
    const finished = seasons.add(u, kind, amount);
    if (finished) this.seasonReward(u, finished);
    this.touch(u);
  }

  seasonReward(u, result) {
    if (result.reward > 0) this.addChips(u.id, result.reward, 'Награда за сезон');
    const league = seasons.leaguesFor(result.key).find((l) => l.id === result.league);
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
    // Резиденты принимают заявку сразу.
    if (this.isBotUser(o) && !this.isBotUser(u)) {
      if (u.friends.length >= FRIENDS_MAX || o.friends.length >= FRIENDS_MAX) return { error: `В друзьях может быть до ${FRIENDS_MAX} игроков` };
      u.friends.push(o.id);
      if (!o.friends.includes(u.id)) o.friends.push(u.id);
      this.checkAchievements(u);
      this.touch(u); this.touch(o);
      return { ok: true, status: 'friend' };
    }
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
        avatar: this.avatarUrl(u),
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
    this.checkReferral(u);
    this.addXp(u, levels.XP.hand);
    this.touch(u);
  }

  reload(userId) {
    const u = this.users.get(userId);
    if (!u) return { error: 'Игрок не найден' };
    if (u.chips >= 200) return { error: 'Пополнение доступно, когда в банке меньше 200 фишек' };
    this.addChips(userId, RELOAD_CHIPS, 'Бесплатное пополнение');
    return { ok: true, chips: u.chips };
  }

  // ——— боты-резиденты ———
  // Резиденты живут как обычные игроки: аккаунт без пароля (войти нельзя), банк,
  // статистика, профиль, рейтинг. Находятся по постоянному ключу — ник можно сменить.
  ensureResident(r, bankroll) {
    let user = [...this.users.values()].find((u) => u.meta && u.meta.resident === r.key);
    if (user) {
      if (user.name !== r.name && !this.byName.has(r.name.toLowerCase())) {
        this.byName.delete(user.name.toLowerCase());
        user.name = r.name;
        this.byName.set(user.name.toLowerCase(), user.id);
      }
      user.meta.residentStyle = r.style;
      if (r.avatar) user.meta.residentAvatar = r.avatar; else delete user.meta.residentAvatar;
      this.touch(user);
      return user;
    }
    if (this.byName.has(r.name.toLowerCase())) return null;   // ник уже занят живым игроком
    user = {
      id: crypto.randomUUID(), name: r.name, salt: '', hash: '',
      chips: bankroll, handsPlayed: 0, createdAt: Date.now() - Math.floor(Math.random() * 60) * 86_400_000,
      meta: { source: 'direct', resident: r.key, residentStyle: r.style, ...(r.avatar ? { residentAvatar: r.avatar } : {}) },
    };
    this.prepare(user);
    this.users.set(user.id, user);
    this.byName.set(user.name.toLowerCase(), user.id);
    this.touch(user);
    return user;
  }

  isBotUser(u) { return !!(u && u.meta && u.meta.resident); }

  // Адрес аватара: своё фото (версия в адресе сбрасывает кэш браузера после замены),
  // иначе — выбранный готовый, иначе у резидента — его из того же набора.
  avatarUrl(u) {
    const meta = u && u.meta;
    if (!meta) return null;
    if (meta.avatar) return `/avatars/${u.id}.${meta.avatar.ext}?v=${meta.avatar.v}`;
    if (STOCK_AVATARS.includes(meta.avatarStock)) return stockAvatarUrl(meta.avatarStock);
    return meta.residentAvatar || null;
  }

  setAvatar(userId, ext) {
    const u = this.users.get(userId);
    if (!u) return null;
    u.meta.avatar = { ext, v: Date.now().toString(36) };
    delete u.meta.avatarStock;
    this.touch(u);
    return this.avatarUrl(u);
  }

  // Готовый аватар вместо фото. Возвращает прежнее фото — его файл сервер удалит.
  setStockAvatar(userId, id) {
    const u = this.users.get(userId);
    if (!u || !STOCK_AVATARS.includes(id)) return { error: 'Такого аватара нет' };
    const old = u.meta.avatar || null;
    delete u.meta.avatar;
    u.meta.avatarStock = id;
    this.touch(u);
    return { ok: true, old };
  }

  // Убрать аватар — и фото, и готовый. Возвращает прежнее фото (или true, если был готовый).
  removeAvatar(userId) {
    const u = this.users.get(userId);
    if (!u || (!u.meta.avatar && !u.meta.avatarStock)) return null;
    const old = u.meta.avatar || true;
    delete u.meta.avatar;
    delete u.meta.avatarStock;
    this.touch(u);
    return old;
  }

  publicUser(id) {
    const u = this.users.get(id);
    if (!u) return null;
    return {
      id: u.id, name: u.name, chips: u.chips, handsPlayed: u.handsPlayed,
      avatar: this.avatarUrl(u),
      achievement: this.news.get(id) || null,   // последняя взятая ступень — клиент покажет всплывашку
      friendRequests: u.friendsIn.length,        // входящие заявки — значок на «Кабинете»
      daily: daily.view(u),                      // бонус за вход и задания дня
      weekly: weekly.view(u),                    // задания недели и сундук
      level: this.levelView(u),                  // уровень, опыт и награда за следующий
      season: seasons.view(u),                   // очки и лига текущего сезона
      telegram: u.tg ? (u.tg.username ? `@${u.tg.username}` : 'привязан') : null,
      referral: this.referralView(u),
      shop: shop.view(u),                        // купленное оформление и что надето
      hasPassword: !!u.hash,
    };
  }

  // ——— магазин оформления ———

  buyItem(userId, id) {
    const u = this.users.get(userId);
    const it = shop.item(id);
    if (!u || !it) return { error: 'Такого предмета нет' };
    const mine = shop.view(u);
    if (mine.owned.includes(it.id)) return { error: 'Уже куплено' };
    if (u.chips < it.price) return { error: 'В банке не хватает фишек' };
    const s = u.meta.shop || (u.meta.shop = { owned: [], equip: {} });
    s.owned = [...(s.owned || []), it.id];
    s.equip = { ...(s.equip || {}), [it.kind]: it.id };   // купленное сразу надеваем
    this.addChips(userId, -it.price, `Магазин: ${it.name}`);
    this.touch(u);
    return { ok: true, item: it };
  }

  equipItem(userId, id) {
    const u = this.users.get(userId);
    const it = shop.item(id);
    if (!u || !it) return { error: 'Такого предмета нет' };
    if (!shop.view(u).owned.includes(it.id)) return { error: 'Сначала купите' };
    const s = u.meta.shop || (u.meta.shop = { owned: [], equip: {} });
    s.equip = { ...(s.equip || {}), [it.kind]: it.id };
    this.touch(u);
    return { ok: true, item: it };
  }

  // Рамка аватара — её видят соперники, поэтому она едет и на место за столом.
  frameOf(u) {
    const id = u ? shop.view(u).equip.frame : null;
    return id && id !== shop.DEFAULTS.frame ? id : null;
  }

  // Приглашения: кто позвал меня и сколько ещё раздач до награды; скольких позвал я.
  referralView(u) {
    const m = u.meta;
    const inviter = m.invitedBy ? this.users.get(m.invitedBy) : null;
    const ref = m.ref || { count: 0, earned: 0 };
    return {
      hands: REF_HANDS,
      reward: REF_REWARD,
      invitedBy: inviter ? inviter.name : null,
      handsLeft: inviter && !m.refPaid ? Math.max(0, REF_HANDS - u.handsPlayed) : 0,
      count: ref.count,
      earned: ref.earned,
      news: this.refNews.get(u.id) || null,
    };
  }

  // История фишек игрока: свежие сверху.
  chipLog(userId, limit) {
    try { return this.backend.chipLog(userId, limit); } catch { return []; }
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

module.exports = { Store, START_CHIPS, RELOAD_CHIPS, REF_HANDS, REF_REWARD, STOCK_AVATARS, stockAvatarUrl };
