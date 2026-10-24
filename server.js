'use strict';
// Пароли считаются на пуле потоков libuv: четырёх потоков по умолчанию мало,
// когда в час пик заходят тысячи игроков.
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '16';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { Store } = require('./src/store');
const { Table, setEvalBudget, REACTIONS, PHRASES } = require('./src/table');
const { BOT_NAMES } = require('./src/bot');
const { Tournament, SNG_STACK, SNG_TIMEOUT, SNG_BUY_INS } = require('./src/tournament');
const { ACHIEVEMENTS, achievementView, tierTotal } = require('./src/achievements');
const { Snapshot, mttRefunds } = require('./src/snapshot');
const telegram = require('./src/telegram');
const { LoginGuard, waitText } = require('./src/limits');
const analytics = require('./src/analytics');
const { dayKey } = require('./src/daily');
const seasons = require('./src/seasons');
const { createAdmin } = require('./src/admin');
const pages = require('./src/pages');
const { MttManager } = require('./src/mtt');

const PORT = Number(process.env.PORT) || 3000;
// За обратным прокси сервер стоит слушать только петлю, чтобы снаружи
// нельзя было постучаться мимо прокси.
const HOST = process.env.HOST || '0.0.0.0';
// По HTTPS cookie должна помечаться Secure, по HTTP — нет, иначе браузер её не сохранит.
const SECURE_COOKIE = process.env.COOKIE_SECURE === '1';
const PUBLIC_DIR = path.join(__dirname, 'public');
// Telegram включается токеном бота; адрес сайта нужен для кнопок «Играть» в боте.
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const APP_URL = process.env.APP_URL || 'https://thpoker.ru';
// Режим вебхука: Telegram сам приносит сообщения на /api/telegram/webhook.
// Нужен, если хостинг не выпускает сервер к api.telegram.org.
const TG_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
// Номер счётчика Яндекс Метрики: если задан, счётчик встаёт на все страницы сайта.
// По умолчанию — счётчик сайта; YANDEX_METRIKA_ID=off выключает его (например, на своей машине).
const METRIKA_ID = (() => {
  const v = process.env.YANDEX_METRIKA_ID;
  if (v === 'off') return '';
  return /^\d+$/.test(v || '') ? v : '113767079';
})();

// Столы заведения: стоят всегда, даже пустые, — чтобы было куда сесть сразу.
const ROOM_CONFIGS = [
  { id: 'novice', name: 'Новичок', maxSeats: 9, sb: 1, bb: 2, minBuyIn: 40, maxBuyIn: 200, timeout: 25 },
  { id: 'quiet', name: 'Тихий стол', maxSeats: 4, sb: 2, bb: 5, minBuyIn: 100, maxBuyIn: 500, timeout: 40 },
  { id: 'six', name: 'Шестёрка', maxSeats: 6, sb: 5, bb: 10, minBuyIn: 200, maxBuyIn: 1000, timeout: 25 },
  { id: 'heads', name: 'Хедз-ап', maxSeats: 2, sb: 10, bb: 20, minBuyIn: 400, maxBuyIn: 2000, timeout: 20 },
  { id: 'turbo', name: 'Турбо', maxSeats: 9, sb: 25, bb: 50, minBuyIn: 1000, maxBuyIn: 5000, timeout: 12 },
  { id: 'high', name: 'Высокие ставки', maxSeats: 6, sb: 50, bb: 100, minBuyIn: 2000, maxBuyIn: 10000, timeout: 25 },
];

// Из чего игрок собирает свой стол. Закупка — от 20 до 100 больших блайндов.
const STAKES = [[1, 2], [2, 5], [5, 10], [10, 20], [25, 50], [50, 100], [100, 200]];
const CASH_SEATS = [2, 4, 6, 9];
const SNG_SEATS = [6, 9];
const TIMEOUTS = [12, 25, 40];

const store = new Store();

// Столы живут, пока они нужны: свой стол игрок заводит сам, пустой закрывается.
const CASH_IDLE_MS = 5 * 60_000;     // пустой кэш-стол ждёт столько, прежде чем закрыться
const SNG_IDLE_MS = 10 * 60_000;     // турнир, на который никто не записался
const SNG_DONE_MS = 2 * 60_000;      // законченный турнир ещё висит с итогами
const TABLES_PER_USER = 3;           // сколько открытых столов может держать один игрок
const TABLES_MAX = 5000;
const LOBBY_LIMIT = 150;             // столько столов уходит в лобби — самые живые
const EVAL_PER_TICK = 8;             // тяжёлых разборов руки за тик (по ~4 мс каждый)

const handsByDay = new Map();   // день -> раздач сыграно (для админки; живёт до перезапуска)
const tables = new Map();       // tableId -> Table, в порядке создания
const playerTable = new Map();  // userId -> Table (чтобы не перебирать все столы)
const invites = new Map();      // код приглашения -> Table
let tableSeq = 0;

// Код приглашения: короткий, без похожих символов, угадать перебором нельзя.
const INVITE_ABC = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function inviteCode() {
  let code;
  do {
    code = Array.from(crypto.randomBytes(10), (b) => INVITE_ABC[b % INVITE_ABC.length]).join('');
  } while (invites.has(code));
  return code;
}

function dropTable(table) {
  tables.delete(table.id);
  invites.delete(table.invite);
}

function createTable(cfg, {
  owner = null, sng = 0, buyIn, invite = null, privateTable = false, createdAt = 0, mttTour = null, mttId = null,
} = {}) {
  const n = ++tableSeq;
  // Стол турнира по расписанию получает «переходник» от турнира, сит-н-гоу — свой Tournament.
  const tour = mttTour || (sng ? new Tournament(sng, {
    pay: (player, amount) => { if (!player.isBot) store.addChips(player.userId, amount); },
    onStart: (players) => {
      for (const p of players) {
        if (p.isBot) continue;
        store.recordSng(p.userId, { start: true });
        // Записался и ушёл — бот напомнит, что турнир начался.
        if (!isOnline(p.userId)) notify(p.userId, `Турнир начался — вас ждут за столом. Пока вас нет, блайнды списываются.`);
      }
    },
    onPlace: (player, place, prize) => {
      if (!player.isBot) store.recordSng(player.userId, { place, prize, humans: tour.humans, seats: tour.seats });
    },
  }, buyIn) : null);
  const table = new Table({ ...cfg, id: cfg.id || `t${n}`, tour }, {
    onChipsReturn: (player, chips) => {
      if (player.isBot) return;
      // Турнирные фишки в банк не уходят. До старта уход из-за стола — отмена регистрации.
      if (tour) { if (tour.status === 'registering') store.addChips(player.userId, tour.buyIn); return; }
      if (chips > 0) store.addChips(player.userId, chips);
    },
    onHandStart: (players) => {
      handsByDay.set(dayKey(), (handsByDay.get(dayKey()) || 0) + 1);
      for (const p of players) if (!p.isBot) store.countHand(p.userId);
    },
    onHandEnd: (results) => {
      const humans = results.filter((r) => !r.player.isBot).map((r) => r.player.userId);
      for (const r of results) {
        if (r.player.isBot) continue;
        // Сыграл раздачу за одним столом с другом — для задания дня.
        const me = store.user(r.player.userId);
        const withFriend = !!me && humans.some((id) => id !== me.id && me.friends.includes(id));
        store.recordHand(r.player.userId, { ...r, cash: !tour, withFriend, withHuman: humans.length > 1 });
      }
    },
    onSeat: (player, t) => {
      if (player.isBot) return;
      playerTable.set(player.userId, t);
      player.avatar = store.avatarUrl(store.user(player.userId));   // аватар — на месте за столом
    },
    // Пересаженного в турнире уже записали за новый стол — старый не должен его стереть.
    onUnseat: (player, t) => { if (!player.isBot && playerTable.get(player.userId) === t) playerTable.delete(player.userId); },
  });
  table.house = !owner && !mttId;
  table.mttId = mttId;
  table.ownerId = owner ? owner.id : null;
  table.ownerName = owner ? owner.name : null;
  table.private = !!privateTable;          // приватный стол не виден в лобби — только по ссылке
  table.invite = invite || inviteCode();
  table.createdAt = createdAt || Date.now();
  table.emptyAt = Date.now();
  tables.set(table.id, table);
  invites.set(table.invite, table);
  return table;
}

// Свой стол: кэш с выбранными блайндами или сит-н-гоу на 6 или 9 мест.
function createUserTable(user, body) {
  let owned = 0;
  for (const t of tables.values()) if (t.ownerId === user.id) owned += 1;
  if (owned >= TABLES_PER_USER) return { error: `Открыто уже ${TABLES_PER_USER} ваших стола — дождитесь, пока какой-нибудь закроется` };
  if (tables.size >= TABLES_MAX) return { error: 'Свободных столов нет, попробуйте позже' };

  const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 24);
  const privateTable = !!body.private;
  if (body.kind === 'sng') {
    const seats = Number(body.seats);
    if (!SNG_SEATS.includes(seats)) return { error: 'Сит-н-гоу бывает на 6 или 9 мест' };
    const buyIn = Number(body.buyIn);
    if (!SNG_BUY_INS.includes(buyIn)) return { error: 'Выберите взнос' };
    const table = createTable({
      name: name || `Сит-н-гоу на ${seats}`,
      maxSeats: seats, sb: 0, bb: 0, minBuyIn: SNG_STACK, maxBuyIn: SNG_STACK, timeout: SNG_TIMEOUT,
    }, { owner: user, sng: seats, buyIn, privateTable });
    [table.sb, table.bb] = table.tour.blinds();
    return table;
  }

  const seats = Number(body.seats);
  const stake = STAKES[Number(body.stake)];
  const timeout = Number(body.timeout);
  if (!CASH_SEATS.includes(seats)) return { error: 'Мест за столом может быть 2, 4, 6 или 9' };
  if (!stake) return { error: 'Выберите блайнды' };
  if (!TIMEOUTS.includes(timeout)) return { error: 'Выберите время на ход' };
  const [sb, bb] = stake;
  return createTable({
    name: name || `Стол ${user.name}`,
    maxSeats: seats, sb, bb, minBuyIn: bb * 20, maxBuyIn: bb * 100, timeout,
  }, { owner: user, privateTable });
}

// Пустые столы игроков закрываются, столы заведения стоят всегда.
function dropIdleTables(now) {
  for (const table of tables.values()) {
    if (table.house || table.mttId || table.occupied()) continue;
    const tour = table.tour;
    const idle = tour
      ? (tour.status === 'finished' ? now - tour.finishedAt > SNG_DONE_MS
        : tour.status === 'registering' && table.emptyAt && now - table.emptyAt > SNG_IDLE_MS)
      : table.emptyAt && now - table.emptyAt > CASH_IDLE_MS;
    if (idle) dropTable(table);
  }
}

for (const cfg of ROOM_CONFIGS) createTable(cfg);

// ——— турниры по расписанию ———

const mtts = new MttManager({
  createTable: (cfg, tour, mtt) => createTable(cfg, { mttTour: tour, mttId: mtt.id }),
  dropTable: (table) => dropTable(table),
  pay: (entry, amount) => store.addChips(entry.userId, amount),
  refund: (entry, amount) => store.addChips(entry.userId, amount),
  record: (entry, info) => store.recordMtt(entry.userId, info),
  notify: (userId, text) => notify(userId, text),
  isOnline: (userId) => isOnline(userId),
});

// Что из турниров кладётся в снимок рядом со столами.
function mttSnapshot() {
  return {
    mtts: mtts.snapshot().filter((m) => m.status === 'registering'),
    mttsRunning: [...mtts.list.values()].filter((m) => m.status === 'running').map((m) => ({
      id: m.id,
      poolLeft: m.prizes.reduce((a, b) => a + b, 0) - m.places.reduce((s, p) => s + p.prize, 0),
    })),
  };
}
function saveSnapshot() { return snapshot.save(tables, mttSnapshot()); }

// ——— Telegram ———

const bot = TG_TOKEN
  ? new telegram.Bot(TG_TOKEN, { appUrl: APP_URL, username: process.env.TELEGRAM_BOT_NAME || null })
  : null;

// Сообщение игроку в Telegram, если он привязан и бот работает.
function notify(userId, text) {
  const u = store.user(userId);
  if (!bot || !bot.running || !u || !u.tg) return;
  bot.notify(u.tg.id, text);
}

// Подпись от виджета на сайте или от Mini App — оба пути дают одного и того же игрока.
function telegramIdentity(body) {
  if (!TG_TOKEN) return null;
  if (body.initData) return telegram.verifyWebApp(body.initData, TG_TOKEN);
  return telegram.verifyLogin(body.data, TG_TOKEN);
}

// ——— снимок столов: фишки переживают перезапуск ———

const snapshot = new Snapshot(store.dataDir);

// Стол игрока из снимка открывается заново пустым — с тем же адресом и приглашением.
function reopenTable(rec) {
  if (tables.has(rec.id) || invites.has(rec.invite)) return false;
  const owner = rec.ownerId && store.user(rec.ownerId);
  if (!owner) return false;
  const cfg = {
    id: rec.id, name: rec.name, maxSeats: rec.maxSeats, sb: rec.sb, bb: rec.bb,
    minBuyIn: rec.minBuyIn, maxBuyIn: rec.maxBuyIn, timeout: rec.timeout,
  };
  const opts = { owner, invite: rec.invite, privateTable: rec.private, createdAt: rec.createdAt };
  if (rec.sng) {
    const table = createTable(cfg, { ...opts, sng: rec.sng.seats, buyIn: rec.sng.buyIn });
    [table.sb, table.bb] = table.tour.blinds();
  } else {
    createTable(cfg, opts);
  }
  return true;
}

{
  const restored = snapshot.restore({
    credit: (userId, amount) => store.addChips(userId, amount),
    reopen: reopenTable,
  });
  // Новые столы не должны занять номера восстановленных.
  for (const id of tables.keys()) {
    const n = Number(/^t(\d+)$/.exec(id)?.[1]);
    if (n > tableSeq) tableSeq = n;
  }
  if (restored) {
    // Регистрации на турниры — как были; оборвавшиеся турниры — фонд по стекам.
    mtts.restore(restored.snap.mtts || []);
    for (const r of mttRefunds(restored.snap)) {
      store.addChips(r.userId, r.amount);
      restored.players += 1;
      restored.chips += r.amount;
    }
    console.log(`Снимок столов разобран: фишки вернулись ${restored.players} игрокам `
      + `(${restored.chips}), столов открыто заново: ${restored.tables}`);
    // Снимок убираем, только когда возвращённые фишки легли в базу.
    snapshot.paused = true;
    Promise.resolve(store.flush()).then(() => { snapshot.clear(); snapshot.paused = false; });
  }
}

const clients = new Set();          // открытые SSE-соединения
const presence = new Map();         // userId -> { conns, lastSeen }

// ——— наблюдение за нагрузкой ———
// Задержка игрового цикла — главный признак перегрузки: если она растёт,
// сервер не успевает обслуживать столы и соединения.
const metrics = {
  lag: new Float64Array(64),
  lagAt: 0,
  pushedFrames: 0,
  pushedBytes: 0,
  serialized: 0,   // сколько раз состояние стола превращалось в JSON
  skipped: 0,      // кадров пропущено из-за медленных соединений
  startedAt: Date.now(),
};

function noteLag(ms) {
  metrics.lag[metrics.lagAt % metrics.lag.length] = ms;
  metrics.lagAt += 1;
}

function lagStats() {
  const n = Math.min(metrics.lagAt, metrics.lag.length);
  if (!n) return { p50: 0, p99: 0, max: 0 };
  const sorted = Array.from(metrics.lag.slice(0, n)).sort((a, b) => a - b);
  return {
    p50: Math.round(sorted[Math.floor(n * 0.5)] * 10) / 10,
    p99: Math.round(sorted[Math.min(n - 1, Math.floor(n * 0.99))] * 10) / 10,
    max: Math.round(sorted[n - 1] * 10) / 10,
  };
}

// ——— утилиты HTTP ———

function send(res, code, data, headers = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 10_000) { reject(new Error('Слишком большой запрос')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Некорректный JSON')); }
    });
    req.on('error', reject);
  });
}

// Тело запроса как есть — для картинок: JSON-разбор и лимит в 10 КБ им не подходят.
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    // Лишнее не храним, но дочитываем: оборванное соединение браузер покажет
    // как сбой сети, а не как понятную ошибку. Сверху объём ограничивает nginx.
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on('end', () => (size > limit ? reject(new Error('Файл слишком большой')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

// ——— аватары ———
// Картинку готовит браузер: обрезает до квадрата 256×256 и сжимает. Сервер
// проверяет формат по первым байтам файла — расширению и заголовку не верим.

const AVATAR_DIR = path.join(store.dataDir, 'avatars');
const AVATAR_MAX = 300_000;
const AVATAR_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function imageKind(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function dropAvatarFile(userId, ext) {
  try { fs.rmSync(path.join(AVATAR_DIR, `${userId}.${ext}`), { force: true }); } catch { /* файла нет */ }
}

// Новый аватар сразу виден и на месте за столом.
function refreshSeatAvatar(userId) {
  const table = tableOfUser(userId);
  const p = table && table.byUser(userId);
  if (!p) return;
  p.avatar = store.avatarUrl(store.user(userId));
  table.touch();
}

function serveAvatar(req, res, file) {
  if (!/^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(file)) return send(res, 404, 'Нет такого файла');
  fs.readFile(path.join(AVATAR_DIR, file), (err, body) => {
    if (err) return send(res, 404, 'Нет такого файла');
    res.writeHead(200, {
      'Content-Type': AVATAR_MIME[path.extname(file).slice(1)],
      'Content-Length': body.length,
      // В адресе есть версия, поэтому файл можно кэшировать надолго.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  });
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

// Страницы сайта: главная — для поиска и новичков, игра — на /play.
const PAGES = { '/': 'index.html', '/play': 'play.html', '/play/': 'play.html', '/admin': 'admin.html' };
// Старые и служебные адреса страниц ведут на основные, чтобы у поиска не было дублей.
const PAGE_ALIASES = { '/index.html': '/', '/play.html': '/play' };
// Картинки меняются редко — браузер может не переспрашивать о них сутки.
const LONG_CACHE = new Set(['.png', '.jpg', '.svg', '.ico', '.woff2']);

// Статика читается с диска один раз и дальше отдаётся из памяти.
// Файлы клиента маленькие, а запросов при большом онлайне много.
const staticCache = new Map(); // путь -> { body, type, etag }

// Файлы клиента меняются редко, но менять их без перезапуска сервера удобно:
// следим за папкой и сбрасываем кэш при любом изменении.
try {
  fs.watch(PUBLIC_DIR, { persistent: false }, () => staticCache.clear());
} catch {
  // Слежение недоступно — тогда кэш живёт до перезапуска.
}

// Счётчик Метрики вставляется в страницы при отдаче, а не лежит в каждом файле:
// так он один на весь сайт, включая страницы, которые собирает сервер.
function withMetrika(html) {
  if (!METRIKA_ID || html.includes('mc.yandex.ru')) return html;
  const snippet = `<!-- Yandex.Metrika counter -->
<script type="text/javascript">
    (function(m,e,t,r,i,k,a){
        m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
        m[i].l=1*new Date();
        for (var j = 0; j < document.scripts.length; j++) {if (document.scripts[j].src === r) { return; }}
        k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)
    })(window, document,'script','https://mc.yandex.ru/metrika/tag.js?id=${METRIKA_ID}', 'ym');

    ym(${METRIKA_ID}, 'init', {ssr:true, webvisor:true, clickmap:true, ecommerce:"dataLayer", referrer: document.referrer, url: location.href, accurateTrackBounce:true, trackLinks:true});
</script>
<noscript><div><img src="https://mc.yandex.ru/watch/${METRIKA_ID}" style="position:absolute; left:-9999px;" alt="" /></div></noscript>
<!-- /Yandex.Metrika counter -->
`;
  return html.replace('</head>', `${snippet}</head>`);
}

// Админку не считаем: Вебвизору незачем записывать работу администратора.
const NO_METRIKA = new Set([path.join(PUBLIC_DIR, 'admin.html')]);

function staticFile(file) {
  let entry = staticCache.get(file);
  if (entry !== undefined) return entry;
  try {
    let body = fs.readFileSync(file);
    if (path.extname(file) === '.html' && !NO_METRIKA.has(file)) body = Buffer.from(withMetrika(body.toString('utf8')));
    entry = {
      body,
      type: MIME[path.extname(file)] || 'application/octet-stream',
      etag: `"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)}"`,
    };
  } catch {
    return null;   // отсутствие файла не кэшируем: иначе добавленный файл виден только после перезапуска
  }
  staticCache.set(file, entry);
  return entry;
}

function cacheFor(file) {
  return LONG_CACHE.has(path.extname(file)) ? 'public, max-age=86400' : 'no-cache';
}

function serveStatic(req, res, urlPath) {
  if (PAGE_ALIASES[urlPath]) {
    res.writeHead(301, { Location: PAGE_ALIASES[urlPath] });
    return res.end();
  }
  // Кто уже вошёл, приходит играть, а не читать о покере: с главной — сразу за столы.
  if (urlPath === '/' && sessionOf(req)) {
    res.writeHead(302, { Location: '/play', 'Cache-Control': 'no-store', Vary: 'Cookie' });
    return res.end();
  }
  // Статьи живут по чистым адресам: /articles/ и /articles/название.
  const article = /^\/articles(?:\/([a-z0-9-]+))?\/?$/.exec(urlPath);
  const rel = PAGES[urlPath] || (article ? `articles/${article[1] || 'index'}.html` : urlPath.replace(/^\/+/, ''));
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Доступ запрещён');

  const entry = staticFile(file);
  if (!entry) return send(res, 404, 'Страница не найдена');
  if (req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, { ETag: entry.etag, 'Cache-Control': cacheFor(file) });
    return res.end();
  }
  res.writeHead(200, {
    'Content-Type': entry.type,
    'Content-Length': entry.body.length,
    'Cache-Control': cacheFor(file),
    ETag: entry.etag,
    ...(urlPath === '/' ? { Vary: 'Cookie' } : {}),
  });
  res.end(entry.body);
}

// ——— сессии ———

const loginGuard = new LoginGuard();

// Настоящий адрес игрока. За nginx сокет всегда смотрит на петлю, а адрес
// приходит заголовком X-Real-IP; верим ему только от своего прокси.
function isDirectLocal(req) {
  const remote = req.socket.remoteAddress || '';
  return (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') && !req.headers['x-real-ip'];
}

function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const forwarded = req.headers['x-real-ip'];
  return local && forwarded ? String(forwarded) : remote;
}

function sessionOf(req) {
  const token = cookies(req).sid;
  const session = store.session(token);
  if (!session) return null;
  const user = store.user(session.userId);
  if (!user || store.isBanned(user)) return null;
  return { token, session, user };
}

// Простое ведро с токенами: один игрок не должен занимать сервер бесконечными
// командами. Обычная игра — единицы команд в секунду, лимит выше с запасом.
const CMD_RATE = 25;
const CMD_BURST = 50;

function allowCommand(session, now = Date.now()) {
  const last = session.rateAt || now;
  const tokens = Math.min(CMD_BURST, (session.tokens === undefined ? CMD_BURST : session.tokens)
    + ((now - last) / 1000) * CMD_RATE);
  session.rateAt = now;
  if (tokens < 1) { session.tokens = tokens; return false; }
  session.tokens = tokens - 1;
  return true;
}

function requireAuth(req, res) {
  const ctx = sessionOf(req);
  if (!ctx) { send(res, 401, { error: 'Нужно войти в аккаунт' }); return null; }
  seen(ctx.user.id);
  return ctx;
}

// Отмечаем активность игрока: по ней решаем, кто отошёл от стола.
function seen(userId) {
  const rec = presence.get(userId) || { conns: 0, lastSeen: 0 };
  rec.lastSeen = Date.now();
  presence.set(userId, rec);
}

function tableOfUser(userId) {
  return playerTable.get(userId) || null;
}

// ——— сводка по лобби ———
// Собирается один раз и уходит всем зрителям одной строкой: пересобирать её
// на каждого из тысяч наблюдателей нельзя.
let lobbyJson = '';
let lobbyFrame = '';
let lobbyAt = 0;
let lobbyVersion = 1;
const LOBBY_EVERY = 500;

function tableInfo(table) {
  const tour = table.tour;
  return {
    id: table.id,
    kind: tour ? 'sng' : 'cash',
    name: table.name,
    house: table.house,
    owner: table.ownerName,
    maxSeats: table.maxSeats,
    sb: table.sb,
    bb: table.bb,
    minBuyIn: table.minBuyIn,
    maxBuyIn: table.maxBuyIn,
    timeout: table.timeout,
    // Место за местом: 0 — свободно, 1 — человек, 2 — бот.
    seats: table.seats.map((p) => (!p ? 0 : p.isBot ? 2 : 1)),
    playing: table.phase !== 'idle',
    sng: tour ? {
      status: tour.status,
      buyIn: tour.buyIn,
      stack: tour.stack,
      prizes: tour.prizes,
      level: tour.level + 1,
      left: table.occupied(),
      winner: tour.status === 'finished' && tour.places[0] ? tour.places[0].name : null,
    } : null,
  };
}

// В лобби уходят не все столы, а самые живые: при тысячах столов список
// иначе весил бы сотни килобайт на каждое обновление. Столы заведения
// и турниры, где идёт регистрация, видны всегда.
function lobbyTables() {
  const rank = (t) => (t.house ? 3 : t.tour && t.tour.status === 'registering' ? 2 : 0) * 100 + t.humans();
  // Столы турниров по расписанию показываются в своём разделе, не в общем списке.
  const list = [...tables.values()].filter((t) => !t.private && !t.mttId);
  if (list.length > LOBBY_LIMIT) {
    list.sort((a, b) => rank(b) - rank(a));
    list.length = LOBBY_LIMIT;
    list.sort((a, b) => a.createdAt - b.createdAt);
  }
  return list.map(tableInfo);
}

function lobbyTotals() {
  let players = 0;
  let humans = 0;
  let playing = 0;
  for (const table of tables.values()) {
    players += table.occupied();
    humans += table.humans();
    if (table.phase !== 'idle') playing += 1;
  }
  return { tables: tables.size, players, humans, playing };
}

function lobbySnapshot(now = Date.now()) {
  if (lobbyJson && now - lobbyAt < LOBBY_EVERY) return lobbyJson;
  lobbyAt = now;
  const next = JSON.stringify({
    rooms: lobbyTables(),
    totals: lobbyTotals(),
    announcement: admin.getAnnouncement(),
    stakes: STAKES,
    sngBuyIns: SNG_BUY_INS,
    mtts: mtts.overview(null),
  });
  if (next !== lobbyJson) {
    lobbyJson = next;
    lobbyFrame = `event: lobby\ndata: ${next}\n\n`;
    lobbyVersion += 1;
  }
  return lobbyJson;
}

// ——— приглашения ———

// Приватный стол видят хозяин, те, кто пришёл по ссылке, и друзья
// хозяина или сидящих за столом — к другу можно подсесть без ссылки.
function canEnter(user, session, table) {
  if (!table.private || table.ownerId === user.id) return true;
  if (session.invites && session.invites.has(table.id)) return true;
  if (user.friends.includes(table.ownerId)) return true;
  return table.players().some((p) => !p.isBot && user.friends.includes(p.userId));
}

// Что видно по ссылке ещё до входа: куда зовут и кто.
function inviteInfo(table) {
  const tour = table.tour;
  return {
    name: table.name,
    owner: table.ownerName,
    kind: tour ? 'sng' : 'cash',
    sb: table.sb,
    bb: table.bb,
    maxSeats: table.maxSeats,
    players: table.occupied(),
    sng: tour ? { status: tour.status, buyIn: tour.buyIn, prizes: tour.prizes } : null,
  };
}

const { escapeHtml } = pages;

// Страница ссылки-приглашения. Мессенджер по ней строит превью («Анна зовёт
// за стол…»), а человек сразу уходит в игру с кодом приглашения.
function invitePage(req, res, code) {
  const table = invites.get(code);
  const origin = `${SECURE_COOKIE ? 'https' : 'http'}://${req.headers.host}`;
  const go = table ? `/play?join=${encodeURIComponent(code)}` : '/play';
  let title = 'Стол уже закрыт — THPoker';
  let text = 'Этот стол закрылся. Заходите в THPoker — бесплатный покер без денег: столы открыты круглосуточно.';
  if (table) {
    const info = inviteInfo(table);
    const what = info.kind === 'sng'
      ? `сит-н-гоу на ${info.maxSeats}, взнос ${info.sng.buyIn}`
      : `блайнды ${info.sb}/${info.bb}, ${info.maxSeats} мест`;
    title = `${info.owner || 'Друг'} зовёт за стол «${info.name}» — THPoker`;
    text = `${what}. Бесплатный покер на виртуальные фишки прямо в браузере.`;
  }
  const html = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="robots" content="noindex">
<meta name="description" content="${escapeHtml(text)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="THPoker">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(text)}">
<meta property="og:image" content="${origin}/og.png">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0; url=${escapeHtml(go)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1317;color:#dfe7e6;font:16px system-ui,sans-serif}a{color:#c9a24a}</style>
</head><body><p><a href="${escapeHtml(go)}">Открыть стол в THPoker</a></p>
<script>location.replace(${JSON.stringify(go)});</script></body></html>`;
  res.writeHead(table ? 200 : 404, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

// Свои столы — с приглашениями: их удобно открыть заново и позвать друзей.
function tablesOf(user) {
  const out = [];
  for (const t of tables.values()) {
    if (t.ownerId !== user.id) continue;
    out.push({ id: t.id, invite: t.invite, private: t.private, ...inviteInfo(t) });
  }
  return out;
}

// ——— кабинет, друзья, рейтинг ———

function isOnline(userId) {
  const rec = presence.get(userId);
  return !!(rec && rec.conns > 0);
}

// Где сейчас игрок: за каким столом сидит. Нужно, чтобы друг мог подсесть.
function whereIs(userId) {
  const table = tableOfUser(userId);
  return table ? { id: table.id, name: table.name, kind: table.tour ? 'sng' : 'cash' } : null;
}

function friendView(id) {
  const u = store.user(id);
  if (!u) return null;
  return { name: u.name, avatar: store.avatarUrl(u), chips: u.chips, online: isOnline(id), table: whereIs(id) };
}

// Друзья онлайн — наверх, дальше по имени.
function sortedViews(ids) {
  return ids.map(friendView).filter(Boolean)
    .sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name, 'ru'));
}

// Друзья и заявки: входящие ждут ответа, исходящие — ответа от другого.
function friendsOf(user) {
  return {
    friends: sortedViews(user.friends),
    incoming: sortedViews(user.friendsIn),
    outgoing: sortedViews(user.friendsOut),
  };
}

function profileOf(target, viewer) {
  const own = target.id === viewer.id;
  const s = target.stats;
  return {
    name: target.name,
    own,
    createdAt: target.createdAt,
    chips: target.chips,
    online: isOnline(target.id),
    table: whereIs(target.id),
    relation: own ? null : store.relation(viewer, target),
    avatar: store.avatarUrl(target),
    season: seasons.view(target),
    stats: {
      handsPlayed: target.handsPlayed,
      handsWon: s.handsWon,
      handsLost: s.handsLost,
      showdowns: s.showdowns,
      showdownsWon: s.showdownsWon,
      allInsWon: s.allInsWon,
      biggestPot: s.biggestPot,
      cashNet: s.cashNet,
      bestHand: s.bestHand ? { name: s.bestHand.name, cards: s.bestHand.cards } : null,
      sngPlayed: s.sngPlayed,
      sngCashes: s.sngCashes,
      sngWins: s.sngWins,
      sngPrizes: s.sngPrizes,
      peakChips: s.peakChips,
    },
    achievements: ACHIEVEMENTS.map((a) => achievementView(a, target)),
    tiers: { got: tierTotal(target), of: ACHIEVEMENTS.reduce((sum, a) => sum + a.tiers.length, 0) },
    friends: own ? friendsOf(target) : null,
  };
}

// ——— команды за столом ———

async function handleCommand(ctx, body) {
  const { session, user } = ctx;
  const cmd = body.cmd;
  const room = () => tables.get(session.roomId);

  switch (cmd) {
    case 'enterRoom': {
      const seated = tableOfUser(user.id);
      if (seated) { session.roomId = seated.id; return { ok: true, roomId: seated.id }; }
      const table = tables.get(String(body.roomId));
      if (!table) return { error: 'Стол уже закрыт' };
      if (!canEnter(user, session, table)) return { error: 'Это приватный стол — попасть за него можно по ссылке-приглашению' };
      session.roomId = table.id;
      return { ok: true, roomId: table.id };
    }
    case 'join': {
      // Вход по ссылке-приглашению: код открывает и приватный стол.
      const table = invites.get(String(body.code || ''));
      if (!table) return { error: 'Стол по этой ссылке уже закрыт' };
      session.invites = session.invites || new Set();
      session.invites.add(table.id);
      const seated = tableOfUser(user.id);
      if (seated && seated !== table) {
        session.roomId = seated.id;
        return { error: 'Вы сидите за другим столом — встаньте из-за него, чтобы перейти по приглашению' };
      }
      session.roomId = table.id;
      return { ok: true, roomId: table.id };
    }
    case 'createTable': {
      const seated = tableOfUser(user.id);
      if (seated) return { error: 'Сначала встаньте из-за текущего стола' };
      const table = createUserTable(user, body);
      if (table.error) return table;
      session.roomId = table.id;
      return { ok: true, roomId: table.id };
    }
    case 'leaveRoom': {
      const table = room();
      if (table && table.byUser(user.id)) table.leave(user.id);
      session.roomId = null;
      return { ok: true };
    }
    case 'sit': {
      const table = room();
      if (!table) return { error: 'Сначала войдите в комнату' };
      if (tableOfUser(user.id) && tableOfUser(user.id) !== table) return { error: 'Вы уже сидите за другим столом' };
      const tour = table.tour;
      if (tour && tour.status !== 'registering') return { error: 'Регистрация на турнир закрыта' };
      // В турнире платят взнос, а играют турнирным стеком.
      const pay = tour ? tour.buyIn : Math.round(Number(body.buyIn) || 0);
      const stack = tour ? tour.stack : pay;
      const fresh = store.user(user.id);
      if (pay > fresh.chips) return { error: 'В банке недостаточно фишек' };
      // Место можно не выбирать: тогда сажаем на первое свободное.
      let seat = Number(body.seat);
      if (!Number.isInteger(seat) || seat < 0) seat = table.seats.findIndex((x) => x === null);
      if (seat < 0) return { error: 'Свободных мест нет' };
      // Взнос списываем до посадки: последний участник сразу запускает турнир.
      store.addChips(user.id, -pay);
      const res = table.sit({ id: user.id, name: user.name }, seat, stack);
      if (!res.error) store.markSit(user);
      if (res.error) { store.addChips(user.id, pay); return res; }
      return { ok: true };
    }
    case 'standUp': {
      const table = room();
      if (!table) return { error: 'Вы не за столом' };
      return table.leave(user.id);
    }
    case 'act': {
      const table = room();
      if (!table) return { error: 'Вы не за столом' };
      return table.act(user.id, String(body.action), body.amount);
    }
    case 'prefs': {
      // Выключенный силомер экономит серверу перебор рук соперника.
      session.meter = body.meter !== false;
      return { ok: true };
    }
    case 'reveal': {
      const table = room();
      if (!table) return { error: 'Вы не за столом' };
      return table.playerReveal(user.id, !!body.show);
    }
    case 'sitOut': {
      const table = room();
      if (!table) return { error: 'Вы не за столом' };
      return table.setSittingOut(user.id, !!body.value);
    }
    case 'topUp': {
      const table = room();
      if (!table) return { error: 'Вы не за столом' };
      const seat = table.byUser(user.id);
      if (!seat) return { error: 'Вы не за столом' };
      if (table.tour) return { error: 'В турнире докупать нельзя' };
      const fresh = store.user(user.id);
      const amount = Math.min(Math.round(Number(body.amount) || 0), fresh.chips);
      if (amount <= 0) return { error: 'В банке нет фишек' };
      const res = table.addChips(user.id, amount);
      if (res.error) return res;
      store.addChips(user.id, -amount);
      return { ok: true };
    }
    case 'addBot': {
      const table = room();
      if (!table) return { error: 'Сначала войдите в комнату' };
      if (table.tour && table.tour.status !== 'registering') return { error: 'Турнир уже идёт' };
      const seat = table.seats.findIndex((s) => s === null);
      if (seat < 0) return { error: 'Свободных мест нет' };
      const taken = new Set(table.players().map((p) => p.name));
      const name = BOT_NAMES.find((n) => !taken.has(n)) || `Бот-${seat + 1}`;
      const stack = table.tour ? table.tour.stack : Math.round((table.minBuyIn + table.maxBuyIn) / 2);
      return table.sit({ id: `bot-${crypto.randomUUID()}`, name, isBot: true }, seat, stack);
    }
    case 'kickBot': {
      const table = room();
      if (!table) return { error: 'Сначала войдите в комнату' };
      const p = table.bySeat(Number(body.seat));
      if (!p || !p.isBot) return { error: 'На этом месте не бот' };
      if (table.tour && table.tour.status !== 'registering') return { error: 'Из турнира бота не убрать' };
      if (p.inHand && table.phase !== 'idle') { p.leaving = true; return { ok: true, pending: true }; }
      return table.removePlayer(p);
    }
    case 'react': {
      const table = room();
      if (!table) return { error: 'Сначала сядьте за стол' };
      return table.react(user.id, String(body.text || ''));
    }
    case 'chat': {
      const table = room();
      if (!table) return { error: 'Сначала войдите в комнату' };
      const text = String(body.text || '').trim().slice(0, 140);
      if (text) table.chat(user.name, text);
      return { ok: true };
    }
    case 'reload':
      return store.reload(user.id);
    case 'mttRegister': {
      const mtt = mtts.get(String(body.id));
      if (!mtt) return { error: 'Турнир не найден' };
      const res = mtt.register({ userId: user.id, name: user.name }, store.user(user.id).chips);
      if (res.pay) store.addChips(user.id, -res.pay);
      return res.error ? res : { ok: true };
    }
    case 'mttUnregister': {
      const mtt = mtts.get(String(body.id));
      if (!mtt) return { error: 'Турнир не найден' };
      return mtt.unregister(user.id);
    }
    case 'mttWatch': {
      // Смотреть идущий турнир — за самым полным его столом.
      const mtt = mtts.get(String(body.id));
      const info = mtt && mtt.info();
      if (!info || !info.watch) return { error: 'Сейчас смотреть нечего' };
      if (!tableOfUser(user.id)) session.roomId = info.watch;
      return { ok: true, roomId: session.roomId };
    }
    case 'claimBonus':
      return store.claimBonus(user.id);
    case 'claimQuest':
      return store.claimQuest(user.id, body.id);
    case 'addFriend': {
      const res = store.addFriend(user.id, body.name);
      const other = store.byNameLower(body.name);
      if (res.status === 'out' && other) notify(other.id, `${user.name} хочет добавить вас в друзья в THPoker.`);
      if (res.status === 'friend' && other) notify(other.id, `${user.name} теперь у вас в друзьях.`);
      return res;
    }
    case 'acceptFriend': {
      const res = store.acceptFriend(user.id, body.name);
      const other = store.byNameLower(body.name);
      if (res.ok && other) notify(other.id, `${user.name} принял(а) вашу заявку в друзья.`);
      return res;
    }
    case 'declineFriend':
      return store.declineFriend(user.id, body.name);
    case 'removeFriend':
      return store.removeFriend(user.id, body.name);
    default:
      return { error: 'Неизвестная команда' };
  }
}

// ——— маршруты ———

const MONEY_CMDS = new Set(['sit', 'standUp', 'leaveRoom', 'topUp', 'createTable', 'addBot', 'kickBot', 'mttRegister', 'mttUnregister']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = url.pathname;

  if ((req.method === 'GET' || req.method === 'HEAD') && route.startsWith('/t/')) {
    return invitePage(req, res, decodeURIComponent(route.slice(3)).replace(/\/$/, ''));
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && route.startsWith('/avatars/')) {
    return serveAvatar(req, res, route.slice('/avatars/'.length));
  }

  // Публичный профиль игрока — со своим превью для соцсетей.
  if ((req.method === 'GET' || req.method === 'HEAD') && route.startsWith('/u/')) {
    const user = store.byNameLower(decodeURIComponent(route.slice(3)).replace(/\/$/, ''));
    if (!user || store.isBanned(user)) return send(res, 404, 'Игрок не найден');
    const origin = `${SECURE_COOKIE ? 'https' : 'http'}://${req.headers.host}`;
    const html = withMetrika(pages.profilePage(user, origin, store.avatarUrl(user)));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'no-cache' });
    return res.end(html);
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && !route.startsWith('/api/')) return serveStatic(req, res, route);

  try {
    if (await admin.handle(req, res, route, url)) return;

    if (route === '/api/register' && req.method === 'POST') {
      const ip = clientIp(req);
      // Прямой запрос с самой машины (без nginx) — это нагрузочный тест или администратор.
      const wait = isDirectLocal(req) ? 0 : loginGuard.canRegister(ip);
      if (wait) return send(res, 429, { error: `С этого адреса уже много новых аккаунтов. Попробуйте через ${waitText(wait)}` });
      const body = await readBody(req);
      const { user, error } = await store.register(body.name, body.password, body.source);
      if (error) return send(res, 400, { error });
      loginGuard.registered(ip);
      const token = store.createSession(user.id);
      return send(res, 200, { user: store.publicUser(user.id) }, { 'Set-Cookie': sessionCookie(token) });
    }

    if (route === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      const ip = clientIp(req);
      const name = String(body.name || '').trim().toLowerCase();
      const wait = loginGuard.check(ip, name);
      if (wait) return send(res, 429, { error: `Слишком много неудачных попыток. Попробуйте через ${waitText(wait)}` });
      const { user, error } = await store.login(body.name, body.password);
      if (error) { loginGuard.failed(ip, name); return send(res, 400, { error }); }
      loginGuard.succeeded(ip, name);
      const token = store.createSession(user.id);
      return send(res, 200, { user: store.publicUser(user.id) }, { 'Set-Cookie': sessionCookie(token) });
    }

    if (route === '/api/config' && req.method === 'GET') {
      return send(res, 200, {
        telegramBot: bot && bot.username ? bot.username : null,
        reactions: REACTIONS,
        phrases: PHRASES,
        metrika: METRIKA_ID || null,
      });
    }

    // Вход через Telegram: виджет на сайте присылает data, Mini App — initData.
    if (route === '/api/telegram/login' && req.method === 'POST') {
      const body = await readBody(req);
      const tg = telegramIdentity(body);
      if (!tg) return send(res, 400, { error: 'Telegram не подтвердил вход — попробуйте ещё раз' });
      const { user, created, error } = store.telegramUser(tg, body.source);
      if (error) return send(res, 403, { error });
      const token = store.createSession(user.id);
      return send(res, 200, { user: store.publicUser(user.id), created }, { 'Set-Cookie': sessionCookie(token) });
    }

    // Вебхук: Telegram присылает сообщение, ответ уходит прямо в теле ответа —
    // так бот отвечает, даже когда сервер не может сам достучаться до Telegram.
    if (route === '/api/telegram/webhook' && req.method === 'POST') {
      const secret = req.headers['x-telegram-bot-api-secret-token'] || '';
      if (!bot || !TG_WEBHOOK_SECRET || !crypto.timingSafeEqual(
        crypto.createHash('sha256').update(secret).digest(),
        crypto.createHash('sha256').update(TG_WEBHOOK_SECRET).digest(),
      )) return send(res, 403, { error: 'Нет доступа' });
      const answer = bot.reply(await readBody(req));
      return send(res, 200, answer || {});
    }

    if (route === '/api/telegram/link' && req.method === 'POST') {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      const body = await readBody(req);
      const tg = telegramIdentity(body);
      if (!tg) return send(res, 400, { error: 'Telegram не подтвердил привязку — попробуйте ещё раз' });
      const result = store.linkTelegram(ctx.user.id, tg);
      if (result.error) return send(res, 400, result);
      return send(res, 200, { ok: true, user: store.publicUser(ctx.user.id) });
    }

    if (route === '/api/logout' && req.method === 'POST') {
      const ctx = sessionOf(req);
      if (ctx) {
        const table = tableOfUser(ctx.user.id);
        if (table) table.leave(ctx.user.id);
        store.destroySession(ctx.token);
      }
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' });
    }

    if (route === '/api/me' && req.method === 'GET') {
      const ctx = sessionOf(req);
      if (!ctx) return send(res, 200, { user: null });
      return send(res, 200, {
        user: store.publicUser(ctx.user.id),
        admin: admin.isAdmin(ctx.user),
        roomId: ctx.session.roomId,
        leaderboard: store.leaderboard(),
      });
    }

    if (route === '/api/health' && req.method === 'GET') {
      let seated = 0;
      let active = 0;
      for (const table of tables.values()) {
        seated += table.occupied();
        if (table.phase !== 'idle') active += 1;
      }
      const mem = process.memoryUsage();
      const cpu = process.cpuUsage();
      return send(res, 200, {
        cpuMs: Math.round((cpu.user + cpu.system) / 1000),
        uptimeSec: Math.round((Date.now() - metrics.startedAt) / 1000),
        clients: clients.size,
        users: store.users.size,
        sessions: store.sessions.size,
        pendingWrites: store.stats().pendingWrites,
        tables: tables.size,
        tablesActive: active,
        seated,
        lagMs: lagStats(),
        pushedFrames: metrics.pushedFrames,
        pushedBytes: metrics.pushedBytes,
        serialized: metrics.serialized,
        skipped: metrics.skipped,
        rssMb: Math.round(mem.rss / 1048576),
        heapMb: Math.round(mem.heapUsed / 1048576),
      });
    }

    if (route === '/api/profile' && req.method === 'GET') {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      const name = url.searchParams.get('name');
      const target = name ? store.byNameLower(name) : ctx.user;
      if (!target) return send(res, 404, { error: 'Игрок не найден' });
      return send(res, 200, profileOf(target, ctx.user));
    }

    if (route === '/api/friends' && req.method === 'GET') {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      return send(res, 200, { ...friendsOf(ctx.user), tables: tablesOf(ctx.user) });
    }

    if (route === '/api/rating' && req.method === 'GET') {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      return send(res, 200, store.rating(url.searchParams.get('by') || 'chips', ctx.user.id));
    }

    if (route === '/api/avatar' && req.method === 'POST') {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      if (!allowCommand(ctx.session)) return send(res, 429, { error: 'Слишком часто. Подождите секунду' });
      const body = await readRaw(req, AVATAR_MAX);
      const ext = imageKind(body);
      if (!ext) return send(res, 400, { error: 'Нужна картинка JPEG, PNG или WebP' });
      fs.mkdirSync(AVATAR_DIR, { recursive: true });
      const target = path.join(AVATAR_DIR, `${ctx.user.id}.${ext}`);
      fs.writeFileSync(`${target}.tmp`, body);
      fs.renameSync(`${target}.tmp`, target);
      const old = ctx.user.meta.avatar;
      if (old && old.ext !== ext) dropAvatarFile(ctx.user.id, old.ext);
      store.setAvatar(ctx.user.id, ext);
      refreshSeatAvatar(ctx.user.id);
      pushAll();
      return send(res, 200, { ok: true, user: store.publicUser(ctx.user.id) });
    }

    if (route === '/api/avatar/remove' && req.method === 'POST') {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      const old = store.removeAvatar(ctx.user.id);
      if (old) dropAvatarFile(ctx.user.id, old.ext);
      refreshSeatAvatar(ctx.user.id);
      pushAll();
      return send(res, 200, { ok: true, user: store.publicUser(ctx.user.id) });
    }

    if (route === '/api/mtt' && req.method === 'GET') {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      return send(res, 200, { list: mtts.overview(ctx.user.id), now: Date.now() });
    }

    if (route === '/api/invite' && req.method === 'GET') {
      const table = invites.get(url.searchParams.get('code') || '');
      if (!table) return send(res, 404, { error: 'Стол по этой ссылке уже закрыт' });
      return send(res, 200, inviteInfo(table));
    }

    if (route === '/api/rooms' && req.method === 'GET') {
      return send(res, 200, JSON.parse(lobbySnapshot()));
    }

    if (route === '/api/cmd' && req.method === 'POST') {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      if (!allowCommand(ctx.session)) return send(res, 429, { error: 'Слишком часто. Подождите секунду' });
      const body = await readBody(req);
      const result = await handleCommand(ctx, body);
      // Команды, которые двигают фишки между банком и столом, сразу попадают в снимок.
      if (MONEY_CMDS.has(body.cmd) && !result.error) saveSnapshot();
      pushAll();
      if (result.error) return send(res, 400, result);
      return send(res, 200, { ...result, user: store.publicUser(ctx.user.id) });
    }

    if (route === '/api/stream' && req.method === 'GET') {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      return openStream(req, res, ctx);
    }

    return send(res, 404, { error: 'Такого адреса нет' });
  } catch (err) {
    return send(res, 400, { error: err.message || 'Ошибка запроса' });
  }
});

function sessionCookie(token) {
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax${SECURE_COOKIE ? '; Secure' : ''}`
    + `; Max-Age=${60 * 60 * 24 * 30}`;
}

// ——— админка ———

const admin = createAdmin({
  // Убрать неприемлемый аватар — файл тоже удаляется.
  removeAvatar: (userId) => {
    const old = store.removeAvatar(userId);
    if (old) dropAvatarFile(userId, old.ext);
    refreshSeatAvatar(userId);
    return !!old;
  },
  store,
  tables,
  handsByDay,
  send,
  readBody,
  requireAuth,
  tableOfUser,
  isOnline,
  dropTable,
  saveSnapshot: () => saveSnapshot(),
  pushAll: () => pushAll(),
  reopenHouse: (id) => {
    const cfg = ROOM_CONFIGS.find((c) => c.id === id);
    if (cfg) createTable(cfg);
  },
  // Заблокированного выкидываем из потока: следующий запрос он уже не пройдёт.
  dropStreams: (userId) => {
    for (const client of clients) {
      if (client.ctx.user.id !== userId) continue;
      try { client.res.end(); } catch { /* уже закрыт */ }
      clients.delete(client);
    }
  },
  onlineCount: () => {
    let n = 0;
    for (const rec of presence.values()) if (rec.conns > 0) n += 1;
    return n;
  },
  serverStats: () => {
    let seated = 0;
    for (const t of tables.values()) seated += t.humans();
    const mem = process.memoryUsage();
    return {
      uptimeSec: Math.round((Date.now() - metrics.startedAt) / 1000),
      connections: clients.size,
      tables: tables.size,
      seated,
      lagMs: lagStats(),
      rssMb: Math.round(mem.rss / 1048576),
      storage: store.stats().storage,
    };
  },
  // Объявление уходит в лобби — пересобираем его сводку сразу.
  announcementChanged: () => { lobbyAt = 0; pushAll(); },
  // Турниры по расписанию: список, разовый турнир, старт сейчас, отмена, боты для проверки.
  extra: async (req, res, route, url, ctx) => {
    if (route === '/api/admin/mtt' && req.method === 'GET') {
      send(res, 200, { list: [...mtts.list.values()].sort((a, b) => a.startAt - b.startAt).map((m) => m.info()) });
      return true;
    }
    if (route !== '/api/admin/mtt' || req.method !== 'POST') return false;
    const body = await readBody(req);
    const by = ctx.user.name;
    if (body.action === 'create') {
      const name = String(body.name || '').trim().slice(0, 40);
      const startAt = Number(body.startAt);
      const buyIn = Math.max(0, Math.round(Number(body.buyIn) || 0));
      const guarantee = Math.max(0, Math.round(Number(body.guarantee) || 0));
      if (!name) { send(res, 400, { error: 'Нужно название' }); return true; }
      if (!Number.isFinite(startAt) || startAt < Date.now() + 60_000) { send(res, 400, { error: 'Старт — не раньше чем через минуту' }); return true; }
      const mtt = mtts.create({ name, startAt, buyIn, guarantee });
      console.log(`Админ ${by}: создан турнир «${name}» на ${new Date(startAt).toISOString()}`);
      send(res, 200, { ok: true, id: mtt.id });
      return true;
    }
    const mtt = mtts.get(String(body.id));
    if (!mtt) { send(res, 404, { error: 'Турнир не найден' }); return true; }
    if (body.action === 'cancel') {
      if (mtt.status !== 'registering' && mtt.status !== 'running') { send(res, 400, { error: 'Турнир уже закончился' }); return true; }
      mtt.cancel('отменён администратором');
      console.log(`Админ ${by}: отменён турнир «${mtt.name}»`);
    } else if (body.action === 'start') {
      if (mtt.status !== 'registering') { send(res, 400, { error: 'Турнир уже идёт' }); return true; }
      if (mtt.entries.size < 2) { send(res, 400, { error: 'Нужно хотя бы два участника' }); return true; }
      mtt.startAt = Date.now();
      mtts.tick();
    } else if (body.action === 'bots') {
      if (mtt.status !== 'registering') { send(res, 400, { error: 'Регистрация закрыта' }); return true; }
      const count = Math.min(50, Math.max(1, Number(body.count) || 5));
      for (let i = 0; i < count; i++) {
        const n = mtt.entries.size + 1;
        const userId = `bot-${crypto.randomUUID()}`;
        mtt.entries.set(userId, { userId, name: `${BOT_NAMES[n % BOT_NAMES.length]}-${n}`, isBot: true });
      }
    } else {
      send(res, 400, { error: 'Неизвестное действие' });
      return true;
    }
    saveSnapshot();
    pushAll();
    send(res, 200, { ok: true });
    return true;
  },
});

// ——— поток событий ———

function openStream(req, res, ctx) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': поток открыт\n\n');

  const client = { res, ctx, lastTable: -1, lastLobby: 0, lastUserVersion: -1, lastRoom: undefined, lastLogId: 0 };
  clients.add(client);

  store.markActive(ctx.user);
  const p = presence.get(ctx.user.id) || { conns: 0, lastSeen: Date.now() };
  p.conns += 1;
  p.lastSeen = Date.now();
  presence.set(ctx.user.id, p);

  pushTo(client, true);

  req.on('close', () => {
    clients.delete(client);
    const rec = presence.get(ctx.user.id);
    if (rec) { rec.conns -= 1; rec.lastSeen = Date.now(); }
  });
}

function emit(client, event, data) {
  emitRaw(client, `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

// Готовая строка события пишется как есть: одна и та же уходит тысячам соединений.
// Если клиент не успевает читать, пропускаем кадр: состояние всё равно
// придёт целиком следующим, а буфер сокета не разрастётся.
function emitRaw(client, frame) {
  if (client.slow) { metrics.skipped += 1; return false; }
  metrics.pushedFrames += 1;
  metrics.pushedBytes += frame.length;
  try {
    if (client.res.write(frame) === false) {
      client.slow = true;
      client.res.once('drain', () => { client.slow = false; });
    }
    return true;
  } catch {
    clients.delete(client);
    return false;
  }
}

function pushTo(client, force = false) {
  const { session, user } = client.ctx;

  // Состояние игрока меняется редко — сравниваем версию, а не собранный JSON.
  const version = store.userVersion(user.id);
  if (version < 0) return;
  if (force || version !== client.lastUserVersion) {
    client.lastUserVersion = version;
    emitRaw(client, store.publicUserFrame(user.id));
  }

  // Турнир по расписанию сам сажает и пересаживает игрока: экран идёт за ним.
  const seatedAt = playerTable.get(user.id);
  if (seatedAt && seatedAt.mttId && session.followTable !== seatedAt.id) {
    session.followTable = seatedAt.id;
    session.roomId = seatedAt.id;
  }

  if (session.roomId) {
    const table = tables.get(session.roomId);
    if (!table) { session.roomId = null; return; }   // стол закрылся, пока игрок думал
    const fresh = force || client.lastRoom !== session.roomId;
    if (!fresh && table.version === client.lastTable) return;

    if (table.frameVersion !== table.version) metrics.serialized += 1;
    // Один и тот же кадр уходит всем зрителям стола, личная часть — только своему месту.
    const seat = table.byUser(user.id);
    if (!emitRaw(client, table.frameFor(seat, session.meter !== false))) return; // повторим в следующий тик
    client.lastTable = table.version;
    client.lastRoom = session.roomId;

    const logFrame = table.logFrameSince(client.lastLogId, fresh);
    if (logFrame) {
      client.lastLogId = table.logSeq;
      emitRaw(client, logFrame);
    }
    return;
  }

  if (force || client.lastLobby !== lobbyVersion || client.lastRoom !== null) {
    client.lastLobby = lobbyVersion;
    client.lastRoom = null;
    client.lastTable = -1;
    emitRaw(client, lobbyFrame);
  }
}

function pushAll() {
  lobbySnapshot();                       // одна сборка на всех зрителей лобби
  for (const client of clients) pushTo(client);
}

// ——— игровой цикл ———

let tickExpected = Date.now() + 250;
let maintainedAt = 0;
let purgedAt = Date.now();

// Обслуживание столов: боты, отвалившиеся игроки, закрытие пустых столов.
// Это перебор всех столов, поэтому он идёт раз в две секунды, а не каждый тик.
function maintain(now) {
  for (const table of tables.values()) {
    if (table.phase === 'idle' && !table.tour) {
      for (const p of table.players()) {
        // Ботам возвращаем стек, чтобы стол не останавливался.
        if (p.isBot && p.stack < table.bb * 10) {
          p.stack = Math.round((table.minBuyIn + table.maxBuyIn) / 2);
          p.sittingOut = false;
          p.busted = false;
          table.maybeStartHand();
        }
      }
    }

    // Игроки без соединения: сначала пропуск раздач, затем выход из-за стола.
    if (table.humans()) {
      for (const p of table.players()) {
        if (p.isBot) continue;
        const rec = presence.get(p.userId);
        if (!rec || rec.conns > 0) continue;
        if (now - rec.lastSeen > 45_000 && !p.sittingOut) table.setSittingOut(p.userId, true);
        if (now - rec.lastSeen > 180_000 && !(table.tour && table.tour.status === 'running')) table.leave(p.userId);
      }
    }
  }

  dropIdleTables(now);
  mtts.tick(now);
  saveSnapshot();
  store.seasonSweep(now);           // в полночь первого числа — итоги сезона

  if (now - purgedAt > 300_000) {
    purgedAt = now;
    store.purgeSessions(now);
    loginGuard.purge(now);
    for (const [userId, rec] of presence) {
      if (rec.conns <= 0 && now - rec.lastSeen > 3_600_000) presence.delete(userId);
    }
  }
}

setInterval(() => {
  const now = Date.now();
  noteLag(Math.max(0, now - tickExpected));
  tickExpected = now + 250;

  // Бюджет на разбор рук: тик не должен превращаться в долгий счёт.
  setEvalBudget(EVAL_PER_TICK);
  for (const table of tables.values()) table.tick(now);

  if (now - maintainedAt >= 2000) {
    maintainedAt = now;
    maintain(now);
  }

  pushAll();
}, 250);

setInterval(() => {
  for (const client of clients) {
    try { client.res.write(': ping\n\n'); } catch { clients.delete(client); }
  }
}, 20_000);

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\nОстановка (${signal}): сохраняем игроков…`);

  // Жёсткий выход ставится первым и не отменяется ожиданием записи:
  // сервер, который перестал принимать соединения, но не умер, — худший исход.
  const hardExit = setTimeout(() => process.exit(0), 5000);
  try {
    server.close();
    for (const client of clients) { try { client.res.end(); } catch { /* уже закрыт */ } }
    clients.clear();
    // Последний снимок столов: после запуска фишки вернутся игрокам в банк.
    snapshot.paused = false;
    saveSnapshot();
    if (bot) bot.stop();
    await store.close();
  } catch (err) {
    console.error('При остановке:', err.message);
  }
  clearTimeout(hardExit);
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, HOST, 1024, () => {
  console.log(`THPoker работает: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Столов открыто: ${tables.size}`);
  if (!bot) {
    console.log('Telegram выключен: не задан TELEGRAM_BOT_TOKEN (см. /etc/night-poker.env)');
    return;
  }
  if (bot.username) console.log(`Вход через Telegram включён для @${bot.username}`);
  // Сеть или Telegram могут быть недоступны в момент запуска — пробуем ещё, пока не выйдет.
  if (TG_WEBHOOK_SECRET) {
    console.log('Telegram-бот: режим вебхука, сообщения принимаются на /api/telegram/webhook');
  }
  // При вебхуке сервер сам не опрашивает Telegram, но если выход к API есть —
  // бот сможет и присылать уведомления.
  const startBot = () => bot.start({ poll: !TG_WEBHOOK_SECRET })
    .then((name) => console.log(`Telegram-бот @${name} на связи, кнопки ведут на ${APP_URL}`))
    .catch((err) => {
      console.error(`Telegram API недоступен: ${err.message}. ${TG_WEBHOOK_SECRET
        ? 'Бот отвечает через вебхук, уведомлений не будет' : 'Новая попытка через 30 с'}`);
      if (!stopping) setTimeout(startBot, TG_WEBHOOK_SECRET ? 600_000 : 30_000);
    });
  startBot();
});
