'use strict';
// Сит-н-гоу: турнир на один стол. Регистрация — это посадка за стол со
// взносом из банка; когда места заполнены, турнир стартует сам. Играют
// турнирными фишками на вылет, блайнды растут по часам, призы уходят в банк.

const SNG_BUY_INS = [100, 500, 1000, 2500, 5000, 10000]; // из чего создатель выбирает взнос
const SNG_BUY_IN = 1000;      // взнос по умолчанию
const SNG_STACK = 1000;       // стартовый стек турнирными фишками — не зависит от взноса
const SNG_LEVEL_MS = 120_000; // блайнды растут каждые две минуты
const SNG_TIMEOUT = 20;       // секунд на ход
const SNG_AWAY_MS = 1500;     // сколько стол ждёт отошедшего игрока: блайнды он платит, карты сбрасывает

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
  constructor(seats, hooks = {}, buyIn = SNG_BUY_IN) {
    this.seats = seats;
    this.buyIn = buyIn;
    this.stack = SNG_STACK;
    this.prizes = prizeTable(seats, this.buyIn);
    this.status = 'registering'; // registering → running → finished
    this.level = 0;
    this.startedAt = 0;
    this.levelAt = 0;            // когда начался текущий уровень
    this.finishedAt = 0;
    this.places = [];            // { place, name, prize } — по мере вылета
    this.pay = hooks.pay || (() => {});
    this.onStart = hooks.onStart || (() => {});
    this.onPlace = hooks.onPlace || (() => {});
  }

  get pool() { return this.seats * this.buyIn; }

  blinds(level = this.level) {
    return SNG_LEVELS[Math.min(level, SNG_LEVELS.length - 1)];
  }

  start(table) {
    this.status = 'running';
    this.startedAt = Date.now();
    this.levelAt = this.startedAt;
    this.level = 0;
    [table.sb, table.bb] = this.blinds();
    table.minRaise = table.bb;
    table.note(`Турнир начался: ${this.seats} игроков, призовой фонд ${this.pool}`, 'result');
    this.onStart(table.players());
  }

  // Уровень меняется между раздачами: посреди торговли блайнды не трогаем.
  beforeHand(table, now = Date.now()) {
    if (this.status !== 'running') return;
    const level = Math.floor((now - this.startedAt) / SNG_LEVEL_MS);
    if (level <= this.level || this.level >= SNG_LEVELS.length - 1) return;
    this.level = Math.min(level, SNG_LEVELS.length - 1);
    this.levelAt = this.startedAt + this.level * SNG_LEVEL_MS;
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
      levelMs: SNG_LEVEL_MS,
      levelLeft: this.status === 'running' && !last
        ? Math.max(0, this.startedAt + (this.level + 1) * SNG_LEVEL_MS - now) : 0,
      next: last ? null : { sb, bb },
      places: this.places,
    };
  }
}

module.exports = { Tournament, prizeTable, SNG_BUY_IN, SNG_BUY_INS, SNG_STACK, SNG_TIMEOUT, SNG_AWAY_MS, SNG_LEVELS };
