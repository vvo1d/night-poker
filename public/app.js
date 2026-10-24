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

// ——— без зума на телефоне ———

// iOS Safari увеличивает экран двойным тапом, даже когда touch-action это
// запрещает: кнопки перерисовываются между тапами, и второй тап попадает уже
// на новый элемент. Поэтому второй быстрый тап перехватываем сами и отдаём
// кнопке обычным кликом — зума нет, а нажатие не теряется.
const DOUBLE_TAP_MS = 350;
const TAP_SLOP = 12;            // палец сдвинулся сильнее — это прокрутка, а не тап
let tapStart = null;
let lastTapAt = 0;
document.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  tapStart = e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null;
}, { passive: true });
document.addEventListener('touchend', (e) => {
  const t = e.changedTouches[0];
  if (!tapStart || e.touches.length || !t
    || Math.abs(t.clientX - tapStart.x) > TAP_SLOP || Math.abs(t.clientY - tapStart.y) > TAP_SLOP) return;
  const quick = e.timeStamp - lastTapAt < DOUBLE_TAP_MS;
  lastTapAt = e.timeStamp;
  if (!quick) return;
  // Поле ввода должно получить фокус как обычно.
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  e.preventDefault();
  const target = e.target.closest('button, a, label, summary, [role="button"]');
  if (target && !target.disabled) target.click();
}, { passive: false });
// Щипок за столом тоже не нужен: стол и так подогнан под экран.
document.addEventListener('gesturestart', (e) => e.preventDefault());

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
  betSpots: new Map(),   // куда легли фишки — оттуда же они улетают в банк
  pre: null,             // ход, выбранный заранее
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
// Ошибки — красным, хорошие новости (ачивка) — золотом.
function toast(text, { good = false } = {}) {
  const node = $('#toast');
  node.textContent = text;
  node.hidden = false;
  node.classList.toggle('toast--good', good);
  retrigger(node, 'toast');
  Sound.play(good ? 'win' : 'error', { throttle: 400 });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, good ? 4500 : 3200);
}

// ——— экраны ———

function show(view) {
  state.view = view;
  $('#screen-auth').hidden = view !== 'auth';
  $('#screen-lobby').hidden = view !== 'lobby';
  $('#screen-table').hidden = view !== 'table';
  if (view !== 'table') { state.snap = null; state.cardValues.clear(); state.logSeen = new Set(); }
  if (view === 'lobby') showPage(state.page || 'tables');
}

function setUser(user) {
  const before = state.user ? state.user.chips : null;
  state.user = user;
  if (!user) return;
  $('#lobby-chips').textContent = fmt(user.chips);
  $('#table-chips').textContent = fmt(user.chips);
  $('#reload-chips').hidden = user.chips >= 200;
  // Новая ачивка. Ту, что открылась до входа на страницу, заново не показываем.
  const ach = user.achievement;
  if (ach && state.achSeen !== undefined && ach.at > state.achSeen) {
    toast(`${ach.icon} ${ach.title}: ${ach.tierName}`, { good: true });
  }
  if (ach) state.achSeen = Math.max(state.achSeen || 0, ach.at);
  else if (state.achSeen === undefined) state.achSeen = 0;

  // Заявки в друзья: число на вкладке «Кабинет», о новой — всплывашка.
  const requests = user.friendRequests || 0;
  const badge = $('#requests-badge');
  badge.textContent = String(requests);
  badge.hidden = !requests;
  if (state.requests !== undefined && requests > state.requests) {
    toast('Новая заявка в друзья — она в кабинете', { good: true });
    if (state.view === 'lobby') showPage(state.page);   // обновим открытый раздел
  }
  state.requests = requests;
  if (before !== null && before !== user.chips) {
    retrigger($('#lobby-chips'), 'is-bump');
    retrigger($('#table-chips'), 'is-bump');
  }
}

// ——— показывать ли карты в конце раздачи ———

// Силомер можно выключить: панель прячется, а сервер перестаёт считать
// для этого игрока перебор рук соперника — самую тяжёлую часть.
const METER_KEY = 'night-poker-meter';
function meterOn() { return localStorage.getItem(METER_KEY) !== 'off'; }
$('#meter-mode').checked = meterOn();
$('#meter-mode').addEventListener('change', (e) => {
  localStorage.setItem(METER_KEY, e.target.checked ? 'on' : 'off');
  cmd({ cmd: 'prefs', meter: e.target.checked }, { quiet: true });
  Sound.play('click');
  if (state.table) renderMeter(state.table);
});

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

  if (!meterOn()) cmd({ cmd: 'prefs', meter: false }, { quiet: true });

  stream.addEventListener('user', (e) => setUser(JSON.parse(e.data)));
  stream.addEventListener('lobby', (e) => {
    const data = JSON.parse(e.data);
    renderLobby(data);
    if (state.view === 'table') show('lobby');
  });
  stream.addEventListener('table', (e) => {
    const data = JSON.parse(e.data);
    // Общий кадр приходит без чужих и своих карт — свои подставляем из личной части.
    if (data.you && data.seats[data.you.seat]) data.seats[data.you.seat].cards = data.you.cards;
    // Отошедший в турнире не ходит вовсе: карты за него сбрасывает стол.
    // Ходы гасим и здесь, а не только на сервере, — так кнопки не оживают ни на миг.
    if (data.you && data.you.sittingOut && data.tour && data.tour.status === 'running') data.you.legal = null;
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

const FILTER_KEY = 'night-poker-filter';
function lobbyFilter() {
  try { return localStorage.getItem(FILTER_KEY) || 'all'; } catch { return 'all'; }
}

function paintFilter() {
  const current = lobbyFilter();
  document.querySelectorAll('#lobby-filter .filter').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.filter === current);
    b.setAttribute('aria-selected', String(b.dataset.filter === current));
  });
}
document.querySelectorAll('#lobby-filter .filter').forEach((btn) => {
  btn.addEventListener('click', () => {
    try { localStorage.setItem(FILTER_KEY, btn.dataset.filter); } catch { /* без памяти фильтр живёт до перезагрузки */ }
    paintFilter();
    Sound.play('click');
    if (state.lobby) renderLobby(state.lobby);
  });
});
paintFilter();

// Места стола точками: золотая — человек, серая — бот, пустая — свободно.
function seatDots(seats) {
  const box = el('div', 'room__seats');
  box.setAttribute('aria-hidden', 'true');
  for (const s of seats) box.append(el('span', `dot${s === 1 ? ' dot--human' : s === 2 ? ' dot--bot' : ''}`));
  return box;
}

function roomMeta(room) {
  if (room.kind === 'sng') {
    const sng = room.sng;
    return `Сит-н-гоу на ${room.maxSeats} · взнос ${fmt(sng.buyIn)} · призы ${sng.prizes.map(fmt).join(' / ')}`;
  }
  const who = room.house ? 'стол заведения' : `открыл ${room.owner}`;
  return `Блайнды ${fmt(room.sb)}/${fmt(room.bb)} · закупка ${fmt(room.minBuyIn)}–${fmt(room.maxBuyIn)} · ${room.timeout} с на ход · ${who}`;
}

function roomStatus(room) {
  const taken = room.seats.filter(Boolean).length;
  if (room.kind === 'sng') {
    const sng = room.sng;
    if (sng.status === 'registering') return { text: `Регистрация ${taken}/${room.maxSeats}`, hot: false };
    if (sng.status === 'running') {
      return { text: `Идёт · уровень ${sng.level} · ${fmt(room.sb)}/${fmt(room.bb)} · осталось ${sng.left}`, hot: true };
    }
    return { text: sng.winner ? `Завершён · победил ${sng.winner}` : 'Завершён', hot: false };
  }
  return { text: room.playing ? 'идёт раздача' : taken ? 'ждёт игроков' : 'свободен', hot: room.playing };
}

function renderLobby(data) {
  state.lobby = data;
  const filter = lobbyFilter();
  const rooms = data.rooms.filter((r) => filter === 'all' || r.kind === filter);
  const list = $('#rooms');
  const first = !list.children.length;
  list.textContent = '';
  rooms.forEach((room, i) => {
    const li = el('li', `room room--${room.kind}${first ? ' is-new' : ''}`);
    li.style.setProperty('--i', Math.min(i, 12));

    const left = el('div');
    const name = el('div', 'room__name', room.name);
    if (room.kind === 'sng') name.append(el('span', 'room__tag', 'турнир'));
    left.append(name);
    left.append(el('div', 'room__meta', roomMeta(room)));
    li.append(left);

    const middle = el('div', 'room__stats');
    middle.append(seatDots(room.seats));
    const status = roomStatus(room);
    middle.append(el('div', `room__live${status.hot ? ' room__live--hot' : ''}`, status.text));
    li.append(middle);

    const free = room.seats.filter((s) => s === 0).length;
    const canJoin = room.kind === 'sng' ? room.sng.status === 'registering' && free > 0 : free > 0;
    const join = el('button', `btn${canJoin ? '' : ' btn--ghost'}`, canJoin ? 'Войти' : 'Смотреть');
    join.title = `Свободных мест: ${fmt(free)}`;
    join.addEventListener('click', () => { Sound.play('click'); cmd({ cmd: 'enterRoom', roomId: room.id }); });
    li.append(join);

    list.append(li);
  });
  $('#rooms-empty').hidden = rooms.length > 0;

  const totals = data.totals;
  $('#lobby-totals').textContent = totals
    ? `${fmt(totals.tables)} ${plural(totals.tables, 'стол', 'стола', 'столов')} · ${fmt(totals.players)} за столами`
    : '';
  if (data.stakes) state.stakes = data.stakes;
  if (data.sngBuyIns) state.sngBuyIns = data.sngBuyIns;
}

// ——— разделы лобби: столы, рейтинг, кабинет ———

function showPage(page) {
  state.page = page;
  document.querySelectorAll('#pages .pages__tab').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.page === page);
    b.setAttribute('aria-selected', String(b.dataset.page === page));
  });
  $('#page-tables').hidden = page !== 'tables';
  $('#page-rating').hidden = page !== 'rating';
  $('#page-profile').hidden = page !== 'profile';
  if (page === 'tables') loadFriends();
  if (page === 'rating') loadRating();
  if (page === 'profile') loadOwnProfile();
}
document.querySelectorAll('#pages .pages__tab').forEach((btn) => {
  btn.addEventListener('click', () => { Sound.play('click'); showPage(btn.dataset.page); });
});

async function getJson(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { toast(data.error || 'Не удалось загрузить'); return null; }
  return data;
}

// Друзья в лобби: кто онлайн и за каким столом. Сервер не шлёт это потоком,
// поэтому список обновляется опросом, пока открыт раздел столов.
async function loadFriends() {
  const data = await getJson('/api/friends');
  if (!data) return;
  renderFriends($('#friends-mini'), data.friends, { mini: true });
  renderRequests($('#requests-mini'), data.incoming, () => loadFriends());
}

// Входящие заявки: принять или отклонить прямо из списка.
function renderRequests(list, incoming, done) {
  list.textContent = '';
  list.hidden = !incoming.length;
  for (const f of incoming) {
    const li = el('li', 'friend friend--request');
    const who = el('button', 'friend__who');
    who.type = 'button';
    who.append(el('span', 'friend__name', f.name));
    who.title = 'Открыть профиль';
    who.addEventListener('click', () => openProfile(f.name));
    li.append(who, el('span', 'friend__status', 'хочет дружить'));
    const yes = el('button', 'btn btn--primary btn--sm', 'Принять');
    yes.addEventListener('click', async () => {
      const res = await cmd({ cmd: 'acceptFriend', name: f.name });
      if (res.ok) { Sound.play('chips'); done(); }
    });
    const no = el('button', 'btn btn--ghost btn--sm', 'Отклонить');
    no.addEventListener('click', async () => {
      const res = await cmd({ cmd: 'declineFriend', name: f.name });
      if (res.ok) done();
    });
    li.append(yes, no);
    list.append(li);
  }
}
setInterval(() => {
  if (state.view === 'lobby' && state.page === 'tables' && !document.hidden) loadFriends();
}, 15_000);

function friendStatus(f) {
  if (f.table) return `${f.online ? '' : 'не в сети · '}за столом «${f.table.name}»`;
  return f.online ? 'онлайн' : 'не в сети';
}

function renderFriends(list, friends, { mini = false, onRemove = null, removeTitle = 'Убрать из друзей' } = {}) {
  list.textContent = '';
  if (mini) $('#friends-mini-empty').hidden = friends.length > 0;
  for (const f of friends) {
    const li = el('li', `friend${f.online ? ' is-online' : ''}`);
    const who = el('button', 'friend__who');
    who.type = 'button';
    who.append(el('span', 'friend__dot'), el('span', 'friend__name', f.name));
    who.title = 'Открыть профиль';
    who.addEventListener('click', () => openProfile(f.name));
    li.append(who);
    li.append(el('span', 'friend__status', friendStatus(f)));
    if (f.table) {
      const go = el('button', 'btn btn--ghost btn--sm', 'К столу');
      go.addEventListener('click', () => goToTable(f.table.id));
      li.append(go);
    }
    if (onRemove) {
      const drop = el('button', 'friend__drop');
      drop.title = removeTitle;
      drop.setAttribute('aria-label', `${removeTitle}: ${f.name}`);
      drop.addEventListener('click', () => onRemove(f.name));
      li.append(drop);
    }
    list.append(li);
  }
}

function goToTable(id) {
  if ($('#profile-dialog').open) $('#profile-dialog').close();
  Sound.play('click');
  cmd({ cmd: 'enterRoom', roomId: id });
}

// ——— рейтинг ———

const RATING_COLS = {
  chips: { label: 'Фишки', value: (r) => fmt(r.chips) },
  wins: { label: 'Выиграно раздач', value: (r) => `${fmt(r.handsWon)} · ${r.winRate}%` },
  sng: { label: 'Побед в турнирах', value: (r) => `${fmt(r.sngWins)} · ${fmt(r.sngPrizes)}` },
};

document.querySelectorAll('#rating-filter .filter').forEach((btn) => {
  btn.addEventListener('click', () => { Sound.play('click'); loadRating(btn.dataset.by); });
});

async function loadRating(by = state.ratingBy || 'chips') {
  state.ratingBy = by;
  document.querySelectorAll('#rating-filter .filter').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.by === by);
    b.setAttribute('aria-selected', String(b.dataset.by === by));
  });
  const data = await getJson(`/api/rating?by=${by}`);
  if (data && state.ratingBy === by) renderRating(data);
}

function ratingRow(r, col) {
  const row = el('button', `rating__row${r.you ? ' is-you' : ''}${r.place <= 3 ? ` is-top is-top-${r.place}` : ''}`);
  row.type = 'button';
  row.title = 'Открыть профиль';
  row.append(el('span', 'rating__place', String(r.place)));
  const who = el('span', 'rating__name', r.name);
  if (r.you) who.append(el('span', 'rating__you', 'вы'));
  row.append(who);
  row.append(el('span', 'rating__hands', `${fmt(r.hands)} ${plural(r.hands, 'раздача', 'раздачи', 'раздач')}`));
  row.append(el('span', 'rating__ach', `★ ${r.achievements}`));
  row.append(el('span', 'rating__value', col.value(r)));
  row.addEventListener('click', () => openProfile(r.name));
  return row;
}

function renderRating(data) {
  const box = $('#rating');
  const col = RATING_COLS[data.by];
  box.textContent = '';
  const head = el('div', 'rating__row rating__row--head');
  head.append(el('span', 'rating__place', '#'), el('span', 'rating__name', 'Игрок'),
    el('span', 'rating__hands', 'Раздач'), el('span', 'rating__ach', 'Ачивки'), el('span', 'rating__value', col.label));
  box.append(head);
  data.top.forEach((r) => box.append(ratingRow(r, col)));
  if (data.me) {
    box.append(el('div', 'rating__gap', '…'));
    box.append(ratingRow(data.me, col));
  }
  $('#rating-note').textContent = `Пятьдесят лучших из ${fmt(data.total)}. Нажмите на игрока, чтобы открыть его профиль.`;
}

// ——— профиль и кабинет ———

async function loadOwnProfile() {
  const data = await getJson('/api/profile');
  if (data && state.page === 'profile') renderProfile($('#profile-own'), data);
}

async function openProfile(name) {
  if (!name) return;
  if (state.user && name === state.user.name && state.view === 'lobby') { showPage('profile'); return; }
  const data = await getJson(`/api/profile?name=${encodeURIComponent(name)}`);
  if (!data) return;
  renderProfile($('#profile-body'), data);
  const dialog = $('#profile-dialog');
  if (!dialog.open) dialog.showModal();
  Sound.play('click');
}
$('#profile-close').addEventListener('click', () => $('#profile-dialog').close());
// Клик по затемнению вокруг окна закрывает его.
$('#profile-dialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

// Профиль перерисовывается целиком: после дружбы или удаления — свежими данными.
async function refreshProfile(data, box) {
  const fresh = await getJson(data.own ? '/api/profile' : `/api/profile?name=${encodeURIComponent(data.name)}`);
  if (fresh) renderProfile(box, fresh);
}

const DATE_FMT = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

function statCard(value, label, note = '') {
  const card = el('div', 'stat');
  card.append(el('b', 'stat__value', value), el('span', 'stat__label', label));
  if (note) card.append(el('span', 'stat__note', note));
  return card;
}

function profileSection(title, extra) {
  const sec = el('section', 'profile__section');
  const h = el('h3', null, title);
  if (extra) h.append(el('span', 'profile__count', extra));
  sec.append(h);
  return sec;
}

// Кнопки дружбы в чужом профиле — по тому, кем вы друг другу приходитесь.
function friendButtons(data, box) {
  const act = (label, cls, command, after) => {
    const b = el('button', `btn btn--sm ${cls}`, label);
    b.addEventListener('click', async () => {
      if (command === 'removeFriend' && !confirm(`Убрать ${data.name} из друзей?`)) return;
      const res = await cmd({ cmd: command, name: data.name });
      if (!res.ok) return;
      if (after) toast(after, { good: true });
      Sound.play('chips');
      refreshProfile(data, box);
      if (state.view === 'lobby' && state.page === 'tables') loadFriends();
    });
    return b;
  };
  switch (data.relation) {
    case 'friend': {
      const mark = el('span', 'profile__badge', 'В друзьях ✓');
      return [mark, act('Убрать из друзей', 'btn--ghost', 'removeFriend')];
    }
    case 'out':
      return [el('span', 'profile__badge profile__badge--wait', 'Заявка отправлена'),
        act('Отозвать', 'btn--ghost', 'declineFriend')];
    case 'in':
      return [act('Принять заявку', 'btn--primary', 'acceptFriend', `${data.name} теперь в друзьях`),
        act('Отклонить', 'btn--ghost', 'declineFriend')];
    default:
      return [act('Добавить в друзья', 'btn--primary', 'addFriend', 'Заявка отправлена — ждём ответа')];
  }
}

// Ачивка: медаль цвета ступени, точки взятых ступеней и полоска до следующей.
function achievementItem(a) {
  const li = el('li', `ach__item${a.tier ? ` is-open tier-${a.tier}` : ''}`);
  li.append(el('span', 'ach__icon', a.icon));
  const text = el('div', 'ach__text');
  const title = el('b', null, a.title);
  if (a.tierName) title.append(el('span', 'ach__tier', a.tierName));
  text.append(title);

  const steps = el('span', 'ach__steps');
  for (let i = 1; i <= a.tiers; i++) steps.append(el('i', i <= a.tier ? `tier-${i}` : ''));
  text.append(steps);

  if (a.goal) {
    text.append(el('span', 'ach__goal', `Дальше: ${a.goal}`));
    if (a.next !== null) {
      const bar = el('span', 'ach__bar');
      const fill = el('i');
      fill.style.width = `${Math.round(a.share * 100)}%`;
      bar.append(fill);
      text.append(bar, el('small', null, `${fmt(Math.min(a.value, a.next))} / ${fmt(a.next)}`));
    }
  } else {
    text.append(el('span', 'ach__goal', `Все ступени взяты: ${a.done.toLowerCase()}`));
  }
  li.append(text);
  li.title = a.tier
    ? `${a.title}, ${a.tierName}: ${a.done.toLowerCase()} · ${DATE_FMT.format(new Date(a.at))}`
    : `${a.title}: ${a.goal.toLowerCase()}`;
  return li;
}

function renderProfile(box, data) {
  box.textContent = '';
  const s = data.stats;
  const root = el('div', 'profile');

  // Шапка: имя, с каких пор в игре, где сейчас.
  const head = el('header', 'profile__head');
  head.append(el('div', 'avatar', data.name.slice(0, 1).toUpperCase()));
  const title = el('div', 'profile__title');
  title.append(el('h2', null, data.name));
  const where = data.table ? ` · за столом «${data.table.name}»` : '';
  const sub = el('p', `profile__sub${data.online ? ' is-online' : ''}`,
    `${data.online ? 'онлайн' : 'не в сети'}${where} · в игре с ${DATE_FMT.format(new Date(data.createdAt))}`);
  title.append(sub);
  head.append(title);

  const actions = el('div', 'profile__actions');
  if (!data.own) actions.append(...friendButtons(data, box));
  if (data.table && !(state.table && state.table.id === data.table.id && state.view === 'table')) {
    const go = el('button', 'btn btn--ghost btn--sm', 'К столу');
    go.addEventListener('click', () => goToTable(data.table.id));
    actions.append(go);
  }
  head.append(actions);
  root.append(head);

  // Статистика игр.
  const games = profileSection('Статистика');
  const grid = el('div', 'stats');
  const rate = s.handsPlayed ? Math.round((s.handsWon / s.handsPlayed) * 100) : 0;
  grid.append(
    statCard(fmt(data.chips), 'фишек в банке', `максимум ${fmt(s.peakChips)}`),
    statCard(fmt(s.handsPlayed), 'раздач сыграно'),
    statCard(fmt(s.handsWon), 'раздач выиграно', `${rate}% от сыгранных`),
    statCard(fmt(s.handsLost), 'раздач проиграно', 'вложил фишки и не забрал банк'),
    statCard(`${fmt(s.showdownsWon)} из ${fmt(s.showdowns)}`, 'вскрытий выиграно'),
    statCard(fmt(s.biggestPot), 'крупнейший банк'),
    statCard(fmt(s.allInsWon), 'олл-инов выиграно'),
    statCard(`${s.cashNet > 0 ? '+' : ''}${fmt(s.cashNet)}`, 'итог кэш-игры', 'выиграно минус вложено'),
  );
  const best = statCard(s.bestHand ? s.bestHand.name : '—', 'лучшая комбинация');
  best.classList.add('stat--wide');
  if (s.bestHand && s.bestHand.cards) {
    const cards = el('span', 'stat__cards');
    s.bestHand.cards.forEach((c) => cards.append(miniCard(c)));
    best.append(cards);
  }
  grid.append(best);
  games.append(grid);
  root.append(games);

  const sng = profileSection('Сит-н-гоу');
  const sngGrid = el('div', 'stats');
  sngGrid.append(
    statCard(fmt(s.sngPlayed), 'турниров сыграно'),
    statCard(fmt(s.sngCashes), 'в призах'),
    statCard(fmt(s.sngWins), 'побед'),
    statCard(fmt(s.sngPrizes), 'получено призами'),
  );
  sng.append(sngGrid);
  root.append(sng);

  // Ачивки: ступень, прогресс к следующей и что для неё нужно.
  const achSec = profileSection('Ачивки', `${data.tiers.got} из ${data.tiers.of} ступеней`);
  const achList = el('ul', 'ach');
  for (const a of data.achievements) achList.append(achievementItem(a));
  achSec.append(achList);
  root.append(achSec);

  // Свои друзья и заявки — только в своём кабинете.
  if (data.own) {
    const { friends, incoming, outgoing } = data.friends;
    const again = () => refreshProfile(data, box);
    const fr = profileSection('Друзья', friends.length ? String(friends.length) : '');

    const form = el('form', 'friend-add');
    const input = document.createElement('input');
    input.placeholder = 'Имя игрока';
    input.maxLength = 16;
    input.autocomplete = 'off';
    const add = el('button', 'btn btn--sm', 'Отправить заявку');
    add.type = 'submit';
    form.append(input, add);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      const res = await cmd({ cmd: 'addFriend', name });
      if (res.ok) {
        toast(res.status === 'friend' ? `${name} теперь в друзьях` : `Заявка отправлена — ждём ответа ${name}`, { good: true });
        again();
      }
    });
    fr.append(form);

    if (incoming.length) {
      fr.append(el('h4', 'profile__sub-head', `Хотят дружить · ${incoming.length}`));
      const list = el('ul', 'friends');
      renderRequests(list, incoming, again);
      fr.append(list);
    }

    if (friends.length) {
      const list = el('ul', 'friends');
      renderFriends(list, friends, {
        onRemove: async (name) => {
          if (!confirm(`Убрать ${name} из друзей? Вы пропадёте и из его списка.`)) return;
          const res = await cmd({ cmd: 'removeFriend', name });
          if (res.ok) again();
        },
      });
      fr.append(list);
    } else {
      fr.append(el('p', 'hint', 'Пока никого. Отправьте заявку по имени или из профиля игрока — он должен её принять.'));
    }

    if (outgoing.length) {
      fr.append(el('h4', 'profile__sub-head', `Ждут ответа · ${outgoing.length}`));
      const list = el('ul', 'friends');
      renderFriends(list, outgoing, {
        removeTitle: 'Отозвать заявку',
        onRemove: async (name) => {
          const res = await cmd({ cmd: 'declineFriend', name });
          if (res.ok) again();
        },
      });
      fr.append(list);
    }
    root.append(fr);
  }

  box.append(root);
}

// ——— новый стол ———

// Призы сит-н-гоу — те же доли, что считает сервер.
const SNG_SHARES = { 6: [0.65, 0.35], 9: [0.5, 0.3, 0.2] };
const SNG_STACK = 1000; // турнирный стек одинаков при любом взносе
function sngPrizes(seats, buyIn) {
  const pool = seats * buyIn;
  const prizes = SNG_SHARES[seats].map((share) => Math.floor(pool * share));
  prizes[0] += pool - prizes.reduce((a, b) => a + b, 0);
  return prizes;
}

const createDialog = $('#create-dialog');
const createForm = $('#create-form');

function createChoice(name) {
  const picked = createForm.querySelector(`input[name="${name}"]:checked`);
  return picked ? picked.value : null;
}

function paintCreate() {
  const kind = createChoice('kind');
  createForm.querySelectorAll('[data-kind]').forEach((node) => { node.hidden = node.dataset.kind !== kind; });
  const note = $('#create-note');
  if (kind === 'sng') {
    const seats = Number(createChoice('sngSeats'));
    const buyIn = Number(createChoice('buyIn')) || 0;
    const prizes = sngPrizes(seats, buyIn);
    const places = prizes.map((p, i) => `${i + 1} место — ${fmt(p)}`).join(', ');
    note.textContent = `Взнос ${fmt(buyIn)} из банка, в турнире у каждого ${fmt(SNG_STACK)} фишек. `
      + `Игра на вылет, блайнды растут каждые 2 минуты. `
      + `Фонд ${fmt(seats * buyIn)}: ${places}. Турнир начнётся, когда займут все ${seats} мест.`;
  } else {
    const stake = (state.stakes || [])[Number(createChoice('stake'))];
    note.textContent = stake
      ? `Закупка от ${fmt(stake[1] * 20)} до ${fmt(stake[1] * 100)} фишек. Пустой стол закрывается через 5 минут.`
      : '';
  }
}

$('#create-open').addEventListener('click', () => {
  const stakes = state.stakes || [];
  const box = $('#create-stakes');
  if (!box.children.length) {
    stakes.forEach(([sb, bb], i) => {
      const label = el('label');
      const input = document.createElement('input');
      input.type = 'radio'; input.name = 'stake'; input.value = String(i);
      if (i === 2) input.checked = true;
      label.append(input, el('span', null, `${fmt(sb)}/${fmt(bb)}`));
      box.append(label);
    });
  }
  const buyIns = $('#create-buyins');
  if (!buyIns.children.length) {
    (state.sngBuyIns || []).forEach((value) => {
      const label = el('label');
      const input = document.createElement('input');
      input.type = 'radio'; input.name = 'buyIn'; input.value = String(value);
      if (value === 1000) input.checked = true;
      label.append(input, el('span', null, fmt(value)));
      buyIns.append(label);
    });
  }
  paintCreate();
  createDialog.showModal();
  Sound.play('click');
});
createForm.addEventListener('change', paintCreate);

createForm.addEventListener('submit', async (e) => {
  if (!e.submitter || e.submitter.value !== 'ok') return;
  const kind = createChoice('kind');
  const name = createForm.elements.namedItem('name').value;
  const payload = kind === 'sng'
    ? { cmd: 'createTable', kind, name, seats: Number(createChoice('sngSeats')), buyIn: Number(createChoice('buyIn')) }
    : {
      cmd: 'createTable', kind, name,
      stake: Number(createChoice('stake')),
      seats: Number(createChoice('seats')),
      timeout: Number(createChoice('timeout')),
    };
  const res = await cmd(payload);
  if (res.ok) { createForm.elements.namedItem('name').value = ''; Sound.play('chips'); }
});

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
  const tour = table && table.tour;
  const question = !seated ? null
    : !tour ? 'Выйти из-за стола? Фишки вернутся в банк.'
      : tour.status === 'registering' ? 'Отменить регистрацию? Взнос вернётся в банк.'
        : 'Турнир идёт. Выйти в лобби? Место сохранится, но раздачи будут пропускаться, а блайнды — списываться.';
  if (question && !confirm(question)) return;
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
  const tour = t.tour;
  const stage = t.phase === 'idle' ? 'ожидание' : `${PHASE_LABEL[t.phase]} · раздача №${t.handId}`;
  $('#table-stakes').textContent = !tour ? `блайнды ${fmt(t.sb)}/${fmt(t.bb)} · ${stage}`
    : tour.status === 'registering' ? `сит-н-гоу · регистрация · взнос ${fmt(tour.buyIn)}`
      : tour.status === 'finished' ? 'сит-н-гоу · турнир завершён'
        : `уровень ${tour.level} · блайнды ${fmt(t.sb)}/${fmt(t.bb)} · ${stage}`;
  // Часы уровня тикают сами между кадрами — см. tickTimer.
  state.levelDeadline = tour && tour.status === 'running' && tour.next
    ? performance.now() + tour.levelLeft : 0;
  state.levelNext = tour && tour.next;
  $('#tour-clock').hidden = !state.levelDeadline;

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
  // Прячем содержимое, но не сам блок: место под него зарезервировано,
  // иначе борд и фишки поедут, как только появится банк.
  pot.style.visibility = !t.pot || t.pot === onTable ? 'hidden' : 'visible';
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
  } else if (t.phase === 'idle' && tour && tour.status !== 'running') {
    tourMessage(msg, t);
  } else if (t.phase === 'idle') {
    const seated = t.seats.filter((s) => !s.empty && (tour || !s.sittingOut)).length;
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
      // В идущий турнир не садятся: свободные места — это вылетевшие.
      const closed = !!(tour && tour.status !== 'registering');
      const btn = el('button', 'seat__empty', t.you || closed ? `Место ${i + 1}` : `Сесть на ${i + 1}`);
      btn.disabled = !!t.you || closed;
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
    const name = el('span', `seat__name${seat.isBot ? '' : ' is-link'}`, seat.name + (seat.isBot ? ' •' : ''));
    if (!seat.isBot) {
      name.title = 'Открыть профиль';
      name.addEventListener('click', () => openProfile(seat.name));
    }
    plate.append(name);
    plate.append(el('span', 'seat__stack', fmt(seat.stack)));
    if (seat.mucked) node.classList.add('seat--mucked');
    if (seat.revealing) node.classList.add('seat--revealing');
    const note = seat.mucked ? 'карты в сброс'
      : seat.revealing && !seat.handName ? 'вскрывается…'
        : seat.allIn ? 'олл-ин'
          : seat.sittingOut ? (seat.stack === 0 ? 'без фишек' : 'пропускает')
            : seat.handName || labelAction(seat.lastAction);
    // Строка заметки стоит всегда, даже пустая: иначе плашка меняет высоту,
    // а вместе с ней прыгает и место под ставку.
    const noteEl = el('span', `seat__note${seat.handName ? ' seat__note--hand' : ''}`, note || '');
    if (note) noteEl.title = note;
    plate.append(noteEl);
    node.append(plate);

    const timer = el('div', 'seat__timer');
    const fill = el('i');
    fill.style.width = t.actingSeat === i ? '100%' : '0%';
    timer.append(fill);
    node.append(timer);
    if (t.actingSeat === i) node.dataset.timer = '1';


    if (t.buttonSeat === i && t.phase !== 'idle') node.append(el('div', 'seat__badge', 'D'));
    if (seat.won > 0 && t.phase === 'showdown') node.append(el('div', 'seat__win', `+${fmt(seat.won)}`));

    if (seat.isBot && t.you && (!tour || tour.status === 'registering')) {
      const kick = el('button', 'seat__kick');
      kick.title = 'Убрать бота';
      kick.setAttribute('aria-label', `Убрать бота ${seat.name}`);
      kick.addEventListener('click', () => cmd({ cmd: 'kickBot', seat: i }));
      node.append(kick);
    }

    seatsBox.append(node);
  });

  // Силомер рисуем до фишек: он занимает угол сукна, и фишки должны его обойти.
  renderMeter(t);
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

  checkPre(t);
  renderMenu(t);
  renderActions(t);

  const snap = snapshot(t);
  playEffects(t, prev, positions);
  state.snap = snap;
}

// Что пишет сукно турнирного стола, пока карт нет: регистрация или итоги.
function tourMessage(msg, t) {
  const tour = t.tour;
  if (tour.status === 'registering') {
    const taken = t.seats.filter((s) => !s.empty).length;
    msg.append(el('span', null, `Регистрация ${taken} из ${t.maxSeats} · фонд `));
    msg.append(el('b', null, fmt(tour.pool)));
    msg.append(el('span', null, ` · призы ${tour.prizes.map(fmt).join(' / ')}`));
    return;
  }
  msg.classList.add('is-win');
  msg.append(el('span', null, 'Турнир завершён: '));
  tour.places.filter((p) => p.prize > 0).forEach((p, i) => {
    if (i) msg.append(el('span', null, ' · '));
    msg.append(el('span', null, `${p.place}. ${p.name} `));
    msg.append(el('b', null, fmt(p.prize)));
  });
}

// Какое место занял игрок, если он уже вылетел из турнира.
function myPlace(t) {
  if (!t.tour || !state.user) return null;
  return t.tour.places.find((p) => p.name === state.user.name && !p.isBot) || null;
}

// Поставленные фишки лежат на сукне между местом и банком — своим кольцом,
// поэтому они не наезжают на плашки с именами.
// Место для ставки постоянное и привязано к самому игроку: плашка стоит
// вплотную к его блоку со стороны банка. Если стол низкий и полоса между
// местом и центром узкая, плашка встаёт ровно посередине этой полосы.
// Вся геометрия устойчива, поэтому фишки не ездят от кадра к кадру.
const BET_GAP = 10;

function centerBox(feltBox) {
  const box = { top: Infinity, bottom: -Infinity, left: Infinity, right: -Infinity };
  for (const sel of ['#pots', '#pot', '#board', '#felt-msg']) {
    const node = $(sel);
    if (!node) continue;
    const r = node.getBoundingClientRect();
    if (!r.height) continue;
    box.top = Math.min(box.top, r.top - feltBox.top);
    box.bottom = Math.max(box.bottom, r.bottom - feltBox.top);
    box.left = Math.min(box.left, r.left - feltBox.left);
    box.right = Math.max(box.right, r.right - feltBox.left);
  }
  if (box.top === Infinity) {
    return {
      top: feltBox.height * 0.38, bottom: feltBox.height * 0.62,
      left: feltBox.width * 0.32, right: feltBox.width * 0.68,
    };
  }
  return box;
}

function betSpot(seatBox, core, feltBox, half) {
  const x = (seatBox.left + seatBox.right) / 2;
  const y = (seatBox.top + seatBox.bottom) / 2;
  const dx = feltBox.width / 2 - x;
  const dy = feltBox.height / 2 - y;

  // Сверху и снизу от банка двигаемся по вертикали, сбоку — по горизонтали.
  const vertical = Math.abs(dy) * feltBox.width > Math.abs(dx) * feltBox.height;
  if (vertical) {
    const [near, far] = dy > 0
      ? [seatBox.bottom + BET_GAP + half.h, core.top - BET_GAP - half.h]
      : [seatBox.top - BET_GAP - half.h, core.bottom + BET_GAP + half.h];
    if (dy > 0 ? near <= far : near >= far) return { x, y: near };
  } else {
    const [near, far] = dx > 0
      ? [seatBox.right + BET_GAP + half.w, core.left - BET_GAP - half.w]
      : [seatBox.left - BET_GAP - half.w, core.right + BET_GAP + half.w];
    if (dx > 0 ? near <= far : near >= far) return { x: near, y };
  }

  // Между местом и центром не осталось полосы — на тесном экране такое бывает.
  // Тогда кладём сбоку от места, с той стороны, где до борта дальше.
  const toLeft = seatBox.left > feltBox.width - seatBox.right;
  return {
    x: toLeft ? seatBox.left - BET_GAP - half.w : seatBox.right + BET_GAP + half.w,
    y,
  };
}

function renderBets(t, hero) {
  const box = $('#bets');
  const prev = state.snap;
  box.textContent = '';

  const feltBox = $('#felt').getBoundingClientRect();
  const core = centerBox(feltBox);
  const seatNodes = $('#seats').children;
  const placed = new Map();
  const nodes = [];

  t.seats.forEach((seat, i) => {
    if (seat.empty || !seat.bet || !seatNodes[i]) return;
    const was = prev && prev.seats[i] ? prev.seats[i].bet : 0;
    const bet = el('div', `bet${seat.bet !== was ? ' is-new' : ''}`);
    // Плашка низкая: одна фишка старшего номинала и сумма рядом. Высокая стопка
    // не помещалась в полосу между бортом и картами на невысоком экране.
    bet.append(el('div', `chip chip--${topChip(seat.bet)}`));
    bet.append(el('span', 'bet__value', fmt(seat.bet)));
    bet.title = `${seat.name}: ${fmt(seat.bet)}`;
    box.append(bet);
    nodes.push({ i, bet });
  });
  if (!nodes.length) { state.betSpots = placed; return; }

  // Размер берём по вёрстке, а не по экранному прямоугольнику: на первом кадре
  // ставка появляется с анимацией масштаба, и измеренный размер был бы меньше
  // настоящего — фишки вставали бы ближе к месту, а потом прыгали.
  const sample = nodes[0].bet;
  const half = { w: sample.offsetWidth / 2, h: sample.offsetHeight / 2 };

  for (const { i, bet } of nodes) {
    const r = seatNodes[i].getBoundingClientRect();
    const seatBox = {
      left: r.left - feltBox.left, right: r.right - feltBox.left,
      top: r.top - feltBox.top, bottom: r.bottom - feltBox.top,
    };
    const spot = betSpot(seatBox, core, feltBox, half);
    const x = (spot.x / feltBox.width) * 100;
    const y = (spot.y / feltBox.height) * 100;
    bet.style.setProperty('--x', `${x}%`);
    bet.style.setProperty('--y', `${y}%`);
    placed.set(i, { x, y });
  }
  state.betSpots = placed;
}

// Самый крупный номинал, который помещается в ставку, — его и рисуем.
function topChip(amount) {
  for (const value of CHIP_VALUES) if (amount >= value) return value;
  return 1;
}

// Банк на столе: основной и побочные — каждый своей стопкой фишек.
function renderPots(t) {
  const box = $('#pots');
  const parts = t.pots || [];
  box.textContent = '';
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
  if (!meterOn() || !hand || hand.strength === null) {
    box.hidden = true;
    state.combo = '';
    return;
  }
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
      const who = el('b', 'log__who is-link', line.text.slice(0, split));
      who.title = 'Открыть профиль';
      who.addEventListener('click', () => openProfile(who.textContent));
      node.append(who);
      node.append(document.createTextNode(line.text.slice(split + 1)));
    } else node.textContent = line.text;
    return node;
  }

  // «Марго выигрывает 520 — Каре тузов · A♦ A♣ A♥ A♠ 10♣»: комбинация важнее суммы,
  // а карты рисуются иконками.
  const dash = line.text.indexOf(' — ');
  if (kind === 'result' && dash > 0) {
    node.append(document.createTextNode(line.text.slice(0, dash + 3)));
    const tail = line.text.slice(dash + 3);
    const split = tail.indexOf(' · ');
    if (split > 0) {
      // Название комбинации остаётся в строке, а карты уходят отдельным рядом:
      // иначе пятёрка рвётся посреди комбинации и лента выглядит рвано.
      node.append(el('b', 'log__combo', tail.slice(0, split)));
      const cards = el('div', 'log__cards');
      cards.append(withCards(tail.slice(split + 3)));
      node.append(cards);
    } else {
      node.append(el('b', 'log__combo', tail));
    }
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
    const spots = state.betSpots || new Map();
    prev.seats.forEach((s, i) => {
      const from = spots.get(i);
      if (s && s.bet > 0 && from) flyChips(from, target, { count: 2 });
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
  const yourTurn = reveal || !!(t && t.you && t.you.legal);
  const bar = $('#turnbar').firstElementChild;
  bar.style.width = yourTurn ? `${share * 100}%` : '0%';
  bar.classList.toggle('is-low', yourTurn && share < 0.25);

  if (state.levelDeadline) {
    const ms = Math.max(0, state.levelDeadline - performance.now());
    const sec = Math.ceil(ms / 1000);
    const next = state.levelNext ? ` → ${fmt(state.levelNext.sb)}/${fmt(state.levelNext.bb)}` : '';
    const text = ms > 0 ? `рост через ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}${next}`
      : `со следующей раздачи${next}`;
    const clock = $('#tour-clock');
    if (clock.textContent !== text) clock.textContent = text;
  }

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
  const btn = el('button', `btn btn--act btn--pre${armed ? ' is-armed' : ''}`, label);
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

// Решение, которое сейчас принимает игрок: панель рейза открыта только на нём.
function turnKey(t) {
  return `${t.handId}:${t.phase}:${t.actingSeat}`;
}

// Открыть ползунок рейза. Он всегда начинается с минимального повышения:
// размер прошлой ставки к новому решению отношения не имеет.
function openRaise(t) {
  const legal = t.you && t.you.legal;
  if (!legal || legal.minRaiseTo === undefined) return;
  state.raiseOpen = turnKey(t);
  state.raiseValue = legal.minRaiseTo;
  state.actionKey = '';
  Sound.play('click');
  renderActions(t);
}

function closeRaise() {
  if (!state.raiseOpen) return;
  state.raiseOpen = null;
  state.actionKey = '';
  if (state.table) renderActions(state.table);
}

function sendRaise(t, amount) {
  const legal = t.you && t.you.legal;
  if (!legal || legal.minRaiseTo === undefined) return;
  cmd({ cmd: 'act', action: legal.isBet ? 'bet' : 'raise', amount });
  state.raiseOpen = null;
  state.raiseValue = 0;
}

function renderActions(t) {
  const box = $('#actions');
  const you = t.you;
  const legal = you && you.legal;
  const mySeat = you && t.seats[you.seat] && !t.seats[you.seat].empty ? t.seats[you.seat] : null;
  box.classList.toggle('is-your-turn', !!legal || !!(you && you.canReveal));

  if (state.raiseOpen && (!legal || state.raiseOpen !== turnKey(t))) state.raiseOpen = null;
  const raiseOpen = !!state.raiseOpen;

  const pre = state.pre ? `${state.pre.action}:${state.pre.amount}` : '';
  const key = JSON.stringify([t.handId, t.phase, t.actingSeat, legal, you && you.stack, you && you.sittingOut,
    you && you.inHand, !!you, you && you.canReveal, t.reveal && t.reveal.seat, pre, callAmount(t),
    mySeat && mySeat.folded, mySeat && mySeat.allIn, raiseOpen]);
  if (key === state.actionKey) return;
  state.actionKey = key;
  box.textContent = '';
  state.setRaise = null; // панель перестроена — старый шаг ставки больше не годится

  const status = el('div', 'actions__status');
  const acts = el('div', 'acts');
  const size = el('div', 'acts__size');
  const main = el('div', 'acts__main');
  acts.append(size, main);
  box.append(status, acts);
  box.classList.toggle('is-raising', raiseOpen);

  const place = !you && myPlace(t);
  if (place) {
    status.textContent = `Вы заняли ${place.place} место${place.prize ? ` — приз ${fmt(place.prize)} уже в банке` : ''}`;
    main.append(deadButton('Фолд'), deadButton('Чек'), deadButton('Рейз'));
    return;
  }
  if (!you) {
    status.textContent = t.tour && t.tour.status === 'registering'
      ? 'Займите свободное место, чтобы записаться на турнир'
      : 'Вы наблюдаете за столом. Займите свободное место, чтобы играть';
    main.append(deadButton('Фолд'), deadButton('Чек'), deadButton('Рейз'));
    return;
  }

  // Очередь решать, показывать ли карты.
  if (you.canReveal) {
    status.textContent = 'Показать карты соперникам?';
    const show = el('button', 'btn btn--primary btn--act', 'Показать');
    show.addEventListener('click', () => cmd({ cmd: 'reveal', show: true }));
    const hide = el('button', 'btn btn--act', 'Убрать в сброс');
    hide.addEventListener('click', () => cmd({ cmd: 'reveal', show: false }));
    main.append(show, hide);
    return;
  }

  if (legal) {
    status.textContent = 'Ваш ход';

    const fold = el('button', 'btn btn--danger btn--act', 'Фолд');
    fold.addEventListener('click', () => cmd({ cmd: 'act', action: 'fold' }));
    main.append(hotkey(fold, 'F'));

    if (legal.check) {
      const check = el('button', 'btn btn--call btn--act', 'Чек');
      check.addEventListener('click', () => cmd({ cmd: 'act', action: 'check' }));
      main.append(hotkey(check, 'C'));
    } else {
      const call = el('button', 'btn btn--call btn--act', `Колл ${fmt(legal.toCall)}`);
      call.addEventListener('click', () => cmd({ cmd: 'act', action: 'call' }));
      main.append(hotkey(call, 'C'));
    }

    const word = legal.isBet ? 'Бет' : 'Рейз';
    if (legal.minRaiseTo === undefined) {
      main.append(deadButton(word));
    } else if (legal.minRaiseTo >= legal.maxRaiseTo) {
      // Повысить можно только на весь стек — выбирать размер незачем.
      const allIn = el('button', 'btn btn--primary btn--act', `Олл-ин ${fmt(legal.maxRaiseTo)}`);
      allIn.addEventListener('click', () => sendRaise(t, legal.maxRaiseTo));
      main.append(hotkey(allIn, 'R'));
    } else if (raiseOpen) {
      const sizing = raiseBox(t, legal);
      size.append(sizing.size);
      main.append(sizing.submit);
    } else {
      const open = el('button', 'btn btn--primary btn--act', `${word}…`);
      open.title = 'Выбрать размер ставки';
      open.addEventListener('click', () => openRaise(t));
      main.append(hotkey(open, 'R'));
    }
    return;
  }

  const acting = t.actingSeat >= 0 && t.seats[t.actingSeat] && !t.seats[t.actingSeat].empty
    ? `Ход: ${t.seats[t.actingSeat].name}`
    : t.phase === 'showdown' ? 'Вскрытие' : idleStatus(t);

  // Заранее ходит только тот, кому ещё предстоит решать: пас и олл-ин
  // выбирать нечего.
  const folded = !!(mySeat && (mySeat.folded || mySeat.mucked));
  const allIn = !!(mySeat && mySeat.allIn);
  const canPre = you.inHand && !folded && !allIn && !you.sittingOut
    && t.phase !== 'showdown' && t.actingSeat >= 0;

  if (!canPre) {
    if (state.pre) state.pre = null;
    // В турнире отошедший сидит в раздачах, но ходов не делает: кнопки заблокированы,
    // а вернуться можно прямо отсюда.
    if (you.sittingOut && t.tour && t.tour.status === 'running') {
      status.textContent = 'Вы пропускаете раздачи: блайнды списываются, карты сбрасываются';
      const back = el('button', 'btn btn--sm actions__back', 'Вернуться в игру');
      back.addEventListener('click', () => cmd({ cmd: 'sitOut', value: false }));
      status.append(back);
      main.append(deadButton('Фолд'), deadButton('Чек'), deadButton('Рейз'));
      return;
    }
    status.textContent = folded ? `${acting} · вы сбросили карты`
      : allIn ? `${acting} · вы в олл-ине`
        : acting;
    main.append(deadButton('Фолд'), deadButton('Чек'), deadButton('Рейз'));
    return;
  }

  const toCall = callAmount(t);
  const armed = state.pre
    ? (state.pre.action === 'fold' ? 'фолд' : state.pre.action === 'check' ? 'чек' : `колл ${fmt(state.pre.amount)}`)
    : '';
  status.textContent = armed ? `${acting} · заранее выбрано: ${armed}` : `${acting} · можно выбрать ход заранее`;

  main.append(preButton('Фолд', 'fold', 0, 'Сбросить карты, как только дойдёт очередь'));
  main.append(toCall > 0
    ? preButton(`Колл ${fmt(toCall)}`, 'call', toCall, 'Уравнять, если ставка не изменится')
    : preButton('Чек', 'check', 0, 'Чекнуть, если никто не поставит'));
  main.append(deadButton(t.currentBet > 0 ? 'Рейз' : 'Бет'));
}

// Чего ждёт стол между раздачами.
function idleStatus(t) {
  const tour = t.tour;
  if (tour && tour.status === 'registering') {
    const taken = t.seats.filter((s) => !s.empty).length;
    return `Регистрация: ${taken} из ${t.maxSeats}. Турнир начнётся, когда займут все места`;
  }
  if (tour && tour.status === 'finished') return 'Турнир завершён';
  return 'Ждём начала раздачи';
}

// Кнопка-заглушка: держит строй, пока ходить нельзя.
function deadButton(label) {
  const btn = el('button', 'btn btn--act', label);
  btn.disabled = true;
  return btn;
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

  const tour = t.tour;
  const topup = $('#menu-topup');
  topup.hidden = !!tour || !(seated && !you.inHand && you.stack < t.maxBuyIn);

  const sitOut = $('#menu-sitout');
  sitOut.hidden = !seated;
  sitOut.textContent = seated && you.sittingOut ? 'Вернуться в игру' : 'Пропустить раздачи';

  const bot = $('#menu-bot');
  const botClosed = !!(tour && tour.status !== 'registering');
  bot.hidden = botClosed;
  bot.disabled = !free;
  bot.title = free ? '' : 'Свободных мест нет';

  const stand = $('#menu-stand');
  stand.hidden = !seated || botClosed;
  stand.textContent = tour ? 'Отменить регистрацию' : 'Встать из-за стола';
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

// Размер ставки: доли банка, шаг в блайнд и ползунок. Панель открывается
// по кнопке рейза и висит над ней; сама кнопка остаётся в общем ряду
// с фолдом и коллом и теперь отправляет выбранную сумму.
function raiseBox(t, legal) {
  const { minRaiseTo: min, maxRaiseTo: max, toCall, pot, isBet } = legal;

  const size = el('div', 'raise');
  state.raiseValue = clamp(state.raiseValue || min, min, max);

  const head = el('div', 'raise__head');
  head.append(el('span', 'raise__title', isBet ? 'Размер бета' : 'Рейз до'));
  const close = el('button', 'raise__close');
  close.type = 'button';
  close.title = 'Скрыть (Esc)';
  close.setAttribute('aria-label', 'Скрыть выбор ставки');
  close.addEventListener('click', closeRaise);
  head.append(close);

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

  const submit = el('button', 'btn btn--primary btn--act raise__go');

  const step = Math.max(1, t.bb);
  const paint = () => {
    const v = state.raiseValue;
    slider.value = v;
    amount.textContent = fmt(v);
    const share = pot > 0 ? Math.round(((v - toCall) / pot) * 100) : 0;
    hint.textContent = v >= max
      ? `олл-ин · ${(v / t.bb).toFixed(1)} bb`
      : `${(v / t.bb).toFixed(1)} bb · ${share}% банка`;
    minus.disabled = v <= min;
    plus.disabled = v >= max;
    submit.textContent = v >= max ? `Олл-ин ${fmt(v)}` : `${isBet ? 'Бет' : 'Рейз'} ${fmt(v)}`;
    hotkey(submit, 'R');
    size.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`);
  };

  const setValue = (v, snap = false) => {
    let next = clamp(Math.round(v), min, max);
    if (snap && next > min && next < max) next = clamp(min + Math.round((next - min) / step) * step, min, max);
    state.raiseValue = next;
    paint();
  };

  state.setRaise = (delta) => setValue(state.raiseValue + delta * step, true);
  holdRepeat(minus, () => state.setRaise(-1));
  holdRepeat(plus, () => state.setRaise(1));
  slider.addEventListener('input', () => setValue(Number(slider.value)));

  const seen = new Set();
  for (const [label, target, title] of [
    ['Мин', min, 'Минимальное повышение'],
    ['½', Math.round(toCall + pot * 0.5), 'Половина банка'],
    ['¾', Math.round(toCall + pot * 0.75), 'Три четверти банка'],
    ['Банк', Math.round(toCall + pot), 'Размер банка'],
    ['Олл-ин', max, 'Весь стек'],
  ]) {
    const value = clamp(target, min, max);
    if (seen.has(value) && label !== 'Олл-ин') continue;
    seen.add(value);
    const b = el('button', 'raise__preset', label);
    b.type = 'button';
    b.title = `${title}: ${fmt(value)}`;
    b.addEventListener('click', () => { setValue(value); Sound.play('click'); });
    presets.append(b);
  }

  submit.addEventListener('click', () => sendRaise(t, state.raiseValue));

  const dial = el('div', 'raise__dial');
  const value = el('div', 'raise__value');
  value.append(amount, hint);
  dial.append(minus, value, plus);

  size.append(head, presets, dial, slider);
  paint();
  // Ползунок сразу под пальцем: стрелки и перетаскивание работают без лишнего клика.
  requestAnimationFrame(() => slider.focus({ preventScroll: true }));
  return { size, submit };
}

// ——— закупка ———

const dialog = $('#buyin-dialog');
let pendingSeat = null;

function openBuyIn(seat, t) {
  pendingSeat = seat;
  const tour = t.tour;
  $('#buyin-range').hidden = !!tour;
  if (tour) {
    if (state.user.chips < tour.buyIn) {
      toast(`Для турнира нужно ${fmt(tour.buyIn)} фишек в банке`);
      return;
    }
    $('#buyin-title').textContent = 'Регистрация на турнир';
    $('#buyin-note').textContent = `Место ${seat + 1}. Взнос списывается из банка, играете турнирным стеком `
      + `${fmt(tour.stack)}. Призы: ${tour.prizes.map((p, i) => `${i + 1} место — ${fmt(p)}`).join(', ')}. `
      + 'До старта регистрацию можно отменить.';
    $('#buyin-value').textContent = fmt(tour.buyIn);
    $('#buyin-ok').textContent = 'Заплатить взнос';
    dialog.showModal();
    Sound.play('click');
    return;
  }
  $('#buyin-title').textContent = 'Сесть за стол';
  $('#buyin-ok').textContent = 'Сесть';
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
  // Ползунок рейза — тоже поле ввода, но горячие клавиши стола на нём должны работать.
  const typing = e.target.tagName === 'INPUT' && !e.target.classList.contains('raise__slider');
  if (state.view !== 'table' || typing) return;
  if (e.key === 'm' || e.key === 'ь') {
    Sound.setEnabled(!Sound.isEnabled());
    paintSoundButtons();
    return;
  }
  const t = state.table;
  const you = t && t.you;
  const legal = you && you.legal;

  // Вне своего хода те же клавиши выбирают ход заранее.
  if (!legal) {
    if (!you || !you.inHand || t.actingSeat < 0 || t.phase === 'showdown') return;
    const toCall = callAmount(t);
    let action = null;
    if (e.key === 'f' || e.key === 'а') action = 'fold';
    if (e.key === 'c' || e.key === 'с') action = toCall > 0 ? 'call' : 'check';
    if (!action) return;
    const same = state.pre && state.pre.action === action;
    state.pre = same ? null : { action, amount: action === 'call' ? toCall : 0, handId: t.handId };
    Sound.play('click');
    state.actionKey = '';
    renderActions(t);
    return;
  }

  if (e.key === 'f' || e.key === 'а') cmd({ cmd: 'act', action: 'fold' });
  if (e.key === 'c' || e.key === 'с') cmd({ cmd: 'act', action: legal.check ? 'check' : 'call' });
  if (legal.minRaiseTo === undefined) return;
  const flat = legal.minRaiseTo >= legal.maxRaiseTo;
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    if (flat) return;
    if (!state.raiseOpen) openRaise(t);
    if (state.setRaise) state.setRaise((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 5 : 1));
    return;
  }
  if (e.key === 'Escape') { closeRaise(); return; }
  // Первое нажатие R открывает ползунок, второе — ставит выбранное.
  if (e.key === 'r' || e.key === 'к') {
    if (flat) sendRaise(t, legal.maxRaiseTo);
    else if (state.raiseOpen) sendRaise(t, state.raiseValue);
    else openRaise(t);
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
