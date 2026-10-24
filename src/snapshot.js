'use strict';
// Снимок столов: кто за каким столом и сколько у него фишек. Столы живут
// в памяти, поэтому без снимка перезапуск сервера сжигал бы стеки и взносы.
//
// Снимок пишется раз в пару секунд, после команд, двигающих фишки, и при
// остановке. При запуске фишки из него возвращаются игрокам в банк, столы
// игроков открываются заново пустыми — с теми же адресами и приглашениями.

const fs = require('node:fs');
const path = require('node:path');

const PLAYING = new Set(['preflop', 'flop', 'turn', 'river']);

// Раздача ещё не рассчитана: всё, что игрок в неё вложил, вернётся ему целиком.
// После раздачи банков вложенное уже лежит в стеках победителей.
function handIsLive(table) {
  return PLAYING.has(table.phase) || (table.phase === 'showdown' && table.pendingWinners.length > 0);
}

function tableRecord(table) {
  const live = handIsLive(table);
  const tour = table.tour;
  return {
    id: table.id,
    name: table.name,
    maxSeats: table.maxSeats,
    sb: table.sb,
    bb: table.bb,
    minBuyIn: table.minBuyIn,
    maxBuyIn: table.maxBuyIn,
    timeout: table.timeout,
    house: table.house,
    ownerId: table.ownerId,
    ownerName: table.ownerName,
    createdAt: table.createdAt,
    private: !!table.private,
    invite: table.invite,
    mttId: table.mttId || null,
    sng: tour ? {
      seats: tour.seats,
      buyIn: tour.buyIn,
      status: tour.status,
      paid: tour.places.reduce((sum, p) => sum + p.prize, 0),
    } : null,
    players: table.players().map((p) => ({
      userId: p.userId,
      name: p.name,
      isBot: p.isBot,
      chips: p.stack + (live ? p.contributed : 0),
    })),
  };
}

// Кому сколько вернуть со стола, если он закрывается не по правилам игры:
// перезапуск сервера или администратор закрыл стол.
function refunds(rec) {
  const out = [];
  const humans = rec.players.filter((p) => !p.isBot);
  const sng = rec.sng;
  if (!sng) {
    // Кэш: стек плюс вложенное в недоигранную раздачу.
    for (const p of humans) out.push({ userId: p.userId, amount: p.chips });
  } else if (sng.status === 'registering') {
    // Турнир не начался — возвращаем взносы.
    for (const p of humans) out.push({ userId: p.userId, amount: sng.buyIn });
  } else if (sng.status === 'running') {
    // Турнир оборвался: невыплаченную часть фонда делим по стекам,
    // как делят призы при договорной остановке турнира.
    const left = sng.seats * sng.buyIn - sng.paid;
    const total = rec.players.reduce((s, p) => s + p.chips, 0);
    if (total > 0) for (const p of humans) out.push({ userId: p.userId, amount: Math.floor((left * p.chips) / total) });
  }
  return out.filter((r) => r.amount > 0);
}

class Snapshot {
  constructor(dir) {
    this.file = path.join(dir, 'tables.json');
    this.last = '';
    this.paused = false;   // пока снимок разбирается, новый не пишем — иначе фишки вернутся дважды
  }

  // Запись атомарная: сначала во временный файл, потом переименование.
  // Пишем, только если что-то изменилось.
  // extra — то, что хранится рядом со столами (турниры по расписанию).
  save(tables, extra = {}) {
    if (this.paused) return false;
    const json = JSON.stringify({ savedAt: Date.now(), tables: [...tables.values()].map(tableRecord), ...extra });
    const body = json.slice(json.indexOf(',"tables"'));   // время записи не считается изменением
    if (body === this.last) return false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, this.file);
      this.last = body;
      return true;
    } catch (err) {
      console.error('Не удалось сохранить снимок столов:', err.message);
      return false;
    }
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  // Разбор снимка после запуска: фишки — в банки, столы игроков — обратно.
  // credit(userId, amount) возвращает фишки, reopen(record) открывает стол.
  restore({ credit, reopen }) {
    const snap = this.read();
    if (!snap || !Array.isArray(snap.tables)) return null;
    const sum = { players: 0, chips: 0, tables: 0 };
    const give = (userId, amount) => {
      if (amount <= 0) return;
      credit(userId, amount);
      sum.players += 1;
      sum.chips += amount;
    };

    for (const rec of snap.tables) {
      // Столы турниров по расписанию разбирает сам турнир (см. mttRefunds).
      if (rec.mttId) continue;
      const sng = rec.sng;
      for (const r of refunds(rec)) give(r.userId, r.amount);

      // Стол игрока открываем заново, чтобы ссылка-приглашение продолжала работать.
      // Оборвавшийся или законченный турнир не открываем: его уже не доиграть.
      const reopenable = !rec.house && (!sng || sng.status === 'registering');
      if (reopenable && reopen(rec)) sum.tables += 1;
    }
    sum.snap = snap;
    return sum;
  }

  // Снимок разобран — убираем его, чтобы фишки не вернулись дважды.
  clear() {
    try { fs.rmSync(this.file, { force: true }); } catch { /* не было */ }
    this.last = '';
  }
}

// Турнир по расписанию оборвался перезапуском: невыплаченный фонд делим по стекам
// всех, кто ещё сидел за его столами.
function mttRefunds(snap) {
  const out = [];
  for (const m of snap.mttsRunning || []) {
    const players = snap.tables.filter((t) => t.mttId === m.id).flatMap((t) => t.players);
    const total = players.reduce((s, p) => s + p.chips, 0);
    if (!total) continue;
    for (const p of players) {
      const amount = Math.floor((m.poolLeft * p.chips) / total);
      if (!p.isBot && amount > 0) out.push({ userId: p.userId, amount });
    }
  }
  return out;
}

module.exports = { Snapshot, handIsLive, tableRecord, refunds, mttRefunds };
