'use strict';
// Sit-n-go: турнир на один стол. Регистрация — это посадка за стол со
// взносом из банка; когда места заполнены, турнир стартует сам. Играют
// турнирными фишками на вылет, блайнды растут по часам, призы уходят в банк.

const SNG_BUY_INS = [100, 500, 1000, 2500, 5000, 10000]; // из чего создатель выбирает взнос
const SNG_BUY_IN = 1000;      // взнос по умолчанию
const SNG_STACK = 1000;       // стартовый стек турнирными фишками — не зависит от взноса
const SNG_LEVEL_MS = 120_000; // блайнды растут каждые две минуты
const SNG_TIMEOUT = 20;       // секунд на ход
const SNG_AWAY_MS = 1500;     // сколько стол ждёт отошедшего игрока: блайнды он платит, карты сбрасывает

// Спин: турбо на троих, победитель забирает всё. Приз — взнос, умноженный на
// множитель, который выпадает при старте. Средний множитель ≈3,05, то есть
// в среднем приз равен трём взносам — «честный» турнир, редкий ×100 — праздник.
const SPIN_STACK = 500;
const SPIN_LEVEL_MS = 60_000;
const SPIN_TIMEOUT = 15;
const SPIN_MULTIPLIERS = [[2, 75], [3, 15], [5, 7], [10, 2.5], [100, 0.5]];   // [множитель, шанс в %]

function drawMultiplier(rand = Math.random) {
  let r = rand() * 100;
  for (const [mult, chance] of SPIN_MULTIPLIERS) {
    if (r < chance) return mult;
    r -= chance;
  }
  return SPIN_MULTIPLIERS[0][0];
}

const SNG_LEVELS = [
  [10, 20], [15, 30], [25, 50], [50, 100], [75, 150], [100, 200], [150, 300],
  [200, 400], [300, 600], [400, 800], [600, 1200], [800, 1600], [1000, 2000],
  [1500, 3000], [2000, 4000], [3000, 6000], [5000, 10000],
];

// Доли призового фонда. Второе и третье место получают больше взноса:
// на шесть мест второй забирает 35% фонда — 2,1 взноса.
const SNG_PAYOUTS = {
  6: [0.65, 0.35],
  9: [0.5, 0.3, 0.2],
};

function prizeTable(seats, buyIn = SNG_BUY_IN) {
  const pool = seats * buyIn;
  const shares = SNG_PAYOUTS[seats];
  // Призы младших мест округляем вниз, остаток — победителю: фишки не теряются.
  const prizes = shares.map((share) => Math.floor(pool * share));
  prizes[0] += pool - prizes.reduce((a, b) => a + b, 0);
  return prizes;
}

class Tournament {
  // hooks.pay(player, amount, place) — приз в банк игрока,
  // hooks.onStart(players) и hooks.onPlace(player, place, prize) — для статистики игроков.
  constructor(seats, hooks = {}, buyIn = SNG_BUY_IN, { spin = false } = {}) {
    this.seats = seats;
    this.buyIn = buyIn;
    this.spin = spin;
    this.multiplier = 0;         // спин: выпадает при старте
    this.stack = spin ? SPIN_STACK : SNG_STACK;
    this.levelMs = spin ? SPIN_LEVEL_MS : SNG_LEVEL_MS;
    this.prizes = spin ? [] : prizeTable(seats, this.buyIn);
    this.status = 'registering'; // registering → running → finished
    this.level = 0;
    this.startedAt = 0;
    this.levelAt = 0;            // когда начался текущий уровень
    this.finishedAt = 0;
    this.places = [];            // { place, name, prize } — по мере вылета
    this.fillAt = 0;             // sit-n-go заведения: когда свободные места займут боты
    this.pay = hooks.pay || (() => {});
    this.onStart = hooks.onStart || (() => {});
    this.onPlace = hooks.onPlace || (() => {});
  }

  get pool() { return this.spin ? this.buyIn * this.multiplier : this.seats * this.buyIn; }

  blinds(level = this.level) {
    return SNG_LEVELS[Math.min(level, SNG_LEVELS.length - 1)];
  }

  start(table) {
    this.status = 'running';
    this.humans = table.players().filter((p) => !p.isBot).length;   // от этого зависят очки сезона
    this.startedAt = Date.now();
    this.levelAt = this.startedAt;
    this.level = 0;
    [table.sb, table.bb] = this.blinds();
    table.minRaise = table.bb;
    if (this.spin) {
      this.multiplier = drawMultiplier();
      this.prizes = [this.pool];
      table.note(`Спин начался: множитель ×${this.multiplier} — победитель забирает ${this.pool}`, 'result');
    } else {
      table.note(`Турнир начался: ${this.seats} игроков, призовой фонд ${this.pool}`, 'result');
    }
    this.onStart(table.players());
  }

  // Уровень меняется между раздачами: посреди торговли блайнды не трогаем.
  beforeHand(table, now = Date.now()) {
    if (this.status !== 'running') return;
    const level = Math.floor((now - this.startedAt) / this.levelMs);
    if (level <= this.level || this.level >= SNG_LEVELS.length - 1) return;
    this.level = Math.min(level, SNG_LEVELS.length - 1);
    this.levelAt = this.startedAt + this.level * this.levelMs;
    [table.sb, table.bb] = this.blinds();
    table.note(`Блайнды растут: ${table.sb}/${table.bb}`, 'result');
  }

  // Вылетевшие за одну раздачу делят места по стеку на её начало:
  // кто пришёл в раздачу с большим стеком, тот и выше.
  bust(table, busted) {
    if (this.status !== 'running' || !busted.length) return;
    const left = table.players().length - busted.length;
    const ordered = [...busted].sort((a, b) => b.handStartStack - a.handStartStack);
    ordered.forEach((p, i) => this.award(table, p, left + 1 + i));
    for (const p of busted) table.removePlayer(p);

    if (left <= 1) {
      const winner = table.players()[0];
      if (winner) {
        this.award(table, winner, 1);
        table.removePlayer(winner);
      }
      this.status = 'finished';
      this.finishedAt = Date.now();
    }
  }

  award(table, p, place) {
    const prize = this.prizes[place - 1] || 0;
    this.places.push({ place, name: p.name, prize, isBot: p.isBot });
    this.places.sort((a, b) => a.place - b.place);
    if (prize) this.pay(p, prize, place);
    this.onPlace(p, place, prize);
    table.note(place === 1
      ? `${p.name} выигрывает турнир и забирает ${prize}`
      : `${p.name} занимает ${place} место${prize ? ` и получает ${prize}` : ''}`, 'result');
  }

  // Время до следующего уровня считается в момент сборки кадра.
  publicState(now = Date.now()) {
    const last = this.level >= SNG_LEVELS.length - 1;
    const [sb, bb] = this.blinds(this.level + 1);
    return {
      status: this.status,
      buyIn: this.buyIn,
      stack: this.stack,
      pool: this.pool,
      prizes: this.prizes,
      level: this.level + 1,
      levelMs: this.levelMs,
      levelLeft: this.status === 'running' && !last
        ? Math.max(0, this.startedAt + (this.level + 1) * this.levelMs - now) : 0,
      spin: this.spin,
      multiplier: this.multiplier,
      next: last ? null : { sb, bb },
      places: this.places,
      fillLeft: this.status === 'registering' && this.fillAt ? Math.max(0, this.fillAt - now) : 0,
    };
  }
}

module.exports = {
  Tournament, prizeTable, drawMultiplier, SNG_BUY_IN, SNG_BUY_INS, SNG_STACK, SNG_TIMEOUT, SNG_AWAY_MS, SNG_LEVELS,
  SPIN_STACK, SPIN_TIMEOUT, SPIN_MULTIPLIERS,
};
