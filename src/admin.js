'use strict';
// Админ-панель: обзор и аналитика, игроки, столы, объявление для всех.
// Доступ — по номерам игроков (ID в профиле) в ADMIN_IDS через запятую: это
// владельцы, они же назначают других администраторов прямо в админке (meta.admin).
// Ники меняются, номера — нет, поэтому права привязаны к номеру.
// Пока ADMIN_IDS не задан, работает прежний ADMIN_NAMES (по нику) — эти ники
// никто другой занять не может. Всё, что делает администратор, пишется в журнал
// сервера и в историю игрока.

const fs = require('node:fs');
const path = require('node:path');
const analytics = require('./analytics');
const { tableRecord, refunds } = require('./snapshot');
const seasons = require('./seasons');

const ADMIN_IDS = new Set(String(process.env.ADMIN_IDS || '')
  .split(',').map((s) => Number(s.trim().replace(/^#/, ''))).filter((n) => n > 0));
const ADMIN_NAMES = new Set(String(process.env.ADMIN_NAMES || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

// Владелец — из ADMIN_IDS (или, пока его нет, из ADMIN_NAMES): его права не снять из админки.
function isOwner(user) {
  if (!user) return false;
  if (ADMIN_IDS.size) return ADMIN_IDS.has(user.meta && user.meta.pid);
  return ADMIN_NAMES.has(user.name.toLowerCase());
}

function isAdmin(user) {
  return !!user && (isOwner(user) || !!(user.meta && user.meta.admin));
}

// deps — то, чем владеет сервер: столы, присутствие, метрики, отправка ответа.
function createAdmin(deps) {
  const { store, tables, send, readBody, requireAuth } = deps;
  if (ADMIN_IDS.size) {
    console.log(`Администраторы по номерам: ${[...ADMIN_IDS].join(', ')}`);
  } else if (ADMIN_NAMES.size) {
    // Ники из ADMIN_NAMES закрыты для всех: иначе их можно было бы занять сменой ника.
    store.reservedNames = new Set(ADMIN_NAMES);
    console.log('Администраторы заданы по нику (ADMIN_NAMES) — лучше перейти на ADMIN_IDS: номера игроков не меняются');
  }
  const announceFile = path.join(store.dataDir, 'announcement.json');
  let announcement = null;
  try { announcement = JSON.parse(fs.readFileSync(announceFile, 'utf8')); } catch { /* объявления нет */ }

  function saveAnnouncement() {
    try {
      if (announcement) fs.writeFileSync(announceFile, JSON.stringify(announcement));
      else fs.rmSync(announceFile, { force: true });
    } catch (err) {
      console.error('Не удалось сохранить объявление:', err.message);
    }
  }

  function lastDay(u) {
    const days = (u.meta && u.meta.days) || [];
    return days[days.length - 1] || null;
  }

  function userRow(u) {
    const where = deps.tableOfUser(u.id);
    return {
      pid: u.meta && u.meta.pid,
      name: u.name,
      avatar: store.avatarUrl(u),
      admin: isAdmin(u),
      owner: isOwner(u),
      chips: u.chips,
      hands: u.handsPlayed,
      createdAt: u.createdAt,
      lastDay: lastDay(u),
      source: (u.meta && u.meta.source) || null,
      telegram: u.tg ? (u.tg.username ? `@${u.tg.username}` : 'да') : null,
      vk: u.meta && u.meta.vk ? u.meta.vk.name || 'да' : null,
      guest: store.isGuest(u),
      resident: store.isBotUser(u),
      banned: !!(u.meta && u.meta.banned),
      online: deps.isOnline(u.id),
      table: where ? where.name : null,
      season: seasons.view(u).points,
    };
  }

  function userDetail(u) {
    return {
      ...userRow(u),
      password: !!u.hash,
      banInfo: (u.meta && u.meta.banned) || null,
      stats: u.stats,
      friends: u.friends.length,
      log: ((u.meta && u.meta.log) || []).slice().reverse(),
      days: ((u.meta && u.meta.days) || []).length,
      oldNames: ((u.meta && u.meta.oldNames) || []).slice().reverse(),
    };
  }

  // Игрок по номеру («12», «#12», «ID 12») или по нику.
  function findUser(q) {
    const s = String(q || '').trim();
    const m = s.match(/^(?:id\s*)?#?(\d+)$/i);
    return (m && store.byPidNumber(Number(m[1]))) || store.byNameLower(s);
  }

  // Принудительно закрыть стол: фишки — в банки по тем же правилам, что при перезапуске.
  function closeTable(table, by) {
    const rec = tableRecord(table);
    for (const r of refunds(rec)) {
      store.addChips(r.userId, r.amount, `Стол «${table.name}» закрыт администратором`);
      const u = store.user(r.userId);
      if (u) store.adminNote(u, by, `стол «${table.name}» закрыт администратором, возвращено ${r.amount}`);
    }
    for (const p of table.players()) {
      table.seats[p.seat] = null;
      table.byUserId.delete(p.userId);
      table.onUnseat(p, table);
    }
    deps.dropTable(table);
    // Стол заведения нужен всегда — открываем его заново пустым.
    if (table.house) deps.reopenHouse(table.id);
    console.log(`Админ ${by}: закрыт стол «${table.name}» (${table.id})`);
  }

  function tableRow(t) {
    return {
      id: t.id,
      name: t.name,
      kind: t.tour ? (t.mttId ? 'mtt' : 'sng') : 'cash',
      house: t.house,
      private: !!t.private,
      owner: t.ownerName,
      blinds: `${t.sb}/${t.bb}`,
      phase: t.phase,
      status: t.tour ? t.tour.status : null,
      players: t.players().map((p) => ({ name: p.name, bot: p.isBot && !p.resident, resident: !!p.resident, stack: p.stack, away: p.sittingOut })),
      maxSeats: t.maxSeats,
    };
  }

  // Возвращает true, если запрос был к админке и на него уже ответили.
  async function handle(req, res, route, url) {
    if (!route.startsWith('/api/admin/')) return false;
    const ctx = requireAuth(req, res);
    if (!ctx) return true;
    if (!isAdmin(ctx.user)) { send(res, 403, { error: 'Только для администратора' }); return true; }
    const by = ctx.user.name;

    if (route === '/api/admin/overview' && req.method === 'GET') {
      const report = analytics.report(store.users.values(), {
        online: deps.onlineCount(),
        handsByDay: deps.handsByDay,
      });
      send(res, 200, { ...report, server: deps.serverStats(), announcement });
      return true;
    }

    if (route === '/api/admin/users' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const sort = url.searchParams.get('sort') || 'recent';
      let list = [...store.users.values()];
      const num = q.match(/^(?:id\s*)?#?(\d+)$/i);
      if (num) list = list.filter((u) => u.meta.pid === Number(num[1]) || u.name.toLowerCase().includes(q));
      else if (q) list = list.filter((u) => u.name.toLowerCase().includes(q) || (u.tg && u.tg.username && u.tg.username.toLowerCase().includes(q)));
      const by = {
        recent: (a, b) => (lastDay(b) || '').localeCompare(lastDay(a) || '') || b.createdAt - a.createdAt,
        new: (a, b) => b.createdAt - a.createdAt,
        chips: (a, b) => b.chips - a.chips,
        hands: (a, b) => b.handsPlayed - a.handsPlayed,
      }[sort] || ((a, b) => b.createdAt - a.createdAt);
      list.sort(by);
      send(res, 200, { total: list.length, users: list.slice(0, 100).map(userRow) });
      return true;
    }

    if (route === '/api/admin/user' && req.method === 'GET') {
      const u = findUser(url.searchParams.get('name'));
      if (!u) { send(res, 404, { error: 'Игрок не найден' }); return true; }
      send(res, 200, userDetail(u));
      return true;
    }

    if (route === '/api/admin/user' && req.method === 'POST') {
      const body = await readBody(req);
      const u = body.pid ? store.byPidNumber(body.pid) : store.byNameLower(body.name);
      if (!u) { send(res, 404, { error: 'Игрок не найден' }); return true; }
      // Удаление насовсем: сначала — из-за стола, турниров и потока, потом — из базы.
      if (body.action === 'delete') {
        if (u.id === ctx.user.id) { send(res, 400, { error: 'Себя удалить нельзя' }); return true; }
        if (store.isBotUser(u)) { send(res, 400, { error: 'Это резидент — выключите его во вкладке «Резиденты»' }); return true; }
        deps.forgetUser(u.id);
        deps.removeAvatar(u.id);
        const result = await store.deleteUser(u.id);
        if (result.error) { send(res, 400, result); return true; }
        console.log(`Админ ${by}: удалён игрок «${result.name}»`);
        deps.pushAll();
        send(res, 200, { ok: true, deleted: result.name });
        return true;
      }
      let result;
      switch (body.action) {
        case 'chips':
          result = store.adjustChips(u.id, body.amount, by, String(body.reason || '').slice(0, 100));
          break;
        case 'ban': {
          if (u.id === ctx.user.id) { result = { error: 'Себя заблокировать нельзя' }; break; }
          result = store.ban(u.id, by, body.reason);
          // Из-за стола — сразу, поток — закрыть.
          const table = deps.tableOfUser(u.id);
          if (table) table.leave(u.id);
          deps.dropStreams(u.id);
          break;
        }
        case 'unban':
          result = store.unban(u.id, by);
          break;
        case 'password': {
          const pass = String(body.password || '');
          if (pass.length < 6) { result = { error: 'Пароль — минимум 6 символов' }; break; }
          result = await store.setPassword(u.id, pass, by);
          break;
        }
        case 'unlinkVk':
          // Без пароля и Telegram отвязать нельзя: игрок останется без входа — сначала задайте пароль.
          result = await store.unlinkVk(u.id, '', by);
          if (result.needPassword) result = { error: 'У игрока нет пароля — сначала задайте ему пароль, затем отвяжите VK' };
          break;
        case 'avatar': {
          if (!deps.removeAvatar(u.id)) { result = { error: 'Аватара нет' }; break; }
          store.adminNote(u, by, 'аватар удалён');
          result = { ok: true };
          break;
        }
        case 'rename': {
          result = store.renameUser(u.id, body.newName, by);
          if (!result.error) deps.afterRename(u.id);
          break;
        }
        case 'admin': {
          // Назначать и снимать администраторов может только владелец (ADMIN_IDS).
          if (!isOwner(ctx.user)) { result = { error: 'Назначать администраторов может только владелец (ADMIN_IDS)' }; break; }
          if (isOwner(u)) { result = { error: 'Права владельца задаются в ADMIN_IDS на сервере' }; break; }
          if (body.on) u.meta.admin = true; else delete u.meta.admin;
          store.adminNote(u, by, body.on ? 'назначен администратором' : 'снят с администраторов');
          result = { ok: true };
          break;
        }
        case 'kick': {
          const table = deps.tableOfUser(u.id);
          if (!table) { result = { error: 'Игрок не за столом' }; break; }
          result = table.leave(u.id);
          if (!result.error) store.adminNote(u, by, `убран из-за стола «${table.name}»`);
          break;
        }
        default:
          result = { error: 'Неизвестное действие' };
      }
      deps.pushAll();
      if (result.error) send(res, 400, result);
      else send(res, 200, { ...result, user: userDetail(u) });
      return true;
    }

    if (route === '/api/admin/tables' && req.method === 'GET') {
      send(res, 200, { tables: [...tables.values()].map(tableRow) });
      return true;
    }

    if (route === '/api/admin/table' && req.method === 'POST') {
      const body = await readBody(req);
      const table = tables.get(String(body.id));
      if (!table) { send(res, 404, { error: 'Стол уже закрыт' }); return true; }
      if (body.action === 'close' && table.mttId) {
        send(res, 400, { error: 'Это стол турнира по расписанию — отмените турнир целиком во вкладке «Турниры»' });
        return true;
      }
      if (body.action === 'close') {
        closeTable(table, by);
        deps.saveSnapshot();
        deps.pushAll();
        send(res, 200, { ok: true });
        return true;
      }
      send(res, 400, { error: 'Неизвестное действие' });
      return true;
    }

    if (route === '/api/admin/announce' && req.method === 'POST') {
      const body = await readBody(req);
      const text = String(body.text || '').trim().slice(0, 300);
      announcement = text ? { text, at: Date.now(), by } : null;
      saveAnnouncement();
      deps.announcementChanged();
      console.log(`Админ ${by}: ${text ? `объявление «${text}»` : 'объявление снято'}`);
      send(res, 200, { ok: true, announcement });
      return true;
    }

    // Дальше — разделы, которые подключают другие модули (турниры).
    if (deps.extra && await deps.extra(req, res, route, url, ctx)) return true;

    send(res, 404, { error: 'Такого адреса нет' });
    return true;
  }

  return { handle, isAdmin, isOwner, getAnnouncement: () => announcement };
}

module.exports = { createAdmin, isAdmin, isOwner };
