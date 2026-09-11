'use strict';
const { freshDeck, shuffle, evaluate, handInfo } = require('./cards');
const { decideBotAction, botThinkingTime } = require('./bot');

const PHASES = ['preflop', 'flop', 'turn', 'river'];

// Что показывать в ленте стола: разговоры и итоги раздач.
const FEED_KINDS = new Set(['chat', 'result']);

const REVEAL_STEP = 600;   // пауза перед обязательным вскрытием
const REVEAL_ASK = 5000;   // сколько человек думает, показывать ли проигравшую руку
const REVEAL_BOT = 500;    // бот решает быстро

let handCounter = 0;

// Сколько тяжёлых расчётов силы руки разрешено за один тик сервера.
const evalBudget = { left: Infinity };
function setEvalBudget(n) { evalBudget.left = n; }

class Player {
  constructor({ userId, name, isBot, stack, seat }) {
    this.userId = userId;
    this.name = name;
    this.isBot = !!isBot;
    this.seat = seat;
    this.stack = stack;
    this.cards = [];
    this.bet = 0;          // ставка в текущем круге торговли
    this.contributed = 0;  // всего вложено в раздаче (для сайд-потов)
    this.inHand = false;
    this.folded = false;
    this.allIn = false;
    this.hasActed = false;
    this.noRaise = false;  // после неполного олл-ина повышать нельзя
    this.sittingOut = false;
    this.lastAction = null;
    this.leaving = false;
    this.disconnectedAt = null;
    this.showCards = false;
    this.handName = null;
    this.won = 0;
    this.wonContested = false; // выиграл банк, за который боролись — его комбинацию подсвечиваем
    this.mucked = false;       // отказался показывать карты на вскрытии
  }
}

class Table {
  constructor(config, hooks = {}) {
    Object.assign(this, config); // id, name, maxSeats, sb, bb, minBuyIn, maxBuyIn, timeout
    this.seats = new Array(this.maxSeats).fill(null);
    this.phase = 'idle';
    this.board = [];
    this.deck = [];
    this.pot = 0;
    this.pots = [];
    this.currentBet = 0;
    this.minRaise = this.bb;
    this.actingSeat = -1;
    this.buttonSeat = -1;
    this.deadline = 0;      // дедлайн хода текущего игрока
    this.nextStepAt = 0;    // отложенный переход (старт раздачи, конец вскрытия)
    this.handId = 0;
    this.log = [];
    this.logSeq = 0;
    this.logFrames = new Map(); // готовые события ленты по отметке клиента
    this.lastWinners = [];
    this.handCache = new Map(); // сила руки считается перебором — держим её до конца улицы
    this.evalCache = {};        // значения рук соперника для текущего борда
    this.lastHand = new Map();  // последний посчитанный разбор руки по местам
    this.byUserId = new Map();  // userId -> игрок, чтобы не перебирать места
    this.potParts = [];         // разбиение банка на основной и побочные — для показа фишками
    this.reveal = null;         // очередь вскрытия: кто сейчас решает, показывать ли карты
    this.results = new Map();
    this.pendingWinners = [];
    this.lastAggressorSeat = -1;
    this.onChipsReturn = hooks.onChipsReturn || (() => {});
    this.onHandStart = hooks.onHandStart || (() => {});
    this.onSeat = hooks.onSeat || (() => {});
    this.onUnseat = hooks.onUnseat || (() => {});
    this.version = 0;
    this.frameVersion = -1;   // на какой версии собран кэш JSON
    this.framePrefix = '';    // общая часть состояния без «you»
    this.frameNoYou = '';     // готовый кадр для зрителя
    this.privJson = new Map();// приватная часть по местам
    this.emptyAt = 0;         // когда стол опустел — по этому его убирают
  }

  // ——— вспомогательное ———

  players() { return this.seats.filter(Boolean); }
  inHand() { return this.players().filter((p) => p.inHand && !p.folded); }
  canAct() { return this.inHand().filter((p) => !p.allIn); }
  bySeat(seat) { return this.seats[seat] || null; }
  byUser(userId) { return this.byUserId.get(userId) || null; }
  occupied() { return this.players().length; }
  humans() { return this.players().filter((p) => !p.isBot).length; }

  // У каждой записи свой номер: клиент дописывает ленту, а не строит её заново.
  note(text, kind = 'game') {
    this.log.push({ id: ++this.logSeq, t: Date.now(), text, kind });
    if (this.log.length > 200) this.log.shift();
    this.logFrames.clear();
    this.version++;
  }

  chat(name, text) {
    this.note(`${name}: ${text}`, 'chat');
    this.touch();
  }

  touch() { this.version++; }

  nextOccupied(from, filter) {
    for (let i = 1; i <= this.maxSeats; i++) {
      const seat = (from + i) % this.maxSeats;
      const p = this.seats[seat];
      if (p && filter(p)) return seat;
    }
    return -1;
  }

  // ——— посадка и выход ———

  sit(user, seat, buyIn) {
    if (seat < 0 || seat >= this.maxSeats) return { error: 'Такого места нет' };
    if (this.seats[seat]) return { error: 'Место занято' };
    if (this.byUser(user.id)) return { error: 'Вы уже за этим столом' };
    if (buyIn < this.minBuyIn || buyIn > this.maxBuyIn) {
      return { error: `Закупка от ${this.minBuyIn} до ${this.maxBuyIn} фишек` };
    }
    const p = new Player({ userId: user.id, name: user.name, isBot: !!user.isBot, stack: buyIn, seat });
    this.seats[seat] = p;
    this.byUserId.set(p.userId, p);
    this.emptyAt = 0;
    this.onSeat(p, this);
    this.note(`${p.name} садится на место ${seat + 1} с ${buyIn} фишками`, 'seat');
    this.touch();
    this.maybeStartHand();
    return { ok: true };
  }

  addChips(userId, amount) {
    const p = this.byUser(userId);
    if (!p) return { error: 'Вас нет за столом' };
    if (p.inHand && this.phase !== 'idle') return { error: 'Докупить можно между раздачами' };
    if (p.stack + amount > this.maxBuyIn) return { error: `Максимум за столом — ${this.maxBuyIn} фишек` };
    p.stack += amount;
    if (p.sittingOut && !p.leaving) p.sittingOut = false;
    this.note(`${p.name} докупает ${amount}`, 'seat');
    this.touch();
    this.maybeStartHand();
    return { ok: true };
  }

  // Встать из-за стола. Во время своей раздачи — фолд и уход по её завершении.
  leave(userId) {
    const p = this.byUser(userId);
    if (!p) return { error: 'Вас нет за столом' };
    if (p.inHand && !p.folded && this.phase === 'showdown') {
      p.leaving = true;
      this.note(`${p.name} выходит из-за стола`, 'seat');
      this.touch();
      return { ok: true, pending: true };
    }
    if (p.inHand && !p.folded && this.phase !== 'idle') {
      p.leaving = true;
      if (this.actingSeat === p.seat) this.applyAction(p, 'fold');
      else { p.folded = true; p.lastAction = 'fold'; this.afterFoldCheck(); }
      this.note(`${p.name} выходит из-за стола`, 'seat');
      this.touch();
      return { ok: true, pending: true };
    }
    return this.removePlayer(p);
  }

  removePlayer(p) {
    const chips = p.stack;
    this.seats[p.seat] = null;
    this.byUserId.delete(p.userId);
    this.onUnseat(p, this);
    if (!this.occupied()) this.emptyAt = Date.now();
    this.onChipsReturn(p, chips);
    this.note(`${p.name} покидает стол`, 'seat');
    this.touch();
    if (this.phase === 'idle') this.maybeStartHand();
    return { ok: true, chips };
  }

  setSittingOut(userId, value) {
    const p = this.byUser(userId);
    if (!p) return { error: 'Вас нет за столом' };
    p.sittingOut = value;
    this.touch();
    if (!value) this.maybeStartHand();
    return { ok: true };
  }

  // ——— начало раздачи ———

  eligible() {
    return this.players().filter((p) => p.stack > 0 && !p.sittingOut && !p.leaving);
  }

  maybeStartHand() {
    if (this.phase !== 'idle' || this.nextStepAt) return;
    if (this.eligible().length >= 2) this.nextStepAt = Date.now() + 2000;
  }

  startHand() {
    const ready = this.eligible();
    if (ready.length < 2) { this.phase = 'idle'; this.touch(); return; }

    this.handId = ++handCounter;
    this.handCache.clear();
    this.evalCache = {};
    this.lastHand.clear();
    this.potParts = [];
    this.reveal = null;
    this.results = new Map();
    this.pendingWinners = [];
    this.lastAggressorSeat = -1;
    this.deck = shuffle(freshDeck());
    this.board = [];
    this.pot = 0;
    this.pots = [];
    this.lastWinners = [];
    this.currentBet = 0;
    this.minRaise = this.bb;

    for (const p of this.players()) {
      p.cards = [];
      p.bet = 0;
      p.contributed = 0;
      p.folded = false;
      p.allIn = false;
      p.hasActed = false;
      p.noRaise = false;
      p.lastAction = null;
      p.showCards = false;
      p.handName = null;
      p.won = 0;
      p.wonContested = false;
      p.mucked = false;
      p.inHand = ready.includes(p);
    }

    // Кнопка дилера сдвигается к следующему участнику раздачи.
    const isReady = (p) => p.inHand;
    this.buttonSeat = this.buttonSeat < 0
      ? ready[Math.floor(Math.random() * ready.length)].seat
      : this.nextOccupied(this.buttonSeat, isReady);

    const heads = ready.length === 2;
    const sbSeat = heads ? this.buttonSeat : this.nextOccupied(this.buttonSeat, isReady);
    const bbSeat = this.nextOccupied(sbSeat, isReady);

    this.postBlind(this.seats[sbSeat], this.sb, 'small blind');
    this.postBlind(this.seats[bbSeat], this.bb, 'big blind');
    this.currentBet = Math.max(this.sb, this.bb);
    this.minRaise = this.bb;

    // Раздача по две карты, начиная с малого блайнда.
    for (let round = 0; round < 2; round++) {
      let seat = sbSeat;
      for (let i = 0; i < ready.length; i++) {
        this.seats[seat].cards.push(this.deck.pop());
        seat = this.nextOccupied(seat, isReady);
      }
    }

    this.phase = 'preflop';
    this.bbSeat = bbSeat;
    const first = heads ? this.buttonSeat : this.nextOccupied(bbSeat, (p) => p.inHand && !p.allIn);
    this.setActor(first);
    this.note(`— Раздача #${this.handId} —`, 'hand');
    this.onHandStart(ready);
    this.touch();
  }

  postBlind(p, amount, label) {
    const pay = Math.min(amount, p.stack);
    p.stack -= pay;
    p.bet += pay;
    p.contributed += pay;
    if (p.stack === 0) p.allIn = true;
    p.lastAction = label;
  }

  setActor(seat) {
    this.actingSeat = seat;
    if (seat >= 0) {
      const p = this.seats[seat];
      this.deadline = Date.now() + (p.isBot ? botThinkingTime() : this.timeout * 1000);
    } else {
      this.deadline = 0;
    }
    this.touch();
  }

  // ——— ходы ———

  legalActions(p) {
    if (!p || this.actingSeat !== p.seat) return null;
    const toCall = Math.min(this.currentBet - p.bet, p.stack);
    const acts = { fold: true, toCall, stack: p.stack, pot: this.potTotal() };
    if (toCall === 0) acts.check = true;
    else acts.call = toCall;
    const maxTo = p.bet + p.stack;
    if (!p.noRaise && maxTo > this.currentBet) {
      acts.minRaiseTo = Math.min(this.currentBet + this.minRaise, maxTo);
      acts.maxRaiseTo = maxTo;
      acts.isBet = this.currentBet === 0;
    }
    return acts;
  }

  act(userId, action, amount) {
    const p = this.byUser(userId);
    if (!p) return { error: 'Вас нет за столом' };
    if (this.actingSeat !== p.seat) return { error: 'Сейчас не ваш ход' };
    const legal = this.legalActions(p);
    if (action === 'check' && !legal.check) return { error: 'Нельзя чекнуть, есть ставка' };
    if (action === 'call' && legal.toCall === 0) action = 'check';
    if ((action === 'raise' || action === 'bet')) {
      if (legal.minRaiseTo === undefined) return { error: 'Повышать нельзя' };
      const to = Math.round(Number(amount) || 0);
      if (to > legal.maxRaiseTo) return { error: 'Не хватает фишек' };
      if (to < legal.minRaiseTo && to !== legal.maxRaiseTo) {
        return { error: `Минимум ${legal.minRaiseTo}` };
      }
      this.applyAction(p, 'raise', to);
      return { ok: true };
    }
    this.applyAction(p, action);
    return { ok: true };
  }

  applyAction(p, action, raiseTo) {
    p.hasActed = true;
    if (action === 'fold') {
      p.folded = true;
      p.lastAction = 'fold';
      this.note(`${p.name}: фолд`, 'action');
    } else if (action === 'check') {
      p.lastAction = 'check';
      this.note(`${p.name}: чек`, 'action');
    } else if (action === 'call') {
      const pay = Math.min(this.currentBet - p.bet, p.stack);
      this.moveChips(p, pay);
      p.lastAction = 'call';
      this.note(`${p.name}: колл ${pay}${p.allIn ? ' (олл-ин)' : ''}`, 'action');
    } else if (action === 'raise') {
      const pay = raiseTo - p.bet;
      const wasBet = this.currentBet;
      this.moveChips(p, pay);
      const raiseSize = p.bet - wasBet;
      const full = raiseSize >= this.minRaise;
      if (full) this.minRaise = raiseSize;
      this.currentBet = Math.max(this.currentBet, p.bet);
      // Все остальные должны ответить; после неполного олл-ина — без права повышать.
      for (const o of this.inHand()) {
        if (o !== p && !o.allIn) {
          if (o.hasActed && !full) o.noRaise = true;
          o.hasActed = false;
        }
      }
      p.lastAction = wasBet === 0 ? 'bet' : 'raise';
      this.lastAggressorSeat = p.seat;
      this.note(`${p.name}: ${wasBet === 0 ? 'бет' : 'рейз до'} ${p.bet}${p.allIn ? ' (олл-ин)' : ''}`, 'action');
    }
    this.touch();
    this.advance();
  }

  moveChips(p, amount) {
    const pay = Math.max(0, Math.min(amount, p.stack));
    p.stack -= pay;
    p.bet += pay;
    p.contributed += pay;
    if (p.stack === 0) p.allIn = true;
  }

  afterFoldCheck() {
    if (this.inHand().length === 1) this.endHand();
  }

  // Переход хода / улицы после действия.
  advance() {
    const alive = this.inHand();
    if (alive.length <= 1) { this.endHand(); return; }

    const next = this.nextOccupied(this.actingSeat, (p) => p.inHand && !p.folded && !p.allIn && !p.hasActed);
    if (next >= 0) { this.setActor(next); return; }

    // Круг торговли закончен.
    this.collectBets();
    if (this.canAct().length <= 1) { this.runOut(); return; }

    const idx = PHASES.indexOf(this.phase);
    if (idx >= PHASES.length - 1) { this.showdown(); return; }
    this.dealStreet(PHASES[idx + 1]);

    const first = this.nextOccupied(this.buttonSeat, (p) => p.inHand && !p.folded && !p.allIn);
    if (first < 0) { this.runOut(); return; }
    this.setActor(first);
  }

  // Как банк лежит на столе: основной и побочные. Считается по уже собранным вкладам.
  splitPot() {
    const parts = this.players()
      .map((p) => ({ p, amount: p.contributed - p.bet }))
      .filter((x) => x.amount > 0);
    if (!parts.length) return [];
    const levels = [...new Set(parts.map((x) => x.amount))].sort((a, b) => a - b);
    const out = [];
    let prev = 0;
    for (const level of levels) {
      let amount = 0;
      for (const x of parts) amount += Math.max(0, Math.min(x.amount, level) - Math.min(x.amount, prev));
      const seats = parts.filter((x) => !x.p.folded && x.p.inHand && x.amount >= level).map((x) => x.p.seat);
      if (amount > 0) out.push({ amount, seats });
      prev = level;
    }
    const merged = [];
    for (const part of out) {
      const last = merged[merged.length - 1];
      if (last && last.seats.length === part.seats.length && last.seats.every((s) => part.seats.includes(s))) {
        last.amount += part.amount;
      } else merged.push(part);
    }
    return merged;
  }

  collectBets() {
    for (const p of this.players()) {
      this.pot += p.bet;
      p.bet = 0;
      p.hasActed = false;
      p.noRaise = false;
      if (p.lastAction !== 'fold') p.lastAction = null;
    }
    this.currentBet = 0;
    this.minRaise = this.bb;
    this.potParts = this.splitPot();
  }

  dealStreet(phase) {
    this.phase = phase;
    this.lastAggressorSeat = -1;
    this.deck.pop(); // сжигаем карту
    const count = phase === 'flop' ? 3 : 1;
    for (let i = 0; i < count; i++) this.board.push(this.deck.pop());
    this.note(`${{ flop: 'Флоп', turn: 'Тёрн', river: 'Ривер' }[phase]}: ${this.board.join(' ')}`, 'street');
    this.touch();
  }

  // Все всё поставили — доводим борд до ривера и вскрываемся.
  runOut() {
    this.actingSeat = -1;
    this.deadline = 0;
    let idx = PHASES.indexOf(this.phase);
    while (idx < PHASES.length - 1) { this.dealStreet(PHASES[++idx]); }
    for (const p of this.inHand()) p.showCards = true;
    this.showdown();
  }

  // ——— завершение раздачи ———

  buildPots() {
    const contributors = this.players().filter((p) => p.contributed > 0);
    const levels = [...new Set(contributors.map((p) => p.contributed))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const level of levels) {
      let amount = 0;
      for (const p of contributors) {
        amount += Math.max(0, Math.min(p.contributed, level) - Math.min(p.contributed, prev));
      }
      const eligible = contributors.filter((p) => !p.folded && p.inHand && p.contributed >= level);
      if (amount > 0) pots.push({ amount, eligible });
      prev = level;
    }
    // Склеиваем соседние банки с одинаковым составом претендентов.
    const merged = [];
    for (const pot of pots) {
      const last = merged[merged.length - 1];
      if (last && last.eligible.length === pot.eligible.length
        && last.eligible.every((p) => pot.eligible.includes(p))) {
        last.amount += pot.amount;
      } else merged.push(pot);
    }
    return merged;
  }

  showdown() {
    if (this.phase === 'showdown') return;
    this.collectBets();
    this.phase = 'showdown';
    this.actingSeat = -1;
    this.deadline = 0;

    const alive = this.inHand();
    this.results = new Map();
    if (alive.length > 1) {
      for (const p of alive) this.results.set(p, evaluate([...p.cards, ...this.board]));
    }

    this.pots = this.buildPots();
    this.pendingWinners = this.computeWinners(this.pots, alive);
    // Карты, открытые раньше (олл-ин до ривера), сразу получают имя комбинации.
    for (const p of alive) if (p.showCards) this.applyResult(p);

    this.reveal = { order: this.revealOrder(alive), index: 0, seat: -1, optional: false, deadline: 0 };
    this.touch();
    this.stepReveal();
  }

  endHand() { this.showdown(); }

  // Кто выигрывает какой банк. Фишки не двигаем: сперва игроки вскрываются.
  computeWinners(pots, alive) {
    const winners = [];
    pots.forEach((pot, i) => {
      let claimants = pot.eligible;
      if (claimants.length === 0) claimants = alive;
      let best = claimants;
      if (claimants.length > 1) {
        const top = Math.max(...claimants.map((p) => this.results.get(p).value));
        best = claimants.filter((p) => this.results.get(p).value === top);
      }
      const share = Math.floor(pot.amount / best.length);
      let remainder = pot.amount - share * best.length;
      // Нечётные фишки уходят ближайшему слева от кнопки.
      const ordered = [...best].sort((a, b) =>
        ((a.seat - this.buttonSeat + this.maxSeats) % this.maxSeats)
        - ((b.seat - this.buttonSeat + this.maxSeats) % this.maxSeats));
      const share_ = [];
      for (const p of ordered) {
        let win = share;
        if (remainder > 0) { win += 1; remainder -= 1; }
        share_.push({ p, amount: win });
      }
      winners.push({
        potIndex: i,
        amount: pot.amount,
        contested: claimants.length > 1,
        share: share_,
        players: ordered,
      });
    });
    return winners;
  }

  // ——— вскрытие по очереди ———

  // Первым карты открывает последний агрессор, а если торговли не было — ближайший слева от кнопки.
  revealOrder(alive) {
    const inAlive = (seat) => alive.some((p) => p.seat === seat);
    const from = this.lastAggressorSeat >= 0 && inAlive(this.lastAggressorSeat)
      ? this.lastAggressorSeat
      : this.nextOccupied(this.buttonSeat, (p) => alive.includes(p));
    const order = [];
    for (let i = 0; i < this.maxSeats && order.length < alive.length; i++) {
      const seat = (from + i) % this.maxSeats;
      if (inAlive(seat)) order.push(seat);
    }
    return order;
  }

  // Показать карты обязан тот, кто забирает банк, и тот, кто вскрывается первым.
  mustShow(p, index, alive) {
    if (alive.length < 2) return false;
    if (this.pendingWinners.some((w) => w.players.includes(p))) return true;
    return index === 0;
  }

  applyResult(p) {
    const res = this.results.get(p);
    if (!res) return;
    p.handName = res.name;
    p.bestCards = res.cards;
  }

  showHand(p, quiet = false) {
    p.showCards = true;
    p.mucked = false;
    this.applyResult(p);
    if (!quiet) this.note(`${p.name} открывает карты: ${p.cards.join(' ')}`, 'reveal');
    this.touch();
  }

  muckHand(p) {
    p.mucked = true;
    p.showCards = false;
    this.note(`${p.name} не показывает карты`, 'reveal');
    this.touch();
  }

  // Двигаем очередь до ближайшего игрока, которому есть что решать.
  stepReveal(now = Date.now()) {
    const r = this.reveal;
    if (!r) return;
    const alive = this.inHand();

    while (r.index < r.order.length) {
      const p = this.seats[r.order[r.index]];
      if (p && p.inHand && !p.folded && !p.showCards && !p.mucked) break;
      r.index += 1;
    }
    if (r.index >= r.order.length) {
      this.reveal = null;
      this.awardPots();
      return;
    }

    const p = this.seats[r.order[r.index]];
    r.seat = p.seat;
    r.optional = !this.mustShow(p, r.index, alive);
    r.deadline = now + (!r.optional ? REVEAL_STEP : p.isBot ? REVEAL_BOT : REVEAL_ASK);
    this.touch();
  }

  // Решение игрока: показать карты или убрать их в сброс.
  playerReveal(userId, show) {
    const p = this.byUser(userId);
    if (!p) return { error: 'Вас нет за столом' };
    const r = this.reveal;
    if (!r || r.seat !== p.seat) return { error: 'Сейчас не ваша очередь' };
    if (show) this.showHand(p); else this.muckHand(p);
    r.index += 1;
    this.stepReveal();
    return { ok: true };
  }

  // Время вышло: обязательные руки открываются, остальные уходят в сброс.
  resolveReveal(now) {
    const r = this.reveal;
    const p = this.seats[r.seat];
    if (!p) { r.index += 1; this.stepReveal(now); return; }
    if (!r.optional) this.showHand(p, true);
    else if (p.isBot) {
      // Бот изредка показывает блеф — за столом так живее.
      if (Math.random() < 0.15) this.showHand(p); else this.muckHand(p);
    } else this.muckHand(p);
    r.index += 1;
    this.stepReveal(now);
  }

  // Все, кто хотел, вскрылись — раздаём банки.
  awardPots() {
    for (const w of this.pendingWinners) {
      for (const { p, amount } of w.share) {
        p.stack += amount;
        p.won += amount;
        // Банк с единственным претендентом — это возврат неотвеченной ставки, а не выигранная рука.
        if (w.contested) p.wonContested = true;
      }
    }

    this.lastWinners = this.pendingWinners.map((w) => ({
      potIndex: w.potIndex,
      amount: w.amount,
      names: w.players.map((p) => p.name),
      hand: w.contested && w.players[0].showCards ? w.players[0].handName : null,
      best: w.contested && w.players[0].showCards ? w.players[0].bestCards : null,
    }));
    // В ленте остаётся одна строка на раздачу — с комбинацией и картами, которые её собрали.
    for (const w of this.lastWinners) {
      const combo = w.hand ? ` — ${w.hand}${w.best ? ` · ${w.best.join(' ')}` : ''}` : '';
      this.note(`${w.names.join(', ')} выигрывает ${w.amount}${combo}`, 'result');
    }

    this.pendingWinners = [];
    this.pot = 0;
    this.potParts = [];
    this.nextStepAt = Date.now() + (this.inHand().length > 1 ? 5000 : 2500);
    this.touch();
  }


  finishHand() {
    // Страховка: если раздачу закрывают в обход очереди вскрытия, банки всё равно раздаются.
    if (this.pendingWinners.length) { this.reveal = null; this.awardPots(); }
    for (const p of this.players()) {
      p.inHand = false;
      p.cards = [];
      p.showCards = false;
      p.mucked = false;
      p.bestCards = null;
      p.lastAction = null;
      if (p.leaving) { this.removePlayer(p); continue; }
      if (p.stack === 0) { p.sittingOut = true; p.busted = true; }
    }
    this.board = [];
    this.pots = [];
    this.potParts = [];
    this.reveal = null;
    this.results = new Map();
    this.pendingWinners = [];
    this.lastWinners = [];
    this.phase = 'idle';
    this.touch();
    this.maybeStartHand();
  }

  potTotal() {
    return this.pot + this.players().reduce((sum, p) => sum + p.bet, 0);
  }

  // ——— часы стола ———

  tick(now = Date.now()) {
    if (this.nextStepAt && now >= this.nextStepAt) {
      this.nextStepAt = 0;
      if (this.phase === 'showdown') this.finishHand();
      else if (this.phase === 'idle') this.startHand();
      return;
    }
    if (this.reveal && this.reveal.deadline && now >= this.reveal.deadline) {
      this.resolveReveal(now);
      return;
    }
    if (this.actingSeat >= 0 && this.deadline && now >= this.deadline) {
      const p = this.seats[this.actingSeat];
      if (!p) { this.advance(); return; }
      if (p.isBot) {
        const { action, amount } = decideBotAction(this, p);
        this.applyAction(p, action, amount);
      } else {
        const legal = this.legalActions(p);
        this.note(`${p.name}: время вышло`, 'action');
        this.applyAction(p, legal.check ? 'check' : 'fold');
        if (!p.isBot) p.sittingOut = true; // отсутствующего игрока снимаем с раздач
      }
    }
  }

  // Какая комбинация собралась у игрока и насколько она сильна.
  //
  // Перебор рук соперника стоит миллисекунды, а когда сотни столов открывают
  // улицу в один тик, это складывается в заметную остановку цикла. Поэтому на
  // тик выделяется бюджет: столы, которые в него не попали, получают прошлый
  // расчёт и досчитываются следующим тиком.
  handInfoFor(p, withStrength = true) {
    if (!p || !p.inHand || p.folded || p.cards.length < 2) return null;
    const key = `${this.handId}:${p.seat}:${this.board.length}:${withStrength ? 1 : 0}`;
    const known = this.handCache.get(key);
    if (known !== undefined) return known;

    const needsBoard = this.board.length > 0 && this.evalCache.len !== this.board.length;
    if (needsBoard && evalBudget.left <= 0) return this.lastHand.get(p.seat) || null;
    if (needsBoard) evalBudget.left -= 1;

    const info = handInfo(p.cards, this.board, this.evalCache, withStrength);
    this.evalCache.len = this.board.length;
    this.handCache.set(key, info);
    this.lastHand.set(p.seat, info);
    return info;
  }

  // ——— состояние для клиента ———

  // Общее состояние стола: одинаковое для всех, свои карты игрок получает
  // отдельной приватной частью. Так JSON собирается один раз на версию,
  // а не на каждого зрителя.
  publicState() {
    const now = Date.now();
    return {
      id: this.id,
      levelId: this.levelId || this.id,
      name: this.name,
      maxSeats: this.maxSeats,
      sb: this.sb,
      bb: this.bb,
      minBuyIn: this.minBuyIn,
      maxBuyIn: this.maxBuyIn,
      phase: this.phase,
      handId: this.handId,
      board: this.board,
      pot: this.potTotal(),
      pots: this.potParts,
      currentBet: this.currentBet,
      buttonSeat: this.buttonSeat,
      actingSeat: this.actingSeat,
      timeLeft: this.deadline ? Math.max(0, this.deadline - now) : 0,
      timeout: this.timeout * 1000,
      winners: this.lastWinners,
      reveal: this.reveal && this.reveal.seat >= 0 ? {
        seat: this.reveal.seat,
        optional: this.reveal.optional,
        timeLeft: Math.max(0, this.reveal.deadline - now),
      } : null,
      seats: this.seats.map((p, i) => {
        if (!p) return { seat: i, empty: true };
        return {
          seat: i,
          name: p.name,
          isBot: p.isBot,
          stack: p.stack,
          bet: p.bet,
          inHand: p.inHand,
          folded: p.folded,
          allIn: p.allIn,
          sittingOut: p.sittingOut,
          lastAction: p.lastAction,
          handName: p.handName,
          won: p.won,
          mucked: p.mucked,
          revealing: !!(this.reveal && this.reveal.seat === i),
          winner: this.phase === 'showdown' && p.won > 0,
          champion: this.phase === 'showdown' && p.wonContested,
          cards: p.inHand ? (p.showCards ? p.cards : p.cards.map(() => '??')) : [],
          best: p.bestCards || null,
        };
      }),
    };
  }

  // Личная часть: свои карты, разбор руки и доступные ходы.
  privateState(p, withStrength = true) {
    return {
      seat: p.seat,
      stack: p.stack,
      inHand: p.inHand && this.phase !== 'idle',
      cards: p.cards,
      sittingOut: p.sittingOut,
      busted: !!p.busted,
      hand: this.handInfoFor(p, withStrength),
      canReveal: !!(this.reveal && this.reveal.optional && this.reveal.seat === p.seat),
      legal: this.actingSeat === p.seat ? this.legalActions(p) : null,
    };
  }

  // Кадры кэшируются по версии стола: пересобираем, только когда что-то изменилось.
  buildFrames() {
    if (this.frameVersion === this.version) return;
    const json = JSON.stringify(this.publicState());
    this.framePrefix = json.slice(0, -1);
    this.frameNoYou = `event: table\ndata: ${this.framePrefix},"you":null}\n\n`;
    this.privJson.clear();
    this.frameVersion = this.version;
  }

  // Готовая строка события для зрителя или для конкретного места.
  // Собирается один раз на версию: у стола зрителей может быть сколько угодно.
  frameFor(p, withStrength = true) {
    this.buildFrames();
    if (!p) return this.frameNoYou;
    const key = `${p.seat}:${withStrength ? 1 : 0}`;
    let frame = this.privJson.get(key);
    if (frame === undefined) {
      frame = `event: table\ndata: ${this.framePrefix},"you":${JSON.stringify(this.privateState(p, withStrength))}}\n\n`;
      this.privJson.set(key, frame);
    }
    return frame;
  }

  // В ленту игроку попадают только разговоры и итог раздачи с комбинацией:
  // перечисление каждого чека и колла её только засоряет. Остальные записи
  // остаются в истории стола — они нужны для разбора и отладки.
  feedSince(id) {
    const out = [];
    for (let i = this.log.length - 1; i >= 0; i--) {
      const line = this.log[i];
      if (line.id <= id) break;
      if (FEED_KINDS.has(line.kind)) out.push(line);
    }
    return out.reverse();
  }

  // Событие ленты для клиента, который видел строки до id. Зрители одного стола
  // обычно стоят на одной отметке, поэтому строка кэшируется.
  logFrameSince(id, reset) {
    const key = reset ? 'all' : id;
    let frame = this.logFrames.get(key);
    if (frame === undefined) {
      const lines = reset ? this.feedSince(0).slice(-120) : this.feedSince(id);
      if (!reset && (!lines || !lines.length)) return null;
      frame = `event: log\ndata: ${JSON.stringify({ reset: !!reset, lines: lines || [] })}\n\n`;
      this.logFrames.set(key, frame);
    }
    return frame;
  }

  // Лента отдаётся отдельным событием и только новыми строками.
  logSince(id) {
    if (!id) return this.log.slice(-120);
    if (!this.log.length || this.log[this.log.length - 1].id <= id) return null;
    let from = this.log.length;
    while (from > 0 && this.log[from - 1].id > id) from -= 1;
    return this.log.slice(from);
  }
}

module.exports = { Table, setEvalBudget };
