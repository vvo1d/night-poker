'use strict';
// Турниры по расписанию: много столов, пересадка игроков, финальный стол.
//
// Турнир живёт так: регистрация → старт в назначенное время (если людей меньше
// MIN_PLAYERS, недостающих добирают боты) → игра на вылет с ростом блайндов
// по часам → победитель.
// Столы — обычные Table, у каждого вместо Tournament стоит «переходник»
// (tableTour): сам стол спрашивает у него блайнды и сообщает о вылетевших,
// а турнир решает, какие места и призы им положены и кого куда пересадить.

const crypto = require('node:crypto');
const { dayKey } = require('./daily');
const { BOT_NAMES } = require('./bot');

const TABLE_SEATS = 9;
const STACK = 5000;
const LEVEL_MS = 5 * 60_000;           // блайнды растут каждые 5 минут
const TIMEOUT = 20;                    // секунд на ход
const MIN_PLAYERS = 4;                 // меньше — недостающих добирают боты
const BOT_FILL = 6;                    // до стольких участников добираем ботами, если людей мало
const REG_OPENS_MS = 12 * 3600_000;    // регистрация открывается за 12 часов
const KEEP_DONE_MS = 60 * 60_000;      // законченный турнир виден в лобби ещё час
const REMIND_MS = 5 * 60_000;          // напоминание за 5 минут до старта

const LEVELS = [
  [25, 50], [50, 100], [75, 150], [100, 200], [150, 300], [200, 400], [300, 600],
  [400, 800], [500, 1000], [700, 1400], [1000, 2000], [1500, 3000], [2000, 4000],
  [3000, 6000], [5000, 10000], [7500, 15000], [10000, 20000], [15000, 30000],
];

// Ежедневное расписание, время — московское.
const SCHEDULE = [
  { key: 'day', time: '15:00', name: 'Дневной турнир', buyIn: 1000, guarantee: 10000 },
  { key: 'evening', time: '21:00', name: 'Вечерний фриролл', buyIn: 0, guarantee: 30000 },
];

const MSK = 3 * 3600_000;

// Момент «сегодня в HH:MM по Москве» (или завтра, если уже прошло).
function nextAt(time, now = Date.now()) {
  const [h, m] = time.split(':').map(Number);
  const day = dayKey(now);
  let at = Date.parse(`${day}T00:00:00Z`) - MSK + (h * 60 + m) * 60_000;
  if (at <= now) at += 24 * 3600_000;
  return at;
}

// Сколько мест платных и как делится фонд: ~15% поля, каждое следующее место
// получает примерно на четверть меньше предыдущего.
function payouts(entrants, pool) {
  const paid = entrants <= 3 ? 1 : entrants <= 6 ? 2 : Math.max(3, Math.round(entrants * 0.15));
  const weights = Array.from({ length: paid }, (_, i) => 0.74 ** i);
  const sum = weights.reduce((a, b) => a + b, 0);
  const prizes = weights.map((w) => Math.floor((pool * w) / sum));
  prizes[0] += pool - prizes.reduce((a, b) => a + b, 0);
  return prizes;
}

class Mtt {
  // hooks: createTable(cfg, tour, mtt) → Table, dropTable(table), pay(entry, amount),
  // refund(entry, amount), record(entry, info), notify(userId, text)
  constructor({ id, name, startAt, buyIn = 0, guarantee = 0, scheduled = null }, hooks) {
    this.id = id;
    this.name = name;
    this.startAt = startAt;
    this.buyIn = buyIn;
    this.guarantee = guarantee;
    this.scheduled = scheduled;
    this.hooks = hooks;
    this.status = 'registering';     // registering → running → finished | cancelled
    this.entries = new Map();        // userId -> { userId, name, isBot }
    this.tables = new Set();
    this.places = [];                // { place, userId, name, prize }
    this.prizes = [];
    this.entrants = 0;
    this.alive = 0;
    this.level = 0;
    this.startedAt = 0;
    this.finishedAt = 0;
    this.reminded = false;
    this.seq = 0;
  }

  get pool() {
    return Math.max(this.guarantee, (this.status === 'registering' ? this.entries.size : this.entrants) * this.buyIn);
  }

  blinds(level = this.level) {
    return LEVELS[Math.min(level, LEVELS.length - 1)];
  }

  // ——— регистрация ———

  register(entry, chips) {
    if (this.status !== 'registering') return { error: 'Регистрация уже закрыта' };
    if (this.entries.has(entry.userId)) return { ok: true };
    if (this.buyIn > chips) return { error: `Для участия нужно ${this.buyIn} фишек в банке` };
    this.entries.set(entry.userId, entry);
    return { ok: true, pay: this.buyIn };
  }

  unregister(userId) {
    const entry = this.entries.get(userId);
    if (!entry || this.status !== 'registering') return { error: 'Вы не записаны' };
    this.entries.delete(userId);
    if (!entry.isBot && this.buyIn) this.hooks.refund(entry, this.buyIn);
    return { ok: true };
  }

  // Добрать ботов: при малом онлайне турнир не отменяется, а играется с ботами.
  addBots(count) {
    for (let i = 0; i < count; i++) {
      const n = this.entries.size + 1;
      const userId = `bot-${crypto.randomUUID()}`;
      this.entries.set(userId, { userId, name: `${BOT_NAMES[n % BOT_NAMES.length]}-${n}`, isBot: true });
    }
  }

  // Отмена: до старта — взносы назад; во время игры — невыплаченный фонд делится по стекам.
  cancel(reason = 'отменён') {
    if (this.status === 'registering') {
      for (const e of this.entries.values()) if (!e.isBot && this.buyIn) this.hooks.refund(e, this.buyIn);
    } else if (this.status === 'running') {
      const left = this.prizes.reduce((a, b) => a + b, 0) - this.places.reduce((s, p) => s + p.prize, 0);
      const seated = [];
      for (const t of this.tables) for (const p of t.players()) seated.push(p);
      const total = seated.reduce((s, p) => s + p.stack + (p.inHand ? p.contributed : 0), 0);
      for (const p of seated) {
        const share = total ? Math.floor((left * (p.stack + (p.inHand ? p.contributed : 0))) / total) : 0;
        if (!p.isBot && share > 0) this.hooks.refund({ userId: p.userId, name: p.name }, share);
      }
      for (const t of [...this.tables]) this.closeTable(t);
    }
    this.status = 'cancelled';
    this.cancelReason = reason;
    this.finishedAt = Date.now();
  }

  // ——— старт ———

  start(now = Date.now()) {
    const list = [...this.entries.values()];
    // Случайная рассадка: перемешиваем и раздаём по столам по кругу.
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    this.status = 'running';
    this.startedAt = now;
    this.entrants = list.length;
    this.alive = list.length;
    this.prizes = payouts(this.entrants, this.pool);
    const count = Math.ceil(list.length / TABLE_SEATS);
    const tables = Array.from({ length: count }, () => this.openTable());
    list.forEach((entry, i) => {
      const table = tables[i % count];
      const seat = table.seats.findIndex((s) => s === null);
      table.sit({ id: entry.userId, name: entry.name, isBot: entry.isBot }, seat, STACK);
      const p = table.byUser(entry.userId);
      // Кого нет онлайн — пропускает раздачи, но в турнире: блайнды платит, карты сбрасываются.
      if (p && !entry.isBot && !this.hooks.isOnline(entry.userId)) p.sittingOut = true;
      if (!entry.isBot) this.hooks.record(entry, { start: true, entrants: this.entrants });
    });
    for (const t of tables) t.note(`Турнир «${this.name}» начался: ${this.entrants} игроков, фонд ${this.pool}`, 'result');
  }

  openTable() {
    this.seq += 1;
    const [sb, bb] = this.blinds();
    const table = this.hooks.createTable({
      name: `${this.name} · стол ${this.seq}`,
      maxSeats: TABLE_SEATS, sb, bb, minBuyIn: 1, maxBuyIn: 1e12, timeout: TIMEOUT,
    }, this.tableTour(), this);
    table.mttLevel = 0;
    this.tables.add(table);
    return table;
  }

  closeTable(table) {
    this.tables.delete(table);
    this.hooks.dropTable(table);
  }

  // ——— переходник для стола: то же лицо, что у sit-n-go ———

  tableTour() {
    const mtt = this;
    return {
      kind: 'mtt',
      get status() { return mtt.status === 'running' ? 'running' : 'finished'; },
      get buyIn() { return mtt.buyIn; },
      get stack() { return STACK; },
      get prizes() { return mtt.prizes; },
      get places() { return mtt.places; },
      get level() { return mtt.level; },
      get seats() { return mtt.entrants; },
      get humans() { return mtt.entrants; },
      blinds: () => mtt.blinds(),
      start() {},
      beforeHand: (table, now) => mtt.beforeHand(table, now),
      bust: (table, busted) => mtt.bust(table, busted),
      publicState: (now) => mtt.publicState(now),
    };
  }

  // Уровень общий для всех столов и считается по часам от старта.
  beforeHand(table, now = Date.now()) {
    this.level = Math.min(LEVELS.length - 1, Math.floor((now - this.startedAt) / LEVEL_MS));
    if (table.mttLevel === this.level) return;
    table.mttLevel = this.level;
    [table.sb, table.bb] = this.blinds();
    table.note(`Блайнды растут: ${table.sb}/${table.bb}`, 'result');
  }

  // Вылетевшие за раздачу на одном столе: места по стеку на начало раздачи.
  bust(table, busted) {
    if (this.status !== 'running') return;
    // Места раздаются снизу: первым худшее место получает сдавшийся, затем тот,
    // кто пришёл в раздачу с меньшим стеком.
    const ordered = [...busted].sort((a, b) => (!!b.forfeit - !!a.forfeit) || a.handStartStack - b.handStartStack);
    let place = this.alive;
    for (const p of ordered) {
      this.award(table, p, place);
      place -= 1;
      table.removePlayer(p);
    }
    this.alive -= busted.length;

    if (this.alive <= 1) { this.finish(); return; }
    this.balance(table);
  }

  award(table, p, place) {
    const prize = this.prizes[place - 1] || 0;
    this.places.push({ place, userId: p.isBot ? null : p.userId, name: p.name, prize, isBot: p.isBot });
    this.places.sort((a, b) => a.place - b.place);
    if (!p.isBot) {
      if (prize) this.hooks.pay({ userId: p.userId, name: p.name }, prize);
      this.hooks.record({ userId: p.userId, name: p.name }, { place, prize, entrants: this.entrants });
    }
    table.note(place === 1
      ? `${p.name} выигрывает турнир «${this.name}» и забирает ${prize}`
      : `${p.name} занимает ${place} место из ${this.entrants}${prize ? ` и получает ${prize}` : ''}`, 'result');
  }

  finish() {
    for (const t of this.tables) {
      for (const p of t.players()) {
        this.award(t, p, 1);
        t.removePlayer(p);
      }
    }
    this.alive = 0;
    this.status = 'finished';
    this.finishedAt = Date.now();
    // Столы ещё минуту показывают итог, потом закрываются (см. tick).
  }

  // ——— пересадка ———
  //
  // Нужно столов: ceil(живых / 9). Лишний стол — самый маленький — расформировываем,
  // как только на нём кончилась раздача. Иначе выравниваем: если за этим столом
  // на двоих больше, чем за самым пустым, один игрок пересаживается туда.

  balance(table) {
    if (this.status !== 'running' || !this.tables.has(table)) return;
    if (table.phase !== 'idle' && table.phase !== 'showdown') return;
    const list = [...this.tables];
    const need = Math.ceil(this.alive / TABLE_SEATS);
    const count = (t) => t.occupied();
    const smallest = list.reduce((a, b) => (count(b) < count(a) ? b : a));

    if (list.length > need && (table === smallest || count(table) === count(smallest))) {
      const others = list.filter((t) => t !== table);
      for (const p of table.players()) {
        const target = others
          .filter((t) => count(t) < TABLE_SEATS)
          .reduce((a, b) => (!a || count(b) < count(a) ? b : a), null);
        if (!target) break;
        this.move(p, table, target);
      }
      if (!table.occupied()) {
        table.note('Стол расформирован — игроки пересажены за другие столы', 'result');
        this.closeTable(table);
      }
      return;
    }

    const others = list.filter((t) => t !== table);
    if (!others.length) return;
    const lightest = others.reduce((a, b) => (count(b) < count(a) ? b : a));
    if (count(table) > count(lightest) + 1) {
      // Пересаживаем того, кто только что был на большом блайнде: ему не придётся платить его снова.
      const p = table.seats[table.bbSeat] || table.players()[0];
      if (p) this.move(p, table, lightest);
    }
  }

  move(p, from, to) {
    const { userId, name, isBot, stack, sittingOut } = p;
    from.removePlayer(p);
    const seat = to.seats.findIndex((s) => s === null);
    to.sit({ id: userId, name, isBot }, seat, stack);
    const moved = to.byUser(userId);
    if (moved) moved.sittingOut = sittingOut;
    to.note(`${name} пересаживается сюда со стола «${from.name}»`, 'seat');
  }

  // Раз в пару секунд: столы, где раздача не может начаться (один игрок),
  // тоже нужно расформировать; законченный турнир — убрать.
  tick(now = Date.now()) {
    if (this.status === 'running') {
      for (const t of [...this.tables]) {
        if (t.phase === 'idle' && !t.nextStepAt && t.eligible().length < 2) this.balance(t);
      }
    }
    if ((this.status === 'finished' || this.status === 'cancelled') && this.tables.size && now - this.finishedAt > 60_000) {
      for (const t of [...this.tables]) this.closeTable(t);
    }
  }

  publicState(now = Date.now()) {
    const last = this.level >= LEVELS.length - 1;
    const [sb, bb] = this.blinds(this.level + 1);
    const nextLevelAt = this.startedAt + (this.level + 1) * LEVEL_MS;
    return {
      kind: 'mtt',
      name: this.name,
      status: this.status === 'running' ? 'running' : 'finished',
      buyIn: this.buyIn,
      stack: STACK,
      pool: this.pool,
      prizes: this.prizes,
      level: this.level + 1,
      levelMs: LEVEL_MS,
      levelLeft: this.status === 'running' && !last ? Math.max(0, nextLevelAt - now) : 0,
      next: last ? null : { sb, bb },
      places: this.places.filter((p) => p.prize > 0 || p.place <= 3),
      entrants: this.entrants,
      alive: this.alive,
      tables: this.tables.size,
    };
  }

  // Для лобби и списка турниров.
  info(viewerId = null) {
    const biggest = [...this.tables].reduce((a, b) => (!a || b.occupied() > a.occupied() ? b : a), null);
    return {
      id: this.id,
      name: this.name,
      startAt: this.startAt,
      buyIn: this.buyIn,
      guarantee: this.guarantee,
      pool: this.pool,
      status: this.status,
      registered: this.status === 'registering' ? this.entries.size : this.entrants,
      alive: this.alive,
      tables: this.tables.size,
      watch: biggest ? biggest.id : null,
      prizes: this.status === 'registering' ? payouts(Math.max(this.entries.size, MIN_PLAYERS), this.pool).slice(0, 3) : this.prizes.slice(0, 3),
      winner: this.status === 'finished' && this.places[0] ? this.places[0].name : null,
      me: viewerId ? this.entries.has(viewerId) : false,
      myPlace: viewerId ? (this.places.find((p) => p.userId === viewerId) || null) : null,
      minPlayers: MIN_PLAYERS,
      botFill: BOT_FILL,
      cancelReason: this.cancelReason || null,
    };
  }

  snapshot() {
    return {
      id: this.id, name: this.name, startAt: this.startAt, buyIn: this.buyIn, guarantee: this.guarantee,
      scheduled: this.scheduled, status: this.status, entries: [...this.entries.values()],
    };
  }
}

// Все турниры: расписание, старт, обслуживание, восстановление после перезапуска.
class MttManager {
  constructor(hooks) {
    this.hooks = hooks;
    this.list = new Map();
  }

  // Ближайший турнир каждого пункта расписания создаётся заранее, чтобы на него можно было записаться.
  plan(now = Date.now()) {
    for (const item of SCHEDULE) {
      const at = nextAt(item.time, now);
      if (at - now > REG_OPENS_MS) continue;
      const id = `${item.key}-${dayKey(at)}`;
      if (this.list.has(id)) continue;
      this.list.set(id, new Mtt({ id, name: item.name, startAt: at, buyIn: item.buyIn, guarantee: item.guarantee, scheduled: item.key }, this.hooks));
    }
  }

  create({ name, startAt, buyIn, guarantee }) {
    const id = `once-${Date.now().toString(36)}`;
    const mtt = new Mtt({ id, name, startAt, buyIn, guarantee }, this.hooks);
    this.list.set(id, mtt);
    return mtt;
  }

  get(id) { return this.list.get(id) || null; }

  tick(now = Date.now()) {
    this.plan(now);
    for (const mtt of this.list.values()) {
      if (mtt.status === 'registering') {
        if (!mtt.reminded && mtt.startAt - now <= REMIND_MS) {
          mtt.reminded = true;
          for (const e of mtt.entries.values()) {
            if (!e.isBot) this.hooks.notify(e.userId, `Турнир «${mtt.name}» начнётся через 5 минут — вы в списке участников.`);
          }
        }
        if (now >= mtt.startAt) {
          // Людей нет — играть некому. Людей мало — недостающих добирают боты.
          const humans = [...mtt.entries.values()].filter((e) => !e.isBot).length;
          if (!humans) mtt.cancel('никто не записался');
          else {
            if (mtt.entries.size < MIN_PLAYERS) mtt.addBots(BOT_FILL - mtt.entries.size);
            mtt.start(now);
          }
        }
      }
      mtt.tick(now);
      if ((mtt.status === 'finished' || mtt.status === 'cancelled') && now - mtt.finishedAt > KEEP_DONE_MS) {
        this.list.delete(mtt.id);
      }
    }
  }

  // Для лобби: идущие, ближайшие и только что закончившиеся.
  overview(viewerId) {
    return [...this.list.values()]
      .sort((a, b) => a.startAt - b.startAt)
      .map((m) => m.info(viewerId));
  }

  snapshot() {
    return [...this.list.values()].filter((m) => m.status === 'registering' || m.status === 'running').map((m) => m.snapshot());
  }

  // После перезапуска: регистрации возвращаются как были. Шедший турнир
  // доиграть нельзя — его фонд делится по стекам (это делает снимок столов).
  restore(saved = []) {
    for (const s of saved) {
      if (s.status !== 'registering') continue;
      const mtt = new Mtt(s, this.hooks);
      for (const e of s.entries) mtt.entries.set(e.userId, e);
      this.list.set(mtt.id, mtt);
    }
  }
}

module.exports = { Mtt, MttManager, SCHEDULE, payouts, nextAt, STACK, LEVEL_MS, MIN_PLAYERS };
