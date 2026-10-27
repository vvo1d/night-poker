'use strict';
// Админ-панель THPoker. Данные — с /api/admin/*, доступ проверяет сервер.

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const fmt = (n) => Number(n || 0).toLocaleString('ru-RU');
const pct = (v) => (v === null || v === undefined ? '—' : `${String(v).replace('.', ',')}%`);
const dayLabel = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
const DATE = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
const DATETIME = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

let toastTimer = null;
function toast(text, good = false) {
  const node = $('#toast');
  node.textContent = text;
  node.hidden = false;
  node.classList.toggle('toast--good', good);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
}

async function api(url, body) {
  const res = await fetch(url, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) {
    $('#denied').hidden = false;
    document.querySelectorAll('main > section').forEach((s) => { s.hidden = true; });
    throw new Error('denied');
  }
  if (!res.ok) { toast(data.error || 'Ошибка запроса'); throw new Error(data.error); }
  return data;
}

// ——— вкладки ———

const loaders = {};
let tab = 'overview';
function showTab(name) {
  tab = name;
  document.querySelectorAll('#tabs .pages__tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === name));
  document.querySelectorAll('main > section[id^="tab-"]').forEach((s) => { s.hidden = s.id !== `tab-${name}`; });
  if (loaders[name]) loaders[name]();
}
document.querySelectorAll('#tabs .pages__tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ——— график: один ряд, столбики по дням ———
// Один ряд — без легенды, название говорит само за себя. Подсказка по наведению,
// под графиком — те же числа таблицей.

const tip = $('#tip');
function showTip(e, text) {
  tip.textContent = text;
  tip.hidden = false;
  const x = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 12);
  tip.style.left = `${x}px`;
  tip.style.top = `${e.clientY - tip.offsetHeight - 10}px`;
}
function hideTip() { tip.hidden = true; }

function barChart(box, title, series, key, unit) {
  box.textContent = '';
  const values = series.map((p) => p[key]);
  const max = Math.max(1, ...values);
  const total = values.reduce((a, b) => a + b, 0);
  // Рисуем в настоящих пикселях: иначе подписи осей сжимаются вместе с картинкой.
  const W = Math.max(260, Math.round(box.clientWidth - 32));
  const H = 150;
  const top = 10;
  const step = W / series.length;
  const gap = 2;
  const bw = Math.max(2, step - gap);

  const cap = el('figcaption', 'chart__cap');
  cap.append(el('b', null, title));
  cap.append(el('span', null, `за 30 дней ${fmt(total)} · сегодня ${fmt(values[values.length - 1])}`));
  box.append(cap);

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H + 18}`);
  svg.setAttribute('class', 'chart__svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${title}: за 30 дней ${total}`);

  // Сетка: базовая линия и половина максимума — бледно, чтобы не спорить с данными.
  for (const frac of [0, 0.5, 1]) {
    const y = top + (H - top) * (1 - frac);
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', 0); line.setAttribute('x2', W);
    line.setAttribute('y1', y); line.setAttribute('y2', y);
    line.setAttribute('class', frac === 0 ? 'chart__base' : 'chart__grid');
    svg.append(line);
    // Подпись середины — только когда она отличается от верхней.
    if (frac === 1 || (frac === 0.5 && max >= 2)) {
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', 2); t.setAttribute('y', y - 3);
      t.setAttribute('class', 'chart__axis');
      t.textContent = fmt(Math.round(max * frac));
      svg.append(t);
    }
  }

  series.forEach((p, i) => {
    const v = p[key];
    const h = v ? Math.max(3, ((H - top) * v) / max) : 0;
    const x = i * step + gap / 2;
    const y = H - h;
    if (h > 0) {
      // Столбик со скруглённой верхушкой и прямым основанием.
      const r = Math.min(4, bw / 2, h);
      const bar = document.createElementNS(NS, 'path');
      bar.setAttribute('d', `M${x},${H} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${H} Z`);
      bar.setAttribute('class', `chart__bar${i === series.length - 1 ? ' is-today' : ''}`);
      svg.append(bar);
    }
    // Зона наведения шире и выше столбика.
    const hit = document.createElementNS(NS, 'rect');
    hit.setAttribute('x', i * step); hit.setAttribute('y', 0);
    hit.setAttribute('width', step); hit.setAttribute('height', H);
    hit.setAttribute('class', 'chart__hit');
    hit.addEventListener('pointermove', (e) => showTip(e, `${dayLabel(p.day)}: ${fmt(v)} ${unit}`));
    hit.addEventListener('pointerleave', hideTip);
    svg.append(hit);
    if (i === 0 || i === series.length - 1 || i === Math.floor(series.length / 2)) {
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', i * step + step / 2); t.setAttribute('y', H + 14);
      t.setAttribute('text-anchor', i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle');
      t.setAttribute('class', 'chart__axis');
      t.textContent = dayLabel(p.day);
      svg.append(t);
    }
  });
  box.append(svg);

  const details = el('details', 'chart__table');
  details.append(el('summary', null, 'Таблицей'));
  const tbl = el('table', 'tbl tbl--mini');
  for (const p of series.slice().reverse()) {
    const tr = el('tr');
    tr.append(el('td', null, dayLabel(p.day)), el('td', 'num', fmt(p[key])));
    tbl.append(tr);
  }
  details.append(tbl);
  box.append(details);
}

// ——— обзор ———

function tile(value, label, note = '') {
  const t = el('div', 'tile');
  t.append(el('b', 'tile__value', value), el('span', 'tile__label', label));
  if (note) t.append(el('span', 'tile__note', note));
  return t;
}

function table(box, head, rows) {
  box.textContent = '';
  const tr = el('tr');
  head.forEach((h, i) => tr.append(el('th', i ? 'num' : '', h)));
  box.append(tr);
  for (const r of rows) {
    const row = el('tr');
    r.forEach((c, i) => row.append(el('td', i ? 'num' : '', c)));
    box.append(row);
  }
  if (!rows.length) {
    const row = el('tr');
    const td = el('td', 'muted', 'Пока нет данных');
    td.colSpan = head.length;
    row.append(td);
    box.append(row);
  }
}

loaders.overview = async () => {
  const d = await api('/api/admin/overview');
  const t = d.totals;
  const tiles = $('#tiles');
  tiles.textContent = '';
  tiles.append(
    tile(fmt(t.online), 'сейчас онлайн', `за столами: ${fmt(d.server.seated)}`),
    tile(fmt(t.activeToday), 'заходили сегодня', `за 7 дней: ${fmt(t.active7)}`),
    tile(fmt(t.registeredToday), 'новых сегодня', `за 7 дней: ${fmt(t.registered7)}`),
    tile(fmt(t.users), 'всего игроков'),
    tile(fmt(t.handsToday), 'раздач сегодня', 'с последнего запуска сервера'),
  );
  barChart($('#chart-registered'), 'Регистрации', d.series, 'registered', 'регистраций');
  barChart($('#chart-active'), 'Заходили в игру', d.series, 'active', 'игроков');
  barChart($('#chart-hands'), 'Раздачи', d.series, 'hands', 'раздач');

  // Воронка — горизонтальные полосы от числа регистраций.
  const f = d.funnel;
  const funnel = $('#funnel');
  funnel.textContent = '';
  const steps = [
    ['Зарегистрировались', f.registered, null],
    ['Сели за стол', f.sat, f.satPct],
    ['Сыграли 10+ раздач', f.played10, f.played10Pct],
    ['Вернулись на следующий день', f.returnedD1, f.returnedD1Pct],
  ];
  for (const [label, n, share] of steps) {
    const row = el('div', 'funnel__row');
    row.append(el('span', 'funnel__label', label));
    const bar = el('span', 'funnel__bar');
    const fill = el('i');
    fill.style.width = `${f.registered ? Math.max(1, (n / f.registered) * 100) : 0}%`;
    bar.append(fill);
    row.append(bar, el('b', 'funnel__value', `${fmt(n)}${share !== null ? ` · ${pct(share)}` : ''}`));
    funnel.append(row);
  }

  table($('#cohorts'), ['День', 'Новых', 'Назавтра', 'Через неделю'],
    d.cohorts.slice().reverse().map((c) => [dayLabel(c.day), fmt(c.n), c.n ? pct(c.d1) : '—', c.n ? pct(c.d7) : '—']));
  table($('#sources'), ['Источник', 'Игроков', 'Сели за стол', 'Вернулись'],
    d.sources.map((s) => [s.source, fmt(s.n), pct(s.satPct), pct(s.d1Pct)]));

  const s = d.server;
  const hours = Math.floor(s.uptimeSec / 3600);
  table($('#server'), ['Показатель', 'Значение'], [
    ['Работает без перезапуска', `${hours} ч ${Math.floor((s.uptimeSec % 3600) / 60)} мин`],
    ['Соединений', fmt(s.connections)],
    ['Столов открыто', fmt(s.tables)],
    ['Задержка цикла p99', `${s.lagMs.p99} мс`],
    ['Память', `${fmt(s.rssMb)} МБ`],
    ['Хранилище', s.storage],
  ]);
  $('#announce-text').value = d.announcement ? d.announcement.text : '';
};

// ——— игроки ———

let searchTimer = null;
$('#user-q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loaders.users, 250); });
$('#user-sort').addEventListener('change', () => loaders.users());

loaders.users = async () => {
  const q = encodeURIComponent($('#user-q').value.trim());
  const d = await api(`/api/admin/users?q=${q}&sort=${$('#user-sort').value}`);
  $('#user-count').textContent = d.total > 100 ? `показаны 100 из ${fmt(d.total)}` : `${fmt(d.total)}`;
  const box = $('#users');
  box.textContent = '';
  const head = el('tr');
  ['Игрок', 'Фишки', 'Раздач', 'Сезон', 'Заходил', 'Источник'].forEach((h, i) => head.append(el('th', i ? 'num' : '', h)));
  box.append(head);
  for (const u of d.users) {
    const tr = el('tr');
    const name = el('td');
    if (u.online) name.append(el('span', 'dot-online', ''));
    name.append(document.createTextNode(u.name));
    if (u.banned) name.append(el('span', 'badge badge--bad', 'бан'));
    if (u.telegram) name.append(el('span', 'badge', 'tg'));
    tr.append(name, el('td', 'num', fmt(u.chips)), el('td', 'num', fmt(u.hands)), el('td', 'num', fmt(u.season)),
      el('td', 'num', u.lastDay ? dayLabel(u.lastDay) : '—'), el('td', 'num', u.source || '—'));
    tr.addEventListener('click', () => openUser(u.name));
    box.append(tr);
  }
};

async function openUser(name) {
  const u = await api(`/api/admin/user?name=${encodeURIComponent(name)}`);
  renderUser(u);
}

function renderUser(u) {
  const card = $('#user-card');
  card.hidden = false;
  card.textContent = '';
  const head = el('div', 'user-card__head');
  if (u.avatar) {
    const img = el('img', 'user-card__avatar');
    img.src = u.avatar;
    img.alt = '';
    head.append(img);
  }
  head.append(el('h3', null, u.name));
  if (u.banned) head.append(el('span', 'badge badge--bad', 'заблокирован'));
  if (u.online) head.append(el('span', 'badge badge--ok', 'онлайн'));
  card.append(head);
  const info = el('dl', 'user-card__info');
  const add = (k, v) => { info.append(el('dt', null, k), el('dd', null, v)); };
  add('Фишки', fmt(u.chips));
  add('Раздач', fmt(u.hands));
  add('Выиграно', fmt(u.stats.handsWon));
  add('В игре с', DATE.format(new Date(u.createdAt)));
  add('Последний заход', u.lastDay ? dayLabel(u.lastDay) : '—');
  add('Дней в игре', fmt(u.days));
  add('Источник', u.source || '—');
  add('Telegram', u.telegram || '—');
  add('Вход по паролю', u.password ? 'да' : 'нет');
  add('За столом', u.table || '—');
  if (u.banInfo) add('Бан', `${u.banInfo.by}${u.banInfo.reason ? `: ${u.banInfo.reason}` : ''}`);
  card.append(info);

  const act = async (body, done) => {
    const res = await api('/api/admin/user', { name: u.name, ...body }).catch(() => null);
    if (!res) return;
    toast(done, true);
    renderUser(res.user);
    loaders.users();
  };

  // Фишки
  const chips = el('form', 'user-card__form');
  const amount = el('input'); amount.type = 'number'; amount.placeholder = '+1000 или -500';
  const reason = el('input'); reason.placeholder = 'Причина';
  const go = el('button', 'btn btn--sm', 'Изменить фишки'); go.type = 'submit';
  chips.append(amount, reason, go);
  chips.addEventListener('submit', (e) => {
    e.preventDefault();
    act({ action: 'chips', amount: Number(amount.value), reason: reason.value }, 'Фишки изменены');
  });
  card.append(el('h4', null, 'Фишки'), chips);

  // Пароль
  const pass = el('form', 'user-card__form');
  const pw = el('input'); pw.placeholder = 'Новый пароль'; pw.minLength = 6;
  const setPw = el('button', 'btn btn--sm', 'Задать пароль'); setPw.type = 'submit';
  pass.append(pw, setPw);
  pass.addEventListener('submit', (e) => {
    e.preventDefault();
    act({ action: 'password', password: pw.value }, 'Пароль задан — передайте его игроку');
  });
  card.append(el('h4', null, 'Пароль'), pass);

  // Бан и стол
  const row = el('div', 'user-card__row');
  if (u.table) {
    const kick = el('button', 'btn btn--sm', 'Убрать из-за стола');
    kick.addEventListener('click', () => act({ action: 'kick' }, 'Игрок убран из-за стола'));
    row.append(kick);
  }
  if (u.avatar) {
    const drop = el('button', 'btn btn--sm', 'Удалить аватар');
    drop.addEventListener('click', () => {
      if (confirm(`Удалить аватар игрока ${u.name}?`)) act({ action: 'avatar' }, 'Аватар удалён');
    });
    row.append(drop);
  }
  if (u.banned) {
    const unban = el('button', 'btn btn--sm', 'Разблокировать');
    unban.addEventListener('click', () => act({ action: 'unban' }, 'Разблокирован'));
    row.append(unban);
  } else {
    const ban = el('button', 'btn btn--sm btn--danger', 'Заблокировать');
    ban.addEventListener('click', () => {
      const why = prompt(`Заблокировать ${u.name}? Причина:`);
      if (why !== null) act({ action: 'ban', reason: why }, 'Заблокирован');
    });
    row.append(ban);
  }
  card.append(el('h4', null, 'Доступ'), row);

  if (u.log.length) {
    card.append(el('h4', null, 'История действий администраторов'));
    const log = el('ul', 'user-card__log');
    for (const l of u.log) log.append(el('li', null, `${DATETIME.format(new Date(l.at))} · ${l.by}: ${l.text}`));
    card.append(log);
  }
}

// ——— столы ———

const PHASE = { idle: 'ожидание', preflop: 'префлоп', flop: 'флоп', turn: 'тёрн', river: 'ривер', showdown: 'вскрытие' };
$('#tables-reload').addEventListener('click', () => loaders.tables());

loaders.tables = async () => {
  const d = await api('/api/admin/tables');
  $('#tables-count').textContent = `${fmt(d.tables.length)} столов`;
  const box = $('#tables');
  box.textContent = '';
  const head = el('tr');
  ['Стол', 'Тип', 'Блайнды', 'Игроки', 'Сейчас', ''].forEach((h) => head.append(el('th', null, h)));
  box.append(head);
  for (const t of d.tables) {
    const tr = el('tr');
    const name = el('td');
    name.append(document.createTextNode(t.name));
    if (t.private) name.append(el('span', 'badge', 'приватный'));
    if (t.house) name.append(el('span', 'badge', 'заведения'));
    const kind = { cash: 'кэш', sng: 'sit-n-go', mtt: 'турнир' }[t.kind];
    const players = t.players.length
      ? t.players.map((p) => `${p.name}${p.bot ? ' (бот)' : p.resident ? ' (резидент)' : ''} ${fmt(p.stack)}${p.away ? ' · отошёл' : ''}`).join(', ')
      : '—';
    const close = el('button', 'btn btn--sm btn--danger', 'Закрыть');
    close.addEventListener('click', async () => {
      if (!confirm(`Закрыть стол «${t.name}»? Фишки вернутся игрокам в банк.`)) return;
      await api('/api/admin/table', { id: t.id, action: 'close' }).catch(() => null);
      toast('Стол закрыт', true);
      loaders.tables();
    });
    const actions = el('td');
    actions.append(close);
    tr.append(name, el('td', null, kind), el('td', null, t.blinds), el('td', 'players', `${t.players.length}/${t.maxSeats}: ${players}`),
      el('td', null, t.status && t.status !== 'running' ? t.status : PHASE[t.phase]), actions);
    box.append(tr);
  }
};

// ——— объявление ———

$('#announce-save').addEventListener('click', async () => {
  const text = $('#announce-text').value.trim();
  const res = await api('/api/admin/announce', { text }).catch(() => null);
  if (res) toast(text ? 'Объявление опубликовано' : 'Объявление снято', true);
});

// ——— турниры по расписанию ———

const STATUS = { registering: 'регистрация', running: 'идёт', finished: 'завершён', cancelled: 'отменён' };

loaders.tournaments = async () => {
  const d = await api('/api/admin/mtt');
  const box = $('#mtt-admin');
  box.textContent = '';

  // Разовый турнир.
  const form = el('form', 'panel mtt-form');
  form.append(el('h3', null, 'Новый разовый турнир'));
  const row = el('div', 'adm__bar');
  const name = el('input', 'adm__search'); name.placeholder = 'Название'; name.maxLength = 40;
  const when = el('input', 'adm__search'); when.type = 'datetime-local';
  const soon = new Date(Date.now() + 30 * 60000 - new Date().getTimezoneOffset() * 60000);
  when.value = soon.toISOString().slice(0, 16);
  const buyIn = el('input', 'adm__search'); buyIn.type = 'number'; buyIn.min = 0; buyIn.placeholder = 'Взнос (0 — бесплатно)';
  const guarantee = el('input', 'adm__search'); guarantee.type = 'number'; guarantee.min = 0; guarantee.placeholder = 'Гарантия фонда';
  const go = el('button', 'btn btn--primary btn--sm', 'Создать'); go.type = 'submit';
  row.append(name, when, buyIn, guarantee, go);
  form.append(row, el('p', 'panel__note', 'Время — по часам вашего браузера. Ежедневные турниры (15:00 и 21:00 мск) создаются сами.'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await api('/api/admin/mtt', {
      action: 'create', name: name.value, startAt: new Date(when.value).getTime(),
      buyIn: Number(buyIn.value) || 0, guarantee: Number(guarantee.value) || 0,
    }).catch(() => null);
    if (res) { toast('Турнир создан', true); loaders.tournaments(); }
  });
  box.append(form);

  const list = el('table', 'tbl');
  const head = el('tr');
  ['Турнир', 'Старт', 'Статус', 'Игроков', 'Фонд', ''].forEach((h) => head.append(el('th', null, h)));
  list.append(head);
  for (const m of d.list) {
    const tr = el('tr');
    const actions = el('td', 'mtt-actions');
    const act = (label, action, extra = {}, danger = false) => {
      const b = el('button', `btn btn--sm${danger ? ' btn--danger' : ''}`, label);
      b.addEventListener('click', async () => {
        if (action === 'cancel' && !confirm(`Отменить «${m.name}»? До старта взносы вернутся, во время игры фонд поделится по стекам.`)) return;
        const res = await api('/api/admin/mtt', { action, id: m.id, ...extra }).catch(() => null);
        if (res) { toast('Готово', true); loaders.tournaments(); }
      });
      actions.append(b);
    };
    if (m.status === 'registering') {
      act('Старт сейчас', 'start');
      act('+5 ботов', 'bots', { count: 5 });
    }
    if (m.status === 'registering' || m.status === 'running') act('Отменить', 'cancel', {}, true);
    tr.append(
      el('td', null, `${m.name}${m.buyIn ? ` · взнос ${fmt(m.buyIn)}` : ' · бесплатно'}`),
      el('td', null, DATETIME.format(new Date(m.startAt))),
      el('td', null, STATUS[m.status] + (m.winner ? ` · ${m.winner}` : '') + (m.cancelReason ? ` · ${m.cancelReason}` : '')),
      el('td', 'num', m.status === 'running' ? `${fmt(m.alive)} из ${fmt(m.registered)}` : fmt(m.registered)),
      el('td', 'num', fmt(m.pool)),
      actions,
    );
    list.append(tr);
  }
  const wrap = el('section', 'panel');
  wrap.append(el('h3', null, 'Турниры'), list);
  box.append(wrap);
};

// ——— резиденты (живые боты) ———
// Форма строится по схеме с сервера: новое поле там — новое поле здесь, без правок.

const minutes = (ms) => `${Math.ceil(ms / 60000)} мин`;

function fieldInput(f, value, levels, levelNames) {
  const num = (v, min = f.min ?? 0, max = f.max ?? 100) => {
    const i = el('input', 'res-num');
    i.type = 'number';
    i.min = min;
    i.max = max;
    i.value = v;
    return i;
  };
  const wrap = el('div', `res-field res-field--${f.type}`);
  const label = el('label', 'res-field__label', f.label);
  if (f.hint) label.append(el('small', 'muted', f.hint));
  wrap.append(label);
  const box = el('div', 'res-field__input');
  let read;
  if (f.type === 'bool') {
    const i = el('input');
    i.type = 'checkbox';
    i.checked = !!value;
    box.append(i);
    read = () => i.checked;
  } else if (f.type === 'num' || f.type === 'pct') {
    const i = num(value, f.type === 'pct' ? 0 : f.min, f.type === 'pct' ? 100 : f.max);
    box.append(i);
    if (f.type === 'pct') box.append(el('span', 'muted', '%'));
    read = () => i.value;
  } else if (f.type === 'range') {
    const a = num(value[0]);
    const b = num(value[1]);
    box.append(el('span', 'muted', 'от'), a, el('span', 'muted', 'до'), b);
    read = () => [a.value, b.value];
  } else if (f.type === 'levels') {
    const inputs = {};
    for (const l of levels) {
      const cell = el('span', 'res-level');
      cell.append(el('small', 'muted', levelNames[l]), inputs[l] = num(value[l]));
      box.append(cell);
    }
    read = () => Object.fromEntries(levels.map((l) => [l, inputs[l].value]));
  }
  wrap.append(box);
  return { node: wrap, read };
}

loaders.residents = async () => {
  const d = await api('/api/admin/residents');
  const box = $('#res-admin');
  box.textContent = '';

  // Настройки поведения — по группам.
  const form = el('form', 'panel res-form');
  form.append(el('h3', null, 'Поведение'),
    el('p', 'panel__note', 'Применяется сразу, без перезапуска. Диапазон «от–до» — каждый раз берётся случайное значение внутри.'));
  const readers = {};
  const groups = new Map();
  for (const f of d.schema) {
    if (!groups.has(f.group)) {
      const g = el('fieldset', 'res-group');
      g.append(el('legend', null, f.group));
      groups.set(f.group, g);
      form.append(g);
    }
    const { node, read } = fieldInput(f, d.settings[f.key], d.levels, d.levelNames);
    groups.get(f.group).append(node);
    readers[f.key] = read;
  }
  const bar = el('div', 'adm__bar res-form__bar');
  const save = el('button', 'btn btn--primary btn--sm', 'Сохранить');
  save.type = 'submit';
  const reset = el('button', 'btn btn--ghost btn--sm', 'Вернуть по умолчанию');
  reset.type = 'button';
  reset.addEventListener('click', async () => {
    if (!confirm('Вернуть все настройки поведения к значениям по умолчанию?')) return;
    const res = await api('/api/admin/residents', { action: 'reset' }).catch(() => null);
    if (res) { toast('Настройки сброшены', true); loaders.residents(); }
  });
  bar.append(save, reset);
  form.append(bar);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const settings = Object.fromEntries(Object.entries(readers).map(([k, read]) => [k, read()]));
    const res = await api('/api/admin/residents', { action: 'settings', settings }).catch(() => null);
    if (!res) return;
    if (res.errors.length) toast(`Не сохранено: ${res.errors.join(', ')}`);
    else toast('Настройки сохранены', true);
    loaders.residents();
  });

  // Состав: ник, уровень, играет или нет.
  const roster = el('section', 'panel');
  roster.append(el('h3', null, `Состав · ${d.list.filter((r) => !r.off).length} из ${d.list.length} играют`),
    el('p', 'panel__note', 'Ник меняется у аккаунта сразу (если не занят живым игроком). Уровень — стиль игры. Банк и раздачи — как у обычного игрока: фишки можно добавить во вкладке «Игроки».'));
  const tbl = el('table', 'tbl res-roster');
  const head = el('tr');
  ['', 'Ник', 'Уровень', 'Играет', 'Банк', 'Раздач', 'Сейчас'].forEach((h) => head.append(el('th', null, h)));
  tbl.append(head);
  const rows = [];
  for (const r of d.list) {
    const tr = el('tr');
    const face = el('td');
    if (r.avatar) {
      const img = el('img', 'user-card__avatar');
      img.src = r.avatar;
      img.alt = '';
      face.append(img);
    }
    const name = el('input', 'res-name');
    name.value = r.name;
    name.maxLength = 20;
    name.placeholder = r.baseName;
    const style = el('select', 'adm__select');
    for (const l of d.levels) {
      const o = el('option', null, d.levelNames[l]);
      o.value = l;
      o.selected = l === r.style;
      style.append(o);
    }
    const on = el('input');
    on.type = 'checkbox';
    on.checked = !r.off;
    const now = r.conflict || r.nameTaken ? 'ник занят живым игроком'
      : r.table ? `за столом «${r.table}»`
        : r.mtt ? `записан: ${r.mtt}`
          : r.off ? 'выключен'
            : r.restLeft ? `отдыхает ещё ${minutes(r.restLeft)}` : 'свободен';
    const cell = (node) => { const td = el('td'); td.append(node); return td; };
    tr.append(face, cell(name), cell(style), cell(on), el('td', 'num', fmt(r.chips)), el('td', 'num', fmt(r.hands)), el('td', 'muted', now));
    tbl.append(tr);
    rows.push({ r, name, style, on });
  }
  const rosterBar = el('div', 'adm__bar');
  const saveRoster = el('button', 'btn btn--primary btn--sm', 'Сохранить состав');
  saveRoster.addEventListener('click', async () => {
    // В настройки уходят только отличия от исходного списка.
    const out = {};
    for (const { r, name, style, on } of rows) {
      const item = {};
      const n = name.value.trim();
      if (n && n !== r.baseName) item.name = n;
      if (style.value !== r.baseStyle) item.style = style.value;
      if (!on.checked) item.off = true;
      if (Object.keys(item).length) out[r.key] = item;
    }
    const res = await api('/api/admin/residents', { action: 'roster', roster: out }).catch(() => null);
    if (res) { toast('Состав сохранён', true); loaders.residents(); }
  });
  rosterBar.append(saveRoster);
  const scroll = el('div', 'res-scroll');
  scroll.append(tbl);
  roster.append(scroll, rosterBar);

  box.append(roster, form);
};

window.adminApi = { api, el, fmt, toast, loaders, DATETIME };

showTab('overview');
