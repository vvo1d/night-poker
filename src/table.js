'use strict';
const { freshDeck, shuffle, evaluate, handInfo } = require('./cards');
const { decideBotAction, botThinkingTime } = require('./bot');
const { SNG_AWAY_MS } = require('./tournament');

const PHASES = ['preflop', 'flop', 'turn', 'river'];

// Что показывать в ленте стола: разговоры и итоги раздач.
const FEED_KINDS = new Set(['chat', 'result']);

const REVEAL_STEP = 600;   // пауза перед обязательным вскрытием
const REVEAL_ASK = 3000;   // сколько человек думает, показывать ли проигравшую руку
const REVEAL_BOT = 500;    // бот решает быстро
// Олл-ин: карты открываются сразу, а борд выходит по улице — с паузой, чтобы было видно.
const RUNOUT_FIRST = 1500;  // от вскрытия карт до первой улицы
const RUNOUT_STEP = 1700;   // между улицами и после ривера
const ROUND_PAUSE = 800;    // круг торговли закрыт: столько последняя ставка лежит на столе, потом — в банк
// Между раздачами: сколько висит итог и сколько ждём до новых карт. Длиннее —
// и стол кажется подвисшим: боты ходят быстро, а паузы между раздачами тянутся.
const SHOWDOWN_HOLD = 3500; // итог со вскрытием: карты и выигрыш на виду
const FOLD_HOLD = 1500;     // все сбросили — показывать нечего, только кому ушёл банк
const NEXT_HAND = 1000;     // от конца раздачи до раздачи новых карт

// Реакции за столом: эмодзи и готовые фразы облачком над местом игрока.
const REACTIONS = ['👍', '😂', '😮', '😡', '🔥', '👏', '🤔', '😎'];
const PHRASES = ['Хорошо сыграно', 'Удачи всем', 'Повезло!', 'Ну ты даёшь', 'Спасибо', 'Думаю…', 'Блеф?', 'Ещё раздачу!'];
const REACTION_MS = 3500;  // сколько облачко висит над местом
const REACTION_GAP = 2000; // не чаще раза в две секунды — иначе это спам
const SIT_OUT_MS = 5 * 60_000;   // за кэш-столом отошедший встаёт через 5 минут
const BANTER_GAP = 15_000; // боты отзываются за столом не чаще раза в 15 секунд

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
    Object.assign(this, config); // id, name, maxSeats, sb, bb, minBuyIn, maxBuyIn, timeout, tour
    this.tour = this.tour || null; // турнир, если стол — sit-n-go
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
    this.closeAt = 0;       // круг торговли закрыт — когда собрать ставки в банк (см. closeRound)
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
    this.onHandEnd = hooks.onHandEnd || (() => {});
    this.onHandRecord = hooks.onHandRecord || (() => {});   // запись раздачи для истории
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

  react(userId, text) {
    const p = this.byUser(userId);
    if (!p) return { error: 'Реагировать могут только те, кто сидит за столом' };
    if (!REACTIONS.includes(text) && !PHRASES.includes(text)) return { error: 'Такой реакции нет' };
    const now = Date.now();
    if (p.reaction && now - p.reaction.at < REACTION_GAP) return { error: 'Не так часто' };
    this.reactSeq = (this.reactSeq || 0) + 1;
    p.reaction = { id: this.reactSeq, text, at: now };
    this.touch();
    return { ok: true };
  }

  touch() { this.version++; }

  // Боты не молчат: после крупного банка или обидного вскрытия кто-нибудь из них
  // отзывается реакцией или фразой. Редко — не чаще раза в BANTER_GAP и только
  // если за столом есть люди: живой стол, а не болтливый.
  botBanter(out, rand = Math.random) {
    const now = Date.now();
    if (!this.humans() || now - (this.banterAt || 0) < BANTER_GAP) return;
    const big = this.bb * 10;
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const say = (p, list, chance) => {
      if (rand() >= chance) return false;
      if (this.react(p.userId, pick(list)).ok) { this.banterAt = now; return true; }
      return false;
    };
    for (const r of out) {
      const p = r.player;
      const net = r.won - r.contributed;
      if (p.isBot && net >= big && say(p, ['😎', '🔥', '👍', 'Повезло!', 'Ещё раздачу!'], 0.45)) return;
      if (p.isBot && r.showdown && !r.won && r.contributed >= big && say(p, ['😡', '😮', '🤔', 'Ну ты даёшь'], 0.5)) return;
    }
    // Человек выиграл вскрытие — кто-то из проигравших ботов отдаёт должное.
    const humanWin = out.some((r) => !r.player.isBot && r.showdown && r.won > r.contributed);
    if (humanWin) {
      const loser = out.find((r) => r.player.isBot && r.showdown && !r.won);
      if (loser) say(loser.player, ['👏', 'Хорошо сыграно', '😮', 'Блеф?'], 0.4);
    }
  }

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
    this.botGreet(p);
    this.maybeStartHand();
    return { ok: true };
  }

  // Посадка из снимка после перезапуска: стек как был, без проверки закупки.
  restoreSeat(user, seat, stack, sittingOut = false) {
    if (seat < 0 || seat >= this.maxSeats || this.seats[seat] || this.byUser(user.id)) return { error: 'Место занято' };
    const p = new Player({ userId: user.id, name: user.name, isBot: !!user.isBot, stack, seat });
    p.sittingOut = sittingOut || (stack === 0 && !this.tour);
    this.seats[seat] = p;
    this.byUserId.set(p.userId, p);
    this.emptyAt = 0;
    this.onSeat(p, this);
    this.touch();
    return { ok: true };
  }

  // Человек и боты встретились за столом — кто-нибудь из ботов здоровается.
  botGreet(newcomer, rand = Math.random) {
    const now = Date.now();
    if (!this.humans() || now - (this.banterAt || 0) < BANTER_GAP || rand() >= 0.6) return;
    const bot = newcomer.isBot ? newcomer : this.players().find((x) => x.isBot);
    if (!bot) return;
    const text = ['Удачи всем', '👍', 'Удачи всем'][Math.floor(rand() * 3)];
    if (this.react(bot.userId, text).ok) this.banterAt = now;
  }

  addChips(userId, amount) {
    const p = this.byUser(userId);
    if (!p) return { error: 'Вас нет за столом' };
    if (p.stack + (p.topUp || 0) + amount > this.maxBuyIn) return { error: `Максимум за столом — ${this.maxBuyIn} фишек` };
    // Посреди своей раздачи стек менять нельзя — докупка встанет в стек со следующей.
    if (p.inHand && this.phase !== 'idle') {
      p.topUp = (p.topUp || 0) + amount;
      this.note(`${p.name} докупает ${amount} — со следующей раздачи`, 'seat');
      this.touch();
      return { ok: true, pending: true };
    }
    p.stack += amount;
    if (p.sittingOut && !p.leaving) p.sittingOut = false;
    this.note(`${p.name} докупает ${amount}`, 'seat');
    this.touch();
    this.maybeStartHand();
    return { ok: true };
  }

  // Сдаться в идущем турнире: карты в пас, место — ниже всех, кто ещё играет,
  // турнирные фишки сгорают. Приз за занятое место (если оно призовое) — выплачивается.
  forfeit(userId) {
    const p = this.byUser(userId);
    if (!p) return { error: 'Вас нет за столом' };
    if (!this.tour || this.tour.status !== 'running') return this.leave(userId);
    p.forfeit = true;
    p.sittingOut = true;
    this.note(`${p.name} покидает турнир`, 'seat');
    // Место присуждаем сразу — последнее из неразыгранных; в турнире по расписанию
    // места считает сам турнир, там игрок выбывает по концу раздачи.
    const now = !this.mttId && this.phase !== 'idle';
    if (now) {
      const place = this.players().filter((x) => !x.forfeitPlaced).length;
      p.forfeitPlaced = true;
      this.tour.award(this, p, place);
      this.onUnseat(p, this);   // игрок свободен: может сразу записаться в новый турнир
    }
    if (p.inHand && !p.folded && this.phase !== 'idle') {
      if (this.actingSeat === p.seat) this.applyAction(p, 'fold');
      else { p.folded = true; p.lastAction = 'fold'; this.logAction(p, 'fold'); this.afterFoldCheck(); }
    }
    // Вне раздачи — выбывает сразу; иначе место за столом освободится, когда раздача доиграется.
    if (this.phase === 'idle' && this.byUser(userId)) {
      if (p.forfeitPlaced) this.removePlayer(p);
      else this.tour.bust(this, [p]);
      if (this.players().length <= 1) this.tour.bust(this, []);
      this.maybeStartHand();
    }
    this.touch();
    return { ok: true };
  }

  // Встать из-за стола. Во время своей раздачи — фолд и уход по её завершении.
  leave(userId) {
    const p = this.byUser(userId);
    if (!p) return { error: 'Вас нет за столом' };
    // Из идущего турнира не уходят: место остаётся, блайнды списываются, карты сбрасываются.
    if (this.tour && this.tour.status === 'running') {
      if (!p.sittingOut) this.setSittingOut(userId, true);
      return { error: 'Турнир идёт — место сохранится, а раздачи будут пропускаться' };
    }
    // Посреди раздачи игрок уходит сразу: карты в пас, стек — в банк, он свободен
    // (может сесть за другой стол или на другое место). Стул с его вложенными в банк
    // фишками остаётся «пустой тенью» до конца раздачи — иначе пересчёт банка разъедется.
    if (p.inHand && this.phase !== 'idle') {
      const betting = this.phase !== 'showdown';
      if (betting && !p.folded) {
        if (this.actingSeat === p.seat) this.applyAction(p, 'fold');
        else { p.folded = true; p.lastAction = 'fold'; this.logAction(p, 'fold'); this.afterFoldCheck(); }
      }
      if (!this.seats[p.seat] || this.seats[p.seat] !== p) return { ok: true };   // раздача уже доиграна и место убрано
      p.leaving = true;
      p.leftEarly = true;
      p.sittingOut = true;
      this.byUserId.delete(p.userId);
      this.onUnseat(p, this);
      // На вскрытии выигрыш ещё не роздан — стек вернётся, когда стул освободится.
      if (p.folded) {
        const chips = p.stack + (p.topUp || 0);
        p.stack = 0;
        p.topUp = 0;
        this.onChipsReturn(p, chips);
      }
      this.note(`${p.name} выходит из-за стола`, 'seat');
      this.touch();
      return { ok: true };
    }
    return this.removePlayer(p);
  }

  removePlayer(p) {
    const chips = p.stack + (p.topUp || 0);
    p.topUp = 0;
    this.seats[p.seat] = null;
    // Ушедший посреди раздачи уже освобождён (см. leave) — не трогаем его новую посадку.
    if (!p.leftEarly) {
      this.byUserId.delete(p.userId);
      this.onUnseat(p, this);
    }
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
    // Нажал в свой ход: «пропустить» — ход делается сразу (чек или пас); «вернуться» — снова полное время.
    if (this.actingSeat === p.seat && !p.isBot) {
      this.deadline = value ? Date.now() : Date.now() + this.timeout * 1000;
    }
    this.touch();
    if (!value) this.maybeStartHand();
    return { ok: true };
  }

  // ——— начало раздачи ———

  // В турнире раздают всем, у кого есть фишки: отошедший платит блайнды и сбрасывает карты.
  eligible() {
    if (this.tour) return this.players().filter((p) => p.stack > 0 && !p.leaving);
    return this.players().filter((p) => p.stack > 0 && !p.sittingOut && !p.leaving);
  }

  maybeStartHand() {
    if (this.phase !== 'idle' || this.nextStepAt) return;
    if (this.tour) {
      // Турнир стартует, как только заняты все места.
      if (this.tour.status === 'registering' && this.occupied() === this.maxSeats) this.tour.start(this);
      if (this.tour.status !== 'running') return;
    }
    if (this.eligible().length >= 2) this.nextStepAt = Date.now() + NEXT_HAND;
  }

  startHand() {
    this.closeAt = 0;
    const ready = this.eligible();
    if (ready.length < 2) { this.phase = 'idle'; this.touch(); return; }

    if (this.tour) this.tour.beforeHand(this);
    this.runoutAt = 0;
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
      p.handStartStack = p.stack;
    }

    // Кнопка дилера сдвигается к следующему участнику раздачи.
    const isReady = (p) => p.inHand;
    this.buttonSeat = this.buttonSeat < 0
      ? ready[Math.floor(Math.random() * ready.length)].seat
      : this.nextOccupied(this.buttonSeat, isReady);

    const heads = ready.length === 2;
    const sbSeat = heads ? this.buttonSeat : this.nextOccupied(this.buttonSeat, isReady);
    const bbSeat = this.nextOccupied(sbSeat, isReady);

    // История раздачи: кто с каким стеком сел, затем каждое действие и улица.
    this.history = {
      at: Date.now(),
      table: this.name,
      kind: this.mttId ? 'mtt' : this.tour ? (this.tour.spin ? 'spin' : 'sng') : 'cash',
      sb: this.sb,
      bb: this.bb,
      button: this.buttonSeat,
      players: ready.map((p) => ({ seat: p.seat, name: p.name, bot: !!p.isBot, uid: p.isBot ? null : p.userId, stack: p.stack, cards: [] })),
      actions: [],
      board: [],
    };
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

    for (const h of this.history.players) h.cards = [...this.seats[h.seat].cards];
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
    this.logAction(p, label === 'small blind' ? 'sb' : 'bb', pay, 'preflop');
  }

  // Действие — в историю раздачи: сколько фишек положил и до скольки выросла ставка.
  logAction(p, action, amount = 0, street = this.phase) {
    if (!this.history) return;
    this.history.actions.push({ st: street, seat: p.seat, a: action, amt: amount, to: p.bet, allIn: !!p.allIn });
  }

  // За отошедшего ходит сам стол: чек, если можно, иначе пас.
  // В турнире он так играет каждую раздачу (блайнды платит), за кэш-столом —
  // только ту, в которой нажал «Отойти»: в следующие ему не сдают.
  isAway(p) {
    return !!(p && p.sittingOut && !p.isBot);
  }

  setActor(seat) {
    this.actingSeat = seat;
    if (seat >= 0) {
      const p = this.seats[seat];
      const away = this.isAway(p);
      this.deadline = Date.now() + (p.isBot ? botThinkingTime() : away ? SNG_AWAY_MS : this.timeout * 1000);
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
    if (this.isAway(p)) return { error: 'Вы отошли — сначала вернитесь в игру' };
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
      this.logAction(p, 'fold');
      this.note(`${p.name}: фолд`, 'action');
    } else if (action === 'check') {
      p.lastAction = 'check';
      this.logAction(p, 'check');
      this.note(`${p.name}: чек`, 'action');
    } else if (action === 'call') {
      const pay = Math.min(this.currentBet - p.bet, p.stack);
      this.moveChips(p, pay);
      p.lastAction = 'call';
      this.logAction(p, 'call', pay);
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
      this.logAction(p, p.lastAction, pay);
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

    // Круг торговли закончен. Сразу в банк не собираем: последний колл или чек
    // должен успеть лечь на стол — иначе фишки последнего хода не видны вовсе.
    this.actingSeat = -1;
    this.deadline = 0;
    this.closeAt = Date.now() + ROUND_PAUSE;
    this.touch();
  }

  // Пауза после круга торговли вышла: ставки — в банк, дальше улица, олл-ин или вскрытие.
  closeRound() {
    this.closeAt = 0;
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
    if (this.history) this.history.actions.push({ st: phase, a: 'board', cards: this.board.slice(-count) });
    this.note(`${{ flop: 'Флоп', turn: 'Тёрн', river: 'Ривер' }[phase]}: ${this.board.join(' ')}`, 'street');
    this.touch();
  }

  // Все всё поставили — доводим борд до ривера и вскрываемся.
  // Все в олл-ине: открываем карты, а флоп, тёрн и ривер выкладываем по одной
  // улице с паузами (см. tick) — иначе борд пролетает за мгновение.
  runOut() {
    this.actingSeat = -1;
    this.deadline = 0;
    this.collectBets();
    for (const p of this.inHand()) p.showCards = true;
    // Уже ривер — открывать нечего, сразу на вскрытие (после паузы на карты).
    this.runoutAt = Date.now() + RUNOUT_FIRST;
    this.touch();
  }

  runoutStep(now) {
    const idx = PHASES.indexOf(this.phase);
    if (idx < PHASES.length - 1) {
      this.dealStreet(PHASES[idx + 1]);
      this.runoutAt = now + RUNOUT_STEP;
      return;
    }
    this.runoutAt = 0;
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
      // Кто сколько вложил в этот банк — чтобы показать чистый выигрыш, без своих же фишек.
      const from = new Map();
      for (const p of contributors) {
        const part = Math.max(0, Math.min(p.contributed, level) - Math.min(p.contributed, prev));
        amount += part;
        if (part) from.set(p, part);
      }
      const eligible = contributors.filter((p) => !p.folded && p.inHand && p.contributed >= level);
      if (amount > 0) pots.push({ amount, eligible, from });
      prev = level;
    }
    // Склеиваем соседние банки с одинаковым составом претендентов.
    const merged = [];
    for (const pot of pots) {
      const last = merged[merged.length - 1];
      if (last && last.eligible.length === pot.eligible.length
        && last.eligible.every((p) => pot.eligible.includes(p))) {
        last.amount += pot.amount;
        for (const [p, part] of pot.from) last.from.set(p, (last.from.get(p) || 0) + part);
      } else merged.push(pot);
    }
    return merged;
  }

  showdown() {
    if (this.phase === 'showdown') return;
    this.runoutAt = 0;
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

  endHand() { this.closeAt = 0; this.showdown(); }

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
        // Чистый выигрыш каждого: доля банка минус то, что он сам в этот банк положил.
        net: share_.map(({ p, amount }) => amount - (pot.from.get(p) || 0)),
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
    // Отошедший не ответит, показывать ли карты, — ждём его не дольше бота.
    r.deadline = now + (!r.optional ? REVEAL_STEP : p.isBot || this.isAway(p) ? REVEAL_BOT : REVEAL_ASK);
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

    // Показываем чистый выигрыш: свои же фишки, вернувшиеся из банка, — не выигрыш.
    // Банк, где игрок забрал только свою неуравненную ставку, не показываем вовсе.
    const list = [];
    for (const w of this.pendingWinners) {
      const gain = w.net.reduce((a, b) => a + Math.max(0, b), 0);
      const split = w.players.length > 1;
      if (!gain && !split) continue;
      const entry = {
        potIndex: w.potIndex,
        amount: gain,
        each: split ? Math.max(0, w.net[0]) : gain,
        split,
        names: w.players.map((p) => p.name),
        hand: w.contested && w.players[0].showCards ? w.players[0].handName : null,
        best: w.contested && w.players[0].showCards ? w.players[0].bestCards : null,
      };
      // Основной и побочный банк у одного игрока с одной рукой — одна строка.
      const last = list[list.length - 1];
      if (last && !split && !last.split && last.names[0] === entry.names[0] && last.hand === entry.hand) {
        last.amount += entry.amount;
        last.each += entry.each;
      } else list.push(entry);
    }
    this.lastWinners = list;
    // В ленте остаётся одна строка на банк — с комбинацией и картами, которые её собрали.
    for (const w of this.lastWinners) {
      const combo = w.hand ? ` — ${w.hand}${w.best ? ` · ${w.best.join(' ')}` : ''}` : '';
      const what = !w.split ? `${w.names[0]} выигрывает ${w.amount}`
        : w.each > 0 ? `${w.names.join(', ')} делят банк: по ${w.each}` : `${w.names.join(', ')} делят банк`;
      this.note(`${what}${combo}`, 'result');
    }

    this.pendingWinners = [];
    this.pot = 0;
    this.potParts = [];
    this.nextStepAt = Date.now() + (this.inHand().length > 1 ? SHOWDOWN_HOLD : FOLD_HOLD);
    this.touch();
  }


  finishHand() {
    // Страховка: если раздачу закрывают в обход очереди вскрытия, банки всё равно раздаются.
    if (this.pendingWinners.length) { this.reveal = null; this.awardPots(); }
    this.reportHand();
    this.recordHistory();
    const busted = [];
    const ghosts = [];
    for (const p of this.players()) {
      p.inHand = false;
      p.cards = [];
      p.showCards = false;
      p.mucked = false;
      p.bestCards = null;
      p.lastAction = null;
      // Сдавшийся с уже присуждённым местом просто освобождает стул.
      if (p.forfeitPlaced) { ghosts.push(p); continue; }
      // Сдавшийся в турнире выбывает вместе с вылетевшими — местом ниже их.
      if (this.tour && (p.stack === 0 || p.forfeit)) { busted.push(p); continue; }
      if (p.leaving) { this.removePlayer(p); continue; }
      if (p.topUp) { p.stack += p.topUp; p.topUp = 0; }
      if (p.stack === 0) { p.sittingOut = true; p.busted = true; }
    }
    for (const p of ghosts) this.removePlayer(p);
    if (this.tour) this.tour.bust(this, busted);
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

  // Раздача сыграна — дописываем итог (кто что показал и сколько выиграл) и отдаём в историю.
  recordHistory() {
    const h = this.history;
    this.history = null;
    if (!h) return;
    h.board = [...this.board];
    for (const x of h.players) {
      const p = this.seats[x.seat];
      if (!p || p.name !== x.name) continue;   // встал посреди раздачи — итог неизвестен
      x.shown = !!(p.showCards && !p.mucked);
      x.folded = !!p.folded;
      x.won = p.won || 0;
      x.net = (p.won || 0) - (p.contributed || 0);
      x.hand = x.shown ? p.handName || null : null;
    }
    h.pot = h.players.reduce((sum, x) => sum + (x.won || 0), 0);
    this.onHandRecord(h, this);
  }

  // Итог раздачи по каждому участнику — для статистики игрока. Комбинацию
  // засчитываем только тому, кто дошёл до вскрытия против соперника.
  reportHand() {
    const contested = this.results.size > 1;
    const out = [];
    for (const p of this.players()) {
      if (!p.inHand) continue;
      const showdown = contested && this.results.has(p);
      out.push({
        player: p,
        won: p.won,
        contributed: p.contributed,
        allIn: p.allIn,
        showdown,
        result: showdown ? this.results.get(p) : null,
        bb: this.bb,
      });
    }
    if (out.length) this.onHandEnd(out, this);
    if (out.length) this.botBanter(out);
  }

  potTotal() {
    return this.pot + this.players().reduce((sum, p) => sum + p.bet, 0);
  }

  // ——— часы стола ———

  tick(now = Date.now()) {
    if (this.closeAt && now >= this.closeAt) {
      this.closeRound();
      return;
    }
    if (this.runoutAt && now >= this.runoutAt) {
      this.runoutStep(now);
      return;
    }
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
        // Отошедший ходит без «время вышло»: он сам попросил ходить за него.
        if (!p.sittingOut) this.note(`${p.name}: время вышло`, 'action');
        this.applyAction(p, legal.check ? 'check' : 'fold');
        if (!p.isBot) { p.sittingOut = true; this.touch(); } // отсутствующего игрока снимаем с раздач
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
      kind: this.tour ? 'sng' : 'cash',
      name: this.name,
      invite: this.invite || null,       // код ссылки-приглашения за этот стол
      private: !!this.private,
      owner: this.ownerName || null,
      tour: this.tour ? this.tour.publicState(now) : null,
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
      // Кто смотрит за столом, не садясь (собирает сервер, см. updateAudience).
      audience: this.audience || [],
      seats: this.seats.map((p, i) => {
        if (!p) return { seat: i, empty: true };
        return {
          seat: i,
          name: p.name,
          isBot: p.isBot,
          avatar: p.avatar || null,
          frame: p.frame || null,
          level: p.isBot ? null : (p.level || 1),
          stack: p.stack,
          bet: p.bet,
          inHand: p.inHand,
          folded: p.folded,
          allIn: p.allIn,
          sittingOut: p.sittingOut,
          lastAction: p.lastAction,
          handName: p.handName,
          won: p.won,
          // Чистый выигрыш за раздачу — его и показываем над местом («+N»).
          net: this.phase === 'showdown' ? Math.max(0, p.won - p.contributed) : 0,
          mucked: p.mucked,
          revealing: !!(this.reveal && this.reveal.seat === i),
          winner: this.phase === 'showdown' && p.won > 0,
          champion: this.phase === 'showdown' && p.wonContested,
          cards: p.inHand ? (p.showCards ? p.cards : p.cards.map(() => '??')) : [],
          best: p.bestCards || null,
          // Свежая реакция: клиент сам уберёт облачко, когда выйдет время.
          reaction: p.reaction && now - p.reaction.at < REACTION_MS
            ? { id: p.reaction.id, text: p.reaction.text, ago: now - p.reaction.at } : null,
        };
      }),
    };
  }

  // Личная часть: свои карты, разбор руки и доступные ходы.
  privateState(p, withStrength = true) {
    return {
      seat: p.seat,
      stack: p.stack,
      topUp: p.topUp || 0,            // докупка, которая встанет в стек со следующей раздачи
      forfeit: !!p.forfeit,           // сдался в турнире — выбудет, когда доиграется раздача
      // Сколько ещё можно быть «отошедшим» за кэш-столом, прежде чем вас поднимут.
      sitOutLeft: !this.tour && p.sittingOut && p.sitOutAt ? Math.max(0, p.sitOutAt + SIT_OUT_MS - Date.now()) : 0,
      inHand: p.inHand && this.phase !== 'idle',
      cards: p.cards,
      sittingOut: p.sittingOut,
      busted: !!p.busted,
      hand: this.handInfoFor(p, withStrength),
      canReveal: !!(this.reveal && this.reveal.optional && this.reveal.seat === p.seat),
      // Отошедшему в турнире ходить нечем: стол сам сбросит его карты.
      legal: this.actingSeat === p.seat && !this.isAway(p) ? this.legalActions(p) : null,
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
    // Сдавшийся в турнире — уже зритель, хотя его сброшенная рука ещё доигрывается.
    if (!p || p.forfeitPlaced) return this.frameNoYou;
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

module.exports = { Table, setEvalBudget, REACTIONS, PHRASES, REACTION_MS, SIT_OUT_MS };
