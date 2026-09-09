'use strict';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const fmt = (n) => Number(n || 0).toLocaleString('ru-RU');
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

// Перезапуск CSS-анимации на элементе, который не пересоздавался.
function retrigger(node, cls) {
  if (!node) return;
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
}

const state = {
  user: null,
  view: 'auth',
  table: null,
  stream: null,
  deadline: 0,
  timeout: 25000,
  actionKey: '',
  raiseValue: 0,
  cardValues: new Map(), // ключ карты -> что на ней было в прошлом кадре
  logSeen: new Set(),    // номера уже показанных строк ленты
  snap: null,            // снимок стола для диффа: по нему решаем, что анимировать и озвучивать
  combo: '',
};

// ——— сеть ———

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

async function cmd(payload, { quiet = false } = {}) {
  const { ok, data } = await post('/api/cmd', payload);
  if ((!ok || data.error) && !quiet) toast(data.error || 'Команда не прошла');
  return data;
}

let toastTimer = null;
function toast(text) {
  const node = $('#toast');
  node.textContent = text;
  node.hidden = false;
  retrigger(node, 'toast');
  Sound.play('error', { throttle: 400 });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
}

// ——— экраны ———

function show(view) {
  state.view = view;
  $('#screen-auth').hidden = view !== 'auth';
  $('#screen-lobby').hidden = view !== 'lobby';
  $('#screen-table').hidden = view !== 'table';
  if (view !== 'table') { state.snap = null; state.cardValues.clear(); state.logSeen = new Set(); }
}

function setUser(user) {
  const before = state.user ? state.user.chips : null;
  state.user = user;
  if (!user) return;
  $('#lobby-chips').textContent = fmt(user.chips);
  $('#table-chips').textContent = fmt(user.chips);
  $('#reload-chips').hidden = user.chips >= 200;
  if (before !== null && before !== user.chips) {
    retrigger($('#lobby-chips'), 'is-bump');
    retrigger($('#table-chips'), 'is-bump');
  }
}

// ——— показывать ли карты в конце раздачи ———

const REVEAL_KEY = 'night-poker-reveal';
function revealMode() { return localStorage.getItem(REVEAL_KEY) || 'ask'; }
$('#reveal-mode').value = revealMode();
$('#reveal-mode').addEventListener('change', (e) => {
  localStorage.setItem(REVEAL_KEY, e.target.value);
  Sound.play('click');
});

// ——— звук ———

function paintSoundButtons() {
  const on = Sound.isEnabled();
  document.querySelectorAll('[data-sound-toggle]').forEach((btn) => {
    btn.classList.toggle('is-off', !on);
    btn.setAttribute('aria-pressed', String(on));
    btn.title = on ? 'Выключить звук' : 'Включить звук';
  });
}
document.querySelectorAll('[data-sound-toggle]').forEach((btn) => {
  btn.addEventListener('click', () => { Sound.setEnabled(!Sound.isEnabled()); paintSoundButtons(); });
});
paintSoundButtons();

// ——— вход и регистрация ———

let authMode = 'login';
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    authMode = tab.dataset.mode;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    $('#auth-submit').textContent = authMode === 'login' ? 'Войти' : 'Создать аккаунт';
    $('#auth-hint').textContent = authMode === 'login'
      ? 'Введите имя и пароль, с которыми регистрировались.'
      : 'Новым игрокам сразу начисляется 10 000 фишек.';
    $('#auth-form').password.autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
    $('#auth-error').hidden = true;
  });
});

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const payload = { name: form.name.value, password: form.password.value };
  const { ok, data } = await post(authMode === 'login' ? '/api/login' : '/api/register', payload);
  if (!ok || data.error) {
    const err = $('#auth-error');
    err.textContent = data.error || 'Не удалось войти';
    err.hidden = false;
    retrigger(err, 'error');
    Sound.play('error');
    return;
  }
  form.password.value = '';
  setUser(data.user);
  show('lobby');
  Sound.play('chips');
  connectStream();
});

$('#logout').addEventListener('click', async () => {
  await post('/api/logout');
  if (state.stream) state.stream.close();
  state.stream = null;
  state.user = null;
  show('auth');
});

$('#reload-chips').addEventListener('click', async () => {
  const data = await cmd({ cmd: 'reload' });
  if (data.user) { setUser(data.user); Sound.play('chips'); }
});

// ——— поток событий ———

function connectStream() {
  if (state.stream) state.stream.close();
  const stream = new EventSource('/api/stream');
  state.stream = stream;

  stream.addEventListener('user', (e) => setUser(JSON.parse(e.data)));
  stream.addEventListener('lobby', (e) => {
    const data = JSON.parse(e.data);
    renderLobby(data.rooms, data.leaderboard);
    if (state.view === 'table') show('lobby');
  });
  stream.addEventListener('table', (e) => {
    const data = JSON.parse(e.data);
    // Общий кадр приходит без чужих и своих карт — свои подставляем из личной части.
    if (data.you && data.seats[data.you.seat]) data.seats[data.you.seat].cards = data.you.cards;
    if (state.view !== 'table') show('table');
    renderTable(data);
  });
  stream.addEventListener('log', (e) => {
    const data = JSON.parse(e.data);
    renderLog(data.lines, data.reset);
  });
  stream.onerror = async () => {
    const res = await fetch('/api/me');
    const data = await res.json().catch(() => ({}));
    if (!data.user) { stream.close(); state.stream = null; show('auth'); }
  };
}

// ——— лобби ———

function renderLobby(rooms, leaders) {
  const list = $('#rooms');
  const first = !list.children.length;
  list.textContent = '';
  rooms.forEach((room, i) => {
    const li = el('li', `room${first ? ' is-new' : ''}`);
    li.style.setProperty('--i', i);

    const left = el('div');
    left.append(el('div', 'room__name', room.name));
    left.append(el('div', 'room__meta',
      `Блайнды ${fmt(room.sb)}/${fmt(room.bb)} · закупка ${fmt(room.minBuyIn)}–${fmt(room.maxBuyIn)} · до ${room.maxSeats} игроков`));
    li.append(left);

    // Уровень — это столько столов, сколько нужно игрокам.
    const middle = el('div', 'room__stats');
    middle.append(el('div', 'room__count', `${fmt(room.players)} за столами`));
    const live = el('div', `room__live${room.playing ? ' room__live--hot' : ''}`,
      room.playing
        ? `${fmt(room.playing)} ${plural(room.playing, 'стол играет', 'стола играют', 'столов играют')}`
        : `${fmt(room.tables)} ${plural(room.tables, 'стол ждёт', 'стола ждут', 'столов ждут')}`);
    middle.append(live);
    li.append(middle);

    const join = el('button', 'btn', 'Войти');
    join.title = `Свободных мест: ${fmt(room.free)}`;
    join.addEventListener('click', () => { Sound.play('click'); cmd({ cmd: 'enterRoom', roomId: room.id }); });
    li.append(join);

    list.append(li);
  });

  const board = $('#leaderboard');
  board.textContent = '';
  for (const player of leaders || []) {
    const li = el('li');
    li.append(el('span', null, player.name));
    li.append(el('span', null, fmt(player.chips)));
    board.append(li);
  }
}

// «1 стол», «2 стола», «5 столов»
function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

$('#back-to-lobby').addEventListener('click', async () => {
  const table = state.table;
  const seated = table && table.you;
  if (seated && !confirm('Выйти из-за стола? Фишки вернутся в банк.')) return;
  await cmd({ cmd: 'leaveRoom' });
});

// ——— отрисовка стола ———

const SUIT_GLYPH = { s: '♠', h: '♥', d: '♦', c: '♣' };

const PHASE_LABEL = { preflop: 'префлоп', flop: 'флоп', turn: 'тёрн', river: 'ривер', showdown: 'вскрытие' };

// Фишки: номиналы как в казино, сумма раскладывается на стопки.
const CHIP_VALUES = [5000, 1000, 500, 100, 25, 5, 1];

function chipPiles(amount, maxPiles = 4) {
  const piles = [];
  let left = Math.round(amount);
  for (const value of CHIP_VALUES) {
    if (left < value || piles.length >= maxPiles) continue;
    const count = Math.floor(left / value);
    left -= count * value;
    piles.push({ value, count: Math.min(count, 5) });
  }
  if (!piles.length && amount > 0) piles.push({ value: 1, count: 1 });
  return piles;
}

function chipStack(amount, { small = false } = {}) {
  const box = el('div', `stack${small ? ' stack--sm' : ''}`);
  box.setAttribute('aria-hidden', 'true');
  for (const pile of chipPiles(amount, small ? 2 : 4)) {
    const col = el('div', 'stack__pile');
    for (let i = 0; i < pile.count; i++) {
      const chip = el('div', `chip chip--${pile.value}`);
      chip.style.setProperty('--n', i);
      col.append(chip);
    }
    box.append(col);
  }
  return box;
}

// Карта с двумя сторонами: рубашку можно перевернуть настоящей анимацией.
function cardEl(card, { small = false, dim = false, key = '', mark = '', deal = null } = {}) {
  const node = el('div', `card${small ? ' card--sm' : ''}`);
  const inner = el('div', 'card__inner');
  const front = el('div', 'card__face card__front');
  if (card !== '??') {
    const suit = card[1];
    node.classList.add(`card--${suit}`);
    const glyph = SUIT_GLYPH[suit];
    front.append(el('span', 'card__mark', glyph));
    front.append(el('span', 'card__r', card[0] === 'T' ? '10' : card[0]));
    front.append(el('span', 'card__s', glyph));
  }
  inner.append(front, el('div', 'card__face card__back'));
  node.append(inner);
  if (card === '??') node.classList.add('card--back');
  if (dim) node.classList.add('card--dim');
  if (mark) node.classList.add(mark);

  const was = state.cardValues.get(key);
  state.nextValues.set(key, card);
  if (was === undefined) {
    node.classList.add('card--deal');
    node.style.setProperty('--i', Math.min(state.dealIndex++, 8));
    if (deal) {
      node.style.setProperty('--dx', `${deal.dx}px`);
      node.style.setProperty('--dy', `${deal.dy}px`);
    }
  } else if (was === '??' && card !== '??') {
    node.classList.add('card--flip');
  }
  return node;
}

function seatPositions(n, hero) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const rel = ((i - hero) % n + n) % n;
    const angle = (90 + (rel * 360) / n) * (Math.PI / 180);
    out.push({
      x: 50 + 45 * Math.cos(angle),
      y: 50 + 38 * Math.sin(angle),
    });
  }
  return out;
}

function renderTable(t) {
  const prev = state.snap;
  state.table = t;
  state.nextValues = new Map();
  state.dealIndex = 0;

  const felt = $('#felt');
  const feltW = felt.clientWidth || 800;
  const feltH = felt.clientHeight || 500;

  $('#table-name').textContent = t.name;
  $('#table-stakes').textContent = `блайнды ${fmt(t.sb)}/${fmt(t.bb)} · ${
    t.phase === 'idle' ? 'ожидание' : `${PHASE_LABEL[t.phase]} · раздача №${t.handId}`}`;

  // По ходу игры подсвечиваем только ядро комбинации — без кикеров.
  // На вскрытии показываем выигравшую пятёрку целиком.
  const won = new Set();
  if (t.phase === 'showdown') {
    for (const seat of t.seats) if (!seat.empty && seat.champion && seat.best) seat.best.forEach((c) => won.add(c));
  }
  const live = new Set();
  const hand = t.you && t.you.hand;
  if (hand && hand.usesHole >= 1 && !won.size) {
    // Пока идёт торговля — только ядро комбинации; на вскрытии — вся пятёрка.
    const cards = t.phase === 'showdown' ? hand.cards : hand.core;
    (cards || []).forEach((c) => live.add(c));
  }
  const markOf = (card) => (won.has(card) ? 'card--win' : live.has(card) ? 'card--live' : '');

  // Банк и общие карты
  renderPots(t);
  const onTable = (t.pots || []).reduce((sum, part) => sum + part.amount, 0);
  const pot = $('#pot');
  pot.hidden = !t.pot || t.pot === onTable;
  $('#pot-amount').textContent = fmt(t.pot);
  if (prev && t.pot > prev.pot) retrigger(pot, 'is-bump');

  const board = $('#board');
  board.textContent = '';
  board.classList.toggle('is-showdown', won.size > 0);
  t.board.forEach((card, i) => {
    board.append(cardEl(card, { key: `b${i}-${t.handId}`, mark: markOf(card), deal: { dx: 0, dy: -34 } }));
  });

  // Сообщение в центре стола
  const msg = $('#felt-msg');
  msg.textContent = '';
  msg.classList.remove('is-win');
  if (t.phase === 'showdown' && t.winners.length) {
    msg.classList.add('is-win');
    t.winners.forEach((w, i) => {
      if (i) msg.append(el('span', null, ' · '));
      msg.append(el('span', null, `${w.names.join(', ')} забирает ${fmt(w.amount)}`));
      if (w.hand) { msg.append(el('span', null, ' — ')); msg.append(el('b', null, w.hand)); }
    });
  } else if (t.phase === 'idle') {
    const seated = t.seats.filter((s) => !s.empty && !s.sittingOut).length;
    msg.textContent = seated >= 2
      ? 'Раздаём карты…'
      : 'Нужно минимум два игрока. Займите место или позовите бота.';
  }
  felt.classList.toggle('is-win', won.size > 0);

  // Места
  const hero = t.you ? t.you.seat : 0;
  const positions = seatPositions(t.maxSeats, hero);
  const seatsBox = $('#seats');
  seatsBox.textContent = '';
  seatsBox.classList.toggle('is-showdown', won.size > 0);

  t.seats.forEach((seat, i) => {
    const node = el('div', 'seat');
    node.style.setProperty('--x', `${positions[i].x}%`);
    node.style.setProperty('--y', `${positions[i].y}%`);

    if (seat.empty) {
      const btn = el('button', 'seat__empty', t.you ? `Место ${i + 1}` : `Сесть на ${i + 1}`);
      btn.disabled = !!t.you;
      btn.addEventListener('click', () => openBuyIn(i, t));
      node.append(btn);
      seatsBox.append(node);
      return;
    }

    if (seat.folded) node.classList.add('seat--folded');
    if (seat.you) node.classList.add('seat--you');
    if (t.actingSeat === i) node.classList.add('seat--acting');
    if (seat.winner) node.classList.add('seat--winner');

    // Карты летят из центра стола к месту игрока.
    const deal = {
      dx: ((50 - positions[i].x) / 100) * feltW,
      dy: ((50 - positions[i].y) / 100) * feltH,
    };
    const cards = el('div', 'seat__cards');
    seat.cards.forEach((card, ci) => {
      cards.append(cardEl(card, {
        small: true,
        dim: seat.folded,
        key: `s${i}-${ci}-${t.handId}`,
        mark: seat.folded ? '' : markOf(card),
        deal,
      }));
    });
    node.append(cards);

    const plate = el('div', 'seat__plate');
    plate.append(el('span', 'seat__name', seat.name + (seat.isBot ? ' •' : '')));
    plate.append(el('span', 'seat__stack', fmt(seat.stack)));
    if (seat.mucked) node.classList.add('seat--mucked');
    if (seat.revealing) node.classList.add('seat--revealing');
    const note = seat.mucked ? 'карты в сброс'
      : seat.revealing && !seat.handName ? 'вскрывается…'
        : seat.allIn ? 'олл-ин'
          : seat.sittingOut ? (seat.stack === 0 ? 'без фишек' : 'пропускает')
            : seat.handName || labelAction(seat.lastAction);
    if (note) {
      const noteEl = el('span', `seat__note${seat.handName ? ' seat__note--hand' : ''}`, note);
      noteEl.title = note;
      plate.append(noteEl);
    }
    node.append(plate);

    const timer = el('div', 'seat__timer');
    const fill = el('i');
    fill.style.width = t.actingSeat === i ? '100%' : '0%';
    timer.append(fill);
    node.append(timer);
    if (t.actingSeat === i) node.dataset.timer = '1';


    if (t.buttonSeat === i && t.phase !== 'idle') node.append(el('div', 'seat__badge', 'D'));
    if (seat.won > 0 && t.phase === 'showdown') node.append(el('div', 'seat__win', `+${fmt(seat.won)}`));

    if (seat.isBot && t.you) {
      const kick = el('button', 'seat__kick');
      kick.title = 'Убрать бота';
      kick.setAttribute('aria-label', `Убрать бота ${seat.name}`);
      kick.addEventListener('click', () => cmd({ cmd: 'kickBot', seat: i }));
      node.append(kick);
    }

    seatsBox.append(node);
  });

  renderBets(t, hero);

  state.cardValues = state.nextValues;
  state.deadline = t.timeLeft ? performance.now() + t.timeLeft : 0;
  state.timeout = t.timeout || 25000;
  state.revealDeadline = t.you && t.you.canReveal && t.reveal
    ? performance.now() + t.reveal.timeLeft : 0;

  // Выбранный режим отвечает за нас сам.
  const mode = revealMode();
  if (t.you && t.you.canReveal && mode !== 'ask' && state.revealSent !== t.handId) {
    state.revealSent = t.handId;
    // Отвечаем за игрока молча: если очередь уже ушла, ругаться не за что.
    cmd({ cmd: 'reveal', show: mode === 'always' }, { quiet: true });
  }

  renderMeter(t);
  renderMenu(t);
  renderActions(t);

  const snap = snapshot(t);
  playEffects(t, prev, positions);
  state.snap = snap;
}

// Поставленные фишки лежат на сукне между местом и банком — своим кольцом,
// поэтому они не наезжают на плашки с именами.
function betPositions(n, hero) {
  const out = [];
  const ry = narrow.matches ? 18 : 21;
  for (let i = 0; i < n; i++) {
    const rel = ((i - hero) % n + n) % n;
    const angle = (90 + (rel * 360) / n) * (Math.PI / 180);
    out.push({ x: 50 + 26 * Math.cos(angle), y: 50 + ry * Math.sin(angle), angle });
  }
  return out;
}

// Прямоугольник центра стола: банк, общие карты и надпись под ними.
function centerBox(feltBox) {
  const box = { top: Infinity, bottom: -Infinity, left: Infinity, right: -Infinity };
  for (const sel of ['#pots', '#pot', '#board', '#felt-msg']) {
    const node = $(sel);
    if (!node || node.hidden || !node.getClientRects().length) continue;
    const r = node.getBoundingClientRect();
    if (!r.width) continue;
    box.top = Math.min(box.top, r.top - feltBox.top);
    box.bottom = Math.max(box.bottom, r.bottom - feltBox.top);
    box.left = Math.min(box.left, r.left - feltBox.left);
    box.right = Math.max(box.right, r.right - feltBox.left);
  }
  if (box.top === Infinity) {
    return { top: feltBox.height * 0.42, bottom: feltBox.height * 0.58, left: feltBox.width * 0.35, right: feltBox.width * 0.65 };
  }
  return box;
}

// Ставку кладём в полосу между местом и центром стола: на невысоком экране
// эта полоса узкая, и попасть в неё процентами по эллипсу не получается.
function betSpot(ring, seatBox, core, feltBox) {
  const M = 10;
  let x = (ring.x / 100) * feltBox.width;
  let y = (ring.y / 100) * feltBox.height;
  const sin = Math.sin(ring.angle);
  const cos = Math.cos(ring.angle);

  const middle = (a, b) => (a + b) / 2;
  const NEED = 46; // высота стопки с подписью
  if (Math.abs(sin) > 0.5) {
    // Место сверху или снизу: свободная полоса — по вертикали.
    const [lo, hi] = sin > 0
      ? [core.bottom + M, seatBox.top - M]
      : [seatBox.bottom + M, core.top - M];
    if (hi - lo >= NEED) {
      y = Math.min(Math.max(y, lo), hi);
    } else {
      // Стол низкий, между бортом и картами не влезает — кладём ставку сбоку от места.
      const half = 30;
      const left = seatBox.left - M - half;
      const right = seatBox.right + M + half;
      x = left - half > 0 ? left : right;
      y = middle(seatBox.top, seatBox.bottom) - 6;
    }
  } else {
    const [lo, hi] = cos > 0
      ? [core.right + M, seatBox.left - M]
      : [seatBox.right + M, core.left - M];
    x = hi - lo < 36 ? middle(lo, hi) : Math.min(Math.max(x, lo), hi);
  }
  return { x: (x / feltBox.width) * 100, y: (y / feltBox.height) * 100 };
}

function renderBets(t, hero) {
  const box = $('#bets');
  const prev = state.snap;
  box.textContent = '';

  const feltBox = $('#felt').getBoundingClientRect();
  const core = centerBox(feltBox);
  const seatNodes = $('#seats').children;
  const ring = betPositions(t.maxSeats, hero);

  t.seats.forEach((seat, i) => {
    if (seat.empty || !seat.bet) return;
    const node = seatNodes[i];
    if (!node) return;
    const r = node.getBoundingClientRect();
    const seatBox = {
      top: r.top - feltBox.top,
      bottom: r.bottom - feltBox.top,
      left: r.left - feltBox.left,
      right: r.right - feltBox.left,
    };
    const spot = betSpot(ring[i], seatBox, core, feltBox);

    const was = prev && prev.seats[i] ? prev.seats[i].bet : 0;
    const bet = el('div', `bet${seat.bet !== was ? ' is-new' : ''}`);
    bet.style.setProperty('--x', `${spot.x}%`);
    bet.style.setProperty('--y', `${spot.y}%`);
    bet.append(chipStack(seat.bet, { small: true }));
    bet.append(el('span', 'bet__value', fmt(seat.bet)));
    bet.title = `${seat.name}: ${fmt(seat.bet)}`;
    box.append(bet);
  });
}

// Банк на столе: основной и побочные — каждый своей стопкой фишек.
function renderPots(t) {
  const box = $('#pots');
  const parts = t.pots || [];
  box.textContent = '';
  box.hidden = !parts.length;
  parts.forEach((part, i) => {
    const item = el('div', 'pots__item');
    item.append(chipStack(part.amount));
    const label = parts.length > 1
      ? (i === 0 ? 'основной' : `побочный ${i}`)
      : 'банк';
    const caption = el('div', 'pots__caption');
    caption.append(el('b', null, fmt(part.amount)));
    caption.append(el('span', null, label));
    item.append(caption);
    item.title = parts.length > 1
      ? `${label}: ${fmt(part.amount)}. Играют места ${part.seats.map((n) => n + 1).join(', ')}`
      : `Банк ${fmt(part.amount)}`;
    box.append(item);
  });
}

function labelAction(action) {
  return { fold: 'фолд', check: 'чек', call: 'колл', bet: 'бет', raise: 'рейз', 'small blind': 'малый блайнд', 'big blind': 'большой блайнд' }[action] || '';
}

// ——— силомер руки ———

// На узком экране и за большим столом силомеру негде встать на сукне:
// в углу он наезжает на плашки игроков, поэтому уходит полосой к кнопкам.
const narrow = window.matchMedia('(max-width: 620px)');
function placeMeter() {
  const meter = $('#meter');
  const crowded = !!(state.table && state.table.maxSeats > 6);
  const asBar = narrow.matches || crowded;
  meter.classList.toggle('meter--bar', asBar);
  const target = asBar ? $('.actionbar') : $('#felt');
  if (meter.parentElement !== target) {
    if (asBar) target.insertBefore(meter, $('#actions'));
    else target.append(meter);
  }
}
narrow.addEventListener('change', placeMeter);
placeMeter();

function renderMeter(t) {
  placeMeter();
  const box = $('#meter');
  const hand = t.you && t.you.hand;
  if (!hand) {
    box.hidden = true;
    state.combo = '';
    return;
  }
  box.hidden = false;
  const pct = Math.round(clamp(hand.strength, 0, 1) * 100);
  $('#meter-pct').textContent = `${pct}%`;
  $('#meter-name').textContent = hand.name;
  $('#meter-fill').style.width = `${pct}%`;
  $('#meter-pin').style.left = `calc(${pct}% - 1px)`;
  $('#meter-label').textContent = t.phase === 'showdown' ? 'Итог раздачи'
    : hand.exact ? 'Ваша комбинация' : 'Стартовая рука';
  const note = hand.exact ? `сильнее ${pct}% случайных рук` : 'оценка стартовой руки по Чену';
  $('#meter-note').textContent = note;
  box.title = hand.exact
    ? `${hand.name}. Сильнее ${pct}% случайных рук соперника на этом борде.`
    : `${hand.name}. Оценка стартовой руки по шкале Чена.`;
  box.classList.toggle('is-strong', hand.strength >= 0.72);
  box.classList.toggle('is-weak', hand.strength < 0.34);

  // Комбинация выросла — подмигиваем названием.
  if (state.combo && state.combo !== hand.name) retrigger(box, 'is-up');
  state.combo = hand.name;
}

// Карта в ленте — маленькая иконка, а не буква с цифрой.
const CARD_RE = /\b([2-9TJQKA])([shdc])\b/g;

function miniCard(code) {
  const node = el('span', `mini mini--${code[1]}`);
  node.append(el('b', null, code[0]));
  node.append(el('i', null, SUIT_GLYPH[code[1]]));
  node.title = code;
  return node;
}

// Разбираем строку события: коды карт заменяем иконками, остальное оставляем текстом.
function withCards(text) {
  const box = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(CARD_RE)) {
    if (m.index > last) box.append(document.createTextNode(text.slice(last, m.index)));
    box.append(miniCard(m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) box.append(document.createTextNode(text.slice(last)));
  return box;
}

function logLine(line) {
  const kind = line.kind || 'game';
  const node = el('div', `log__line log__line--${kind}`);

  if (kind === 'chat') {
    const split = line.text.indexOf(': ');
    if (split > 0) {
      node.append(el('b', 'log__who', line.text.slice(0, split)));
      node.append(document.createTextNode(line.text.slice(split + 1)));
    } else node.textContent = line.text;
    return node;
  }

  // «Марго выигрывает 520 — Каре тузов · A♦ A♣ A♥ A♠ 10♣»: комбинация важнее суммы,
  // а карты рисуются иконками.
  const dash = line.text.indexOf(' — ');
  if (kind === 'result' && dash > 0) {
    node.append(document.createTextNode(line.text.slice(0, dash + 3)));
    const combo = el('b', 'log__combo');
    combo.append(withCards(line.text.slice(dash + 3)));
    node.append(combo);
    return node;
  }
  node.append(withCards(line.text));
  return node;
}

// Лента дописывается: прокрутка не прыгает, если игрок читает историю.
function renderLog(lines, reset) {
  const box = $('#log');
  if (reset) { box.textContent = ''; state.logSeen = new Set(); }
  if (!lines || !lines.length) return;

  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
  let added = 0;
  for (const line of lines) {
    if (state.logSeen.has(line.id)) continue;
    state.logSeen.add(line.id);
    box.append(logLine(line));
    added += 1;
  }
  while (box.children.length > 200) box.removeChild(box.firstChild);
  if (!added) return;
  if (atBottom || reset) box.scrollTop = box.scrollHeight;
  else $('#log-more').hidden = false;
}

// ——— анимации и звук по изменению состояния ———

function snapshot(t) {
  return {
    id: t.id,
    handId: t.handId,
    phase: t.phase,
    board: t.board.length,
    pot: t.pot,
    acting: t.actingSeat,
    seats: t.seats.map((s) => (s.empty ? null : {
      bet: s.bet, action: s.lastAction, folded: s.folded, allIn: s.allIn, won: s.won,
      cards: (s.cards || []).join(''), mucked: s.mucked,
    })),
    reveal: t.reveal ? t.reveal.seat : -1,
  };
}

function centerPct(node) {
  const felt = $('#felt').getBoundingClientRect();
  const box = node.getBoundingClientRect();
  if (!box.width) return { x: 50, y: 44 };
  return {
    x: ((box.left + box.width / 2 - felt.left) / felt.width) * 100,
    y: ((box.top + box.height / 2 - felt.top) / felt.height) * 100,
  };
}

function flyChips(from, to, { count = 3, delay = 0 } = {}) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const layer = $('#fly');
  for (let i = 0; i < count; i++) {
    const chip = el('div', 'chip-fly');
    const jitter = () => (Math.random() - 0.5) * 3.5;
    chip.style.left = `${from.x + jitter()}%`;
    chip.style.top = `${from.y + jitter()}%`;
    layer.append(chip);
    const start = delay + i * 60;
    setTimeout(() => {
      chip.style.left = `${to.x + jitter()}%`;
      chip.style.top = `${to.y + jitter()}%`;
      chip.style.opacity = '0.1';
    }, start + 20);
    setTimeout(() => chip.remove(), start + 700);
  }
}

const ACTION_SOUND = {
  fold: 'fold', check: 'check', call: 'chips', bet: 'raise', raise: 'raise',
  'small blind': 'chips', 'big blind': 'chips',
};

function playEffects(t, prev, positions) {
  if (!prev || prev.id !== t.id) return; // первый кадр стола — молча

  if (t.handId !== prev.handId && t.phase === 'preflop') {
    const dealt = t.seats.filter((s) => !s.empty && s.cards.length).length;
    for (let i = 0; i < Math.min(dealt, 6); i++) {
      setTimeout(() => Sound.play('deal'), i * 90);
    }
  }

  if (t.board.length > prev.board) {
    const fresh = t.board.length - prev.board;
    for (let i = 0; i < fresh; i++) setTimeout(() => Sound.play('flip'), i * 110);
  }

  t.seats.forEach((seat, i) => {
    const was = prev.seats[i];
    if (seat.empty || !was) return;
    if (seat.lastAction && seat.lastAction !== was.action) {
      const name = seat.allIn && !was.allIn ? 'allin' : ACTION_SOUND[seat.lastAction];
      if (name) Sound.play(name, { throttle: 60 });
    }
  });

  // Ставки уехали в банк.
  const hadBets = prev.seats.some((s) => s && s.bet > 0);
  const noBets = t.seats.every((s) => s.empty || !s.bet);
  if (hadBets && noBets && t.phase !== 'showdown' && t.pot > 0) {
    const target = centerPct($('#pot').hidden ? $('#board') : $('#pot'));
    const spots = betPositions(t.maxSeats, t.you ? t.you.seat : 0);
    prev.seats.forEach((s, i) => {
      if (s && s.bet > 0 && spots[i]) flyChips(spots[i], target, { count: 2 });
    });

    Sound.play('pot');
  }

  // Вскрытие: банк уезжает к победителям.
  if (t.phase === 'showdown' && prev.phase !== 'showdown') {
    const source = centerPct($('#board'));
    t.seats.forEach((seat, i) => {
      if (!seat.empty && seat.won > 0 && positions[i]) {
        flyChips(source, positions[i], { count: 5, delay: 220 });
      }
    });
    const heroWon = t.you && t.seats[t.you.seat] && t.seats[t.you.seat].won > 0;
    setTimeout(() => Sound.play(heroWon ? 'win' : 'lose'), 260);
  }

  // Кто-то открыл карты.
  t.seats.forEach((seat, i) => {
    const was = prev.seats[i];
    if (seat.empty || !was || seat.you) return;
    const now = (seat.cards || []).join('');
    if (was.cards.includes('?') && now && !now.includes('?')) Sound.play('flip', { throttle: 80 });
    if (!was.mucked && seat.mucked) Sound.play('fold', { throttle: 80 });
  });

  // Наш ход или наша очередь решать, показывать ли карты.
  if (t.you && t.actingSeat === t.you.seat && prev.acting !== t.actingSeat) Sound.play('turn');
  if (t.you && t.you.canReveal && prev.reveal !== t.reveal.seat) Sound.play('turn');
}

// ——— анимация таймера ———

const REVEAL_WINDOW = 5000;

function tickTimer() {
  const reveal = state.revealDeadline > 0;
  const until = reveal ? state.revealDeadline : state.deadline;
  const span = reveal ? REVEAL_WINDOW : state.timeout;
  const left = until ? Math.max(0, until - performance.now()) : 0;
  const share = until ? clamp(left / span, 0, 1) : 0;

  const seatFill = document.querySelector('.seat[data-timer] .seat__timer i');
  if (seatFill) {
    seatFill.style.width = `${share * 100}%`;
    seatFill.classList.toggle('is-low', share < 0.25);
  }

  const t = state.table;
  const yourTurn = reveal || !!(t && t.you && t.actingSeat === t.you.seat);
  const bar = $('#turnbar').firstElementChild;
  bar.style.width = yourTurn ? `${share * 100}%` : '0%';
  bar.classList.toggle('is-low', yourTurn && share < 0.25);

  requestAnimationFrame(tickTimer);
}
requestAnimationFrame(tickTimer);

// ——— панель действий ———

function hotkey(btn, key) {
  btn.append(el('span', 'btn__key', key));
  return btn;
}

// Сколько нужно доставить, чтобы остаться в раздаче (когда ход не наш).
function callAmount(t) {
  const you = t.you;
  if (!you) return 0;
  const seat = t.seats[you.seat];
  return Math.max(0, t.currentBet - (seat && !seat.empty ? seat.bet : 0));
}

// Заранее выбранное действие живёт до тех пор, пока не изменилась ставка:
// если соперник повысил, решение принимается заново.
function checkPre(t) {
  const pre = state.pre;
  if (!pre) return;
  const you = t.you;
  if (!you || !you.inHand || t.handId !== pre.handId) { state.pre = null; return; }

  const toCall = you.legal ? you.legal.toCall : callAmount(t);
  if (pre.action === 'check' && toCall > 0) {
    state.pre = null;
    toast('Ставка изменилась — решайте заново');
    return;
  }
  if (pre.action === 'call' && toCall !== pre.amount) {
    state.pre = null;
    toast('Ставка изменилась — решайте заново');
    return;
  }

  // Дождались своего хода — отправляем то, что выбрали.
  if (you.legal) {
    const action = pre.action === 'call' && you.legal.check ? 'check' : pre.action;
    state.pre = null;
    cmd({ cmd: 'act', action });
  }
}

function preButton(label, action, amount, hint) {
  const armed = state.pre && state.pre.action === action;
  const btn = el('button', `btn btn--pre${armed ? ' is-armed' : ''}`, label);
  btn.title = hint;
  btn.setAttribute('aria-pressed', String(!!armed));
  btn.addEventListener('click', () => {
    const t = state.table;
    state.pre = armed ? null : { action, amount, handId: t.handId };
    Sound.play('click');
    state.actionKey = '';   // перерисуем панель, чтобы кнопка загорелась
    renderActions(t);
  });
  return btn;
}

function renderActions(t) {
  const box = $('#actions');
  const you = t.you;
  const legal = you && you.legal;
  box.classList.toggle('is-your-turn', !!legal || !!(you && you.canReveal));

  const pre = state.pre ? `${state.pre.action}:${state.pre.amount}` : '';
  const key = JSON.stringify([t.handId, t.phase, t.actingSeat, legal, you && you.stack, you && you.sittingOut,
    you && you.inHand, !!you, you && you.canReveal, t.reveal && t.reveal.seat, pre, callAmount(t)]);
  if (key === state.actionKey) return;
  state.actionKey = key;
  box.textContent = '';
  state.setRaise = null; // панель перестроена — старый шаг ставки больше не годится

  const status = el('div', 'actions__status');
  const row = el('div', 'acts');
  box.append(status, row);

  if (!you) {
    status.textContent = 'Вы наблюдаете за столом';
    row.append(el('span', 'actions__wait', 'Займите свободное место, чтобы играть'));
    return;
  }

  // Очередь решать, показывать ли карты.
  if (you.canReveal) {
    status.textContent = 'Показать карты соперникам?';
    const show = el('button', 'btn btn--primary', 'Показать');
    show.addEventListener('click', () => cmd({ cmd: 'reveal', show: true }));
    const hide = el('button', 'btn', 'Убрать в сброс');
    hide.addEventListener('click', () => cmd({ cmd: 'reveal', show: false }));
    row.append(show, hide);
    return;
  }

  if (legal) {
    status.textContent = 'Ваш ход';
    const fold = el('button', 'btn btn--danger', 'Фолд');
    fold.addEventListener('click', () => cmd({ cmd: 'act', action: 'fold' }));
    row.append(hotkey(fold, 'F'));

    if (legal.check) {
      const check = el('button', 'btn', 'Чек');
      check.addEventListener('click', () => cmd({ cmd: 'act', action: 'check' }));
      row.append(hotkey(check, 'C'));
    } else {
      const call = el('button', 'btn', `Колл ${fmt(legal.toCall)}`);
      call.addEventListener('click', () => cmd({ cmd: 'act', action: 'call' }));
      row.append(hotkey(call, 'C'));
    }

    if (legal.minRaiseTo !== undefined) row.append(raiseBox(t, legal));
    return;
  }

  // Ход соперника: кнопки остаются на месте, но теперь это выбор наперёд.
  const acting = t.actingSeat >= 0 && t.seats[t.actingSeat] && !t.seats[t.actingSeat].empty
    ? `Ход: ${t.seats[t.actingSeat].name}`
    : t.phase === 'showdown' ? 'Вскрытие' : 'Ждём начала раздачи';

  const canPre = you.inHand && !you.sittingOut && t.phase !== 'showdown' && t.actingSeat >= 0;
  if (!canPre) {
    status.textContent = acting;
    row.append(raiseBox(t, null));
    return;
  }

  const toCall = callAmount(t);
  const armed = state.pre
    ? (state.pre.action === 'fold' ? 'фолд' : state.pre.action === 'check' ? 'чек' : `колл ${fmt(state.pre.amount)}`)
    : '';
  status.textContent = armed ? `${acting} · заранее выбрано: ${armed}` : `${acting} · можно выбрать ход заранее`;

  row.append(preButton('Фолд', 'fold', 0, 'Сбросить карты, как только дойдёт очередь'));
  row.append(toCall > 0
    ? preButton(`Колл ${fmt(toCall)}`, 'call', toCall, 'Уравнять, если ставка не изменится')
    : preButton('Чек', 'check', 0, 'Чекнуть, если никто не поставит'));
  row.append(raiseBox(t, null));
}

// ——— меню стола ———
// Разметка постоянная: перерисовывать её на каждый кадр нельзя, иначе
// открытое меню будет закрываться само.

function closeMenu() {
  $('#menu-panel').hidden = true;
  $('#menu-toggle').setAttribute('aria-expanded', 'false');
}

$('#menu-toggle').addEventListener('click', (e) => {
  e.stopPropagation();
  const panel = $('#menu-panel');
  panel.hidden = !panel.hidden;
  $('#menu-toggle').setAttribute('aria-expanded', String(!panel.hidden));
  Sound.play('click');
});
document.addEventListener('click', (e) => {
  if (!$('#menu-panel').hidden && !$('#table-menu').contains(e.target)) closeMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

function menuAction(id, run) {
  $(id).addEventListener('click', () => { closeMenu(); run(); });
}
menuAction('#menu-topup', () => {
  const t = state.table;
  const you = t && t.you;
  if (!you) return;
  const want = Math.min(t.maxBuyIn - you.stack, state.user.chips);
  if (want <= 0) return toast('В банке нет свободных фишек');
  cmd({ cmd: 'topUp', amount: want });
});
menuAction('#menu-sitout', () => {
  const you = state.table && state.table.you;
  if (you) cmd({ cmd: 'sitOut', value: !you.sittingOut });
});
menuAction('#menu-bot', () => cmd({ cmd: 'addBot' }));
menuAction('#menu-stand', () => cmd({ cmd: 'standUp' }));

function renderMenu(t) {
  const you = t.you;
  const seated = !!you;
  const free = t.seats.some((s) => s.empty);

  const topup = $('#menu-topup');
  topup.hidden = !(seated && !you.inHand && you.stack < t.maxBuyIn);

  const sitOut = $('#menu-sitout');
  sitOut.hidden = !seated;
  sitOut.textContent = seated && you.sittingOut ? 'Вернуться в игру' : 'Пропустить раздачи';

  const bot = $('#menu-bot');
  bot.disabled = !free;
  bot.title = free ? '' : 'Свободных мест нет';

  $('#menu-stand').hidden = !seated;
}

// Удержание кнопки повторяет шаг и постепенно ускоряется.
function holdRepeat(btn, step) {
  let timer = null;
  let delay = 400;
  const tick = () => { step(); delay = Math.max(55, delay * 0.72); timer = setTimeout(tick, delay); };
  const start = (e) => {
    if (e.button) return;
    e.preventDefault();
    step();
    delay = 400;
    timer = setTimeout(tick, delay);
  };
  const stop = () => { clearTimeout(timer); timer = null; delay = 400; };
  btn.addEventListener('pointerdown', start);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, stop));
}

// Панель повышения: шаг в один блайнд, кнопки, слайдер и быстрые доли банка.
function raiseBox(t, legal) {
  const min = legal.minRaiseTo;
  const max = legal.maxRaiseTo;
  const step = Math.max(1, t.bb);
  state.raiseValue = clamp(state.raiseValue || min, min, max);

  const wrap = el('div', 'raise');

  const presets = el('div', 'raise__presets');
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'raise__slider';
  slider.min = min; slider.max = max; slider.step = 1;

  const amount = el('b', 'raise__amount');
  const hint = el('span', 'raise__hint');
  const minus = el('button', 'raise__step', '−');
  const plus = el('button', 'raise__step', '+');
  minus.type = 'button'; plus.type = 'button';
  minus.title = 'Меньше на блайнд (стрелка вниз)';
  plus.title = 'Больше на блайнд (стрелка вверх)';

  const paint = () => {
    const v = state.raiseValue;
    slider.value = v;
    amount.textContent = fmt(v);
    const share = legal.pot > 0 ? Math.round(((v - legal.toCall) / legal.pot) * 100) : 0;
    hint.textContent = v >= max
      ? `олл-ин · ${(v / t.bb).toFixed(1)} bb`
      : `${(v / t.bb).toFixed(1)} bb · ${share}% банка`;
    minus.disabled = v <= min;
    plus.disabled = v >= max;
    wrap.style.setProperty('--fill', `${max > min ? ((v - min) / (max - min)) * 100 : 100}%`);
  };

  // Шаг всегда кратен блайнду, но крайние значения доступны точно.
  const setValue = (v, snap = false) => {
    let next = clamp(Math.round(v), min, max);
    if (snap && next > min && next < max) {
      next = clamp(min + Math.round((next - min) / step) * step, min, max);
    }
    state.raiseValue = next;
    paint();
  };
  state.setRaise = (delta) => setValue(state.raiseValue + delta * step, true);

  holdRepeat(minus, () => state.setRaise(-1));
  holdRepeat(plus, () => state.setRaise(1));
  slider.addEventListener('input', () => setValue(Number(slider.value)));

  const seen = new Set();
  for (const [label, target] of [
    ['Мин', min],
    ['½ банка', Math.round(legal.toCall + legal.pot * 0.5)],
    ['¾ банка', Math.round(legal.toCall + legal.pot * 0.75)],
    ['Банк', Math.round(legal.toCall + legal.pot)],
    ['Олл-ин', max],
  ]) {
    const value = clamp(target, min, max);
    if (seen.has(value) && label !== 'Олл-ин') continue;
    seen.add(value);
    const b = el('button', 'raise__preset', label);
    b.type = 'button';
    b.addEventListener('click', () => { setValue(value); Sound.play('click'); });
    presets.append(b);
  }

  const submit = el('button', 'btn btn--primary raise__go', legal.isBet ? 'Бет' : 'Рейз');
  hotkey(submit, 'R');
  submit.addEventListener('click', () => {
    cmd({ cmd: 'act', action: legal.isBet ? 'bet' : 'raise', amount: state.raiseValue });
    state.raiseValue = 0;
  });

  const dial = el('div', 'raise__dial');
  dial.append(minus, el('div', 'raise__value', undefined), plus);
  dial.children[1].append(amount, hint);

  wrap.append(presets, dial, slider, submit);
  paint();
  return wrap;
}

// ——— закупка ———

const dialog = $('#buyin-dialog');
let pendingSeat = null;

function openBuyIn(seat, t) {
  pendingSeat = seat;
  const max = Math.min(t.maxBuyIn, state.user.chips);
  if (state.user.chips < t.minBuyIn) {
    toast(`Для этого стола нужно минимум ${fmt(t.minBuyIn)} фишек`);
    return;
  }
  const range = $('#buyin-range');
  range.min = t.minBuyIn;
  range.max = max;
  range.value = Math.min(max, t.bb * 100);
  $('#buyin-note').textContent = `Место ${seat + 1}, блайнды ${fmt(t.sb)}/${fmt(t.bb)}. Закупка от ${fmt(t.minBuyIn)} до ${fmt(max)}.`;
  $('#buyin-value').textContent = fmt(range.value);
  dialog.showModal();
  Sound.play('click');
}

$('#buyin-range').addEventListener('input', (e) => {
  $('#buyin-value').textContent = fmt(e.target.value);
});

$('#buyin-form').addEventListener('submit', (e) => {
  if (e.submitter && e.submitter.value === 'ok' && pendingSeat !== null) {
    cmd({ cmd: 'sit', seat: pendingSeat, buyIn: Number($('#buyin-range').value) });
    Sound.play('chips');
  }
  pendingSeat = null;
});

// ——— чат и лента ———

function toggleLog(open) {
  const side = $('#side');
  side.hidden = open === undefined ? !side.hidden : !open;
  $('#toggle-log').setAttribute('aria-expanded', String(!side.hidden));
  if (!side.hidden) {
    const box = $('#log');
    box.scrollTop = box.scrollHeight;
    $('#log-more').hidden = true;
  }
}
$('#toggle-log').addEventListener('click', () => toggleLog());
$('#close-log').addEventListener('click', () => toggleLog(false));

// Кнопка «новые сообщения» появляется, только если игрок отмотал ленту вверх.
$('#log-more').addEventListener('click', () => {
  const box = $('#log');
  box.scrollTop = box.scrollHeight;
  $('#log-more').hidden = true;
});
$('#log').addEventListener('scroll', (e) => {
  const box = e.currentTarget;
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 48) $('#log-more').hidden = true;
});

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  cmd({ cmd: 'chat', text });
});

// ——— горячие клавиши ———

document.addEventListener('keydown', (e) => {
  if (state.view !== 'table' || e.target.tagName === 'INPUT') return;
  if (e.key === 'm' || e.key === 'ь') {
    Sound.setEnabled(!Sound.isEnabled());
    paintSoundButtons();
    return;
  }
  const legal = state.table && state.table.you && state.table.you.legal;
  if (!legal) return;
  if (e.key === 'f' || e.key === 'а') cmd({ cmd: 'act', action: 'fold' });
  if (e.key === 'c' || e.key === 'с') cmd({ cmd: 'act', action: legal.check ? 'check' : 'call' });
  if (legal.minRaiseTo !== undefined && state.setRaise && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    state.setRaise((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 5 : 1));
    return;
  }
  if ((e.key === 'r' || e.key === 'к') && legal.minRaiseTo !== undefined) {
    cmd({ cmd: 'act', action: legal.isBet ? 'bet' : 'raise', amount: state.raiseValue || legal.minRaiseTo });
  }
});

// ——— старт ———

(async function init() {
  const res = await fetch('/api/me');
  const data = await res.json().catch(() => ({}));
  if (data.user) {
    setUser(data.user);
    show(data.roomId ? 'table' : 'lobby');
    connectStream();
  } else {
    show('auth');
  }
  if (window.innerWidth > 900) toggleLog(true);
})();
