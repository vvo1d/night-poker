'use strict';
// Нагрузочный прогон: поднимает N живых соединений, часть сажает за столы
// и снимает показания сервера. Запуск: node tools/loadtest.js [клиентов] [за столом] [секунд]
//
//   node tools/loadtest.js 2000 54 30
//
// Генератор нагрузки жрёт свой процессор, поэтому судить о сервере надо
// по его собственным показателям: задержке игрового цикла и памяти.

const http = require('node:http');

const CLIENTS = Number(process.argv[2]) || 500;
const SEATED = Number(process.argv[3]) || 0;
const SECONDS = Number(process.argv[4]) || 20;
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PASSWORD = 'nagruzka-123';
// Очередь приёма у ядра невелика (kern.ipc.somaxconn), поэтому подключаемся
// пачками: слишком резкий наплыв оборачивается потерянными SYN.
const CONNECT_AT_ONCE = Number(process.env.CONNECT_AT_ONCE) || 32;

// Команды идут через небольшой пул: свободные порты нужны потокам событий.
const agent = new http.Agent({ keepAlive: true, maxSockets: 128 });

function request(method, path, { body, cookie, stream } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: HOST, port: PORT, path, method, agent: stream ? false : agent,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, (res) => {
      if (stream) return resolve(res);
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        const setCookie = res.headers['set-cookie'];
        let data = {};
        try { data = JSON.parse(raw); } catch { /* пустой ответ */ }
        resolve({ status: res.statusCode, data, cookie: setCookie ? setCookie[0].split(';')[0] : null });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Регистрация и вход: тяжёлая часть — проверка пароля, её и меряем.
async function makeUser(n) {
  const name = `нагрузка-${n}`;
  let res = await request('POST', '/api/login', { body: { name, password: PASSWORD } });
  if (res.status !== 200) res = await request('POST', '/api/register', { body: { name, password: PASSWORD } });
  if (res.status !== 200) throw new Error(res.data.error || `статус ${res.status}`);
  return res.cookie;
}

async function pool(count, limit, task) {
  const out = new Array(count);
  let next = 0;
  const workers = new Array(Math.min(limit, count)).fill(0).map(async () => {
    while (next < count) {
      const i = next++;
      try { out[i] = await task(i); } catch (err) { out[i] = { error: err.message }; }
    }
  });
  await Promise.all(workers);
  return out;
}

const stat = { bytes: 0, events: 0, closed: 0, acts: 0 };

const playing = new Map(); // cookie -> занят ли ход прямо сейчас

function openStream(cookie) {
  return request('GET', '/api/stream', { cookie, stream: true }).then((res) => {
    res.on('data', (chunk) => {
      stat.bytes += chunk.length;
      for (let i = 0; i < chunk.length - 1; i++) {
        if (chunk[i] === 10 && chunk[i + 1] === 10) stat.events += 1; // \n\n — конец кадра
      }
      // Сидящие за столом должны ходить, иначе раздачи стоят до таймаута
      // и нагрузка получается ненастоящей.
      if (!playing.has(cookie) || playing.get(cookie)) return;
      const text = chunk.toString('latin1');
      if (!text.includes('"legal":{')) return;
      playing.set(cookie, true);
      const check = text.includes('"check":true');
      request('POST', '/api/cmd', { cookie, body: { cmd: 'act', action: check ? 'check' : 'call' } })
        .catch(() => {})
        .then(() => { playing.set(cookie, false); stat.acts += 1; });
    });
    res.on('error', () => { stat.closed += 1; });
    res.on('end', () => { stat.closed += 1; });
    return res;
  });
}

const fmt = (n) => Number(n).toLocaleString('ru-RU');

(async function main() {
  console.log(`Цель: ${fmt(CLIENTS)} соединений, ${SEATED} за столами, ${SECONDS} с наблюдения`);

  const rooms = (await request('GET', '/api/rooms')).data.rooms || [];

  let t0 = Date.now();
  const cookies = await pool(CLIENTS, 64, makeUser);
  const failed = cookies.filter((c) => !c || c.error).length;
  const loginMs = Date.now() - t0;
  console.log(`Вход: ${fmt(CLIENTS - failed)} из ${fmt(CLIENTS)} за ${fmt(loginMs)} мс `
    + `(${Math.round(((CLIENTS - failed) / loginMs) * 1000)} в секунду)${failed ? `, отказов: ${failed}` : ''}`);

  t0 = Date.now();
  const live = cookies.filter((c) => typeof c === 'string');
  // Подключаемся аккуратно: очередь приёма у ядра не резиновая, и слишком
  // резкий наплыв оборачивается потерянными SYN и долгими повторами.
  await pool(live.length, CONNECT_AT_ONCE, (i) => openStream(live[i]));
  console.log(`Соединения открыты за ${fmt(Date.now() - t0)} мс`);

  // Сажаем людей и подсаживаем ботов: столы должны реально играть,
  // иначе обновлений нет и мерить нечего.
  if (SEATED > 0 && rooms.length) {
    let placed = 0;
    const seatedTables = new Set();
    // Свободное место ищем перебором: сервер сам решает, за какой стол посадить.
    const sitDown = async (cookie, room) => {
      const enter = await request('POST', '/api/cmd', { cookie, body: { cmd: 'enterRoom', roomId: room.id } });
      if (enter.status !== 200) return null;
      const sit = await request('POST', '/api/cmd', { cookie, body: { cmd: 'sit', seat: -1, buyIn: room.minBuyIn } });
      return sit.status === 200 ? enter.data.roomId : null;
    };
    const batch = Math.min(SEATED, live.length);
    const owners = new Map(); // стол -> чьё соединение им «владеет» (кто зовёт ботов)
    await pool(batch, 32, async (i) => {
      const room = rooms[i % rooms.length];
      // Места разбирают наперегонки, поэтому пробуем несколько раз.
      for (let attempt = 0; attempt < 3; attempt++) {
        const tableId = await sitDown(live[i], room);
        if (tableId) {
          placed += 1;
          playing.set(live[i], false); // этот игрок теперь ходит сам
          seatedTables.add(tableId);
          if (!owners.has(tableId)) owners.set(tableId, live[i]);
          return;
        }
      }
    });
    console.log(`За столами: ${placed} человек на ${seatedTables.size} столах`);

    // Подсаживаем ботов: только тогда раздачи идут непрерывно и поток обновлений
    // выходит на рабочий режим.
    let bots = 0;
    const list = [...owners.entries()];
    await pool(list.length, 32, async (i) => {
      const [, cookie] = list[i];
      for (let b = 0; b < 3; b++) {
        const r = await request('POST', '/api/cmd', { cookie, body: { cmd: 'addBot' } });
        if (r.status === 200) bots += 1;
      }
    });
    console.log(`Подсажено ботов: ${bots}`);
    await new Promise((r) => setTimeout(r, 4000)); // ждём, пока раздачи стартуют
  }

  // Снимок берём уже после входа и рассадки — иначе в счёт попадёт разогрев.
  const mark = (await request('GET', '/api/health')).data;
  const startBytes = stat.bytes;
  const t1 = Date.now();
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  const seconds = (Date.now() - t1) / 1000;
  const after = (await request('GET', '/api/health')).data;

  const traffic = (stat.bytes - startBytes) / seconds;
  console.log('');
  console.log('— Сервер —');
  console.log(`соединений:        ${fmt(after.clients)}`);
  console.log(`столов:            ${fmt(after.tables)} (в игре ${fmt(after.tablesActive)}), за столами ${fmt(after.seated)}`);
  console.log(`задержка цикла:    p50 ${after.lagMs.p50} мс, p99 ${after.lagMs.p99} мс, максимум ${after.lagMs.max} мс`);
  console.log(`память:            ${fmt(after.rssMb)} МБ RSS, ${fmt(after.heapMb)} МБ куча`);
  const cpuMs = after.cpuMs - (mark.cpuMs || 0);
  console.log(`процессор:         ${fmt(cpuMs)} мс за ${seconds.toFixed(1)} с наблюдения `
    + `(${Math.round((cpuMs / (seconds * 1000)) * 100)}% ядра)`);
  console.log(`сериализаций:      ${fmt(after.serialized - mark.serialized)} за прогон `
    + `(${Math.round((after.serialized - mark.serialized) / seconds)} в секунду)`);
  console.log(`кадров отправлено: ${fmt(after.pushedFrames - mark.pushedFrames)} `
    + `(${Math.round((after.pushedFrames - mark.pushedFrames) / seconds)} в секунду)`);
  console.log('');
  console.log('— Клиенты —');
  console.log(`получено:          ${(traffic / 1048576).toFixed(2)} МБ/с на всех, `
    + `${Math.round(traffic / Math.max(1, after.clients))} Б/с на соединение`);
  console.log(`событий:           ${fmt(stat.events)}${stat.closed ? `, разорвано соединений: ${stat.closed}` : ''}`);
  console.log(`ходов сделано:     ${fmt(stat.acts)} (${Math.round(stat.acts / seconds)} в секунду)`);
  process.exit(0);
})();
