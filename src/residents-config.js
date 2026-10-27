'use strict';
// Настройки живых ботов (резидентов). Меняются в админке без перезапуска и
// хранятся в data/residents.json. Схема описывает каждое поле: по ней админка
// рисует форму, а сервер проверяет присланные значения.
//
// Типы полей: bool — да/нет; num — число; pct — проценты 0–100; range — [от, до];
// levels — число на каждый уровень игры (новичок … профи).

const fs = require('node:fs');
const path = require('node:path');

const LEVELS = ['novice', 'amateur', 'regular', 'shark', 'pro'];
const LEVEL_NAMES = { novice: 'Новичок', amateur: 'Любитель', regular: 'Регуляр', shark: 'Акула', pro: 'Профи' };

const SCHEMA = [
  { group: 'Общее', key: 'enabled', type: 'bool', label: 'Резиденты играют', hint: 'Выключили — доигрывают раздачу или турнир и больше не садятся', def: true },
  { group: 'Общее', key: 'online', type: 'range', label: 'Одновременно за столами', min: 0, max: 50, def: [4, 9] },
  { group: 'Общее', key: 'perHumans', type: 'num', label: '+1 к минимуму на каждых N людей в сети', min: 1, max: 50, def: 2 },

  { group: 'Сессии', key: 'sessionMin', type: 'range', label: 'Длина игровой сессии, мин', min: 1, max: 600, def: [10, 40] },
  { group: 'Сессии', key: 'restMin', type: 'range', label: 'Отдых между сессиями, мин', min: 0, max: 1440, def: [5, 30] },
  { group: 'Сессии', key: 'onlineAfterMin', type: 'range', label: 'Остаётся «в сети» после ухода, мин', min: 0, max: 120, def: [3, 10] },
  { group: 'Сессии', key: 'aloneMin', type: 'num', label: 'Ждёт соперников один за столом, мин', min: 1, max: 120, def: 3 },
  { group: 'Сессии', key: 'tickSec', type: 'num', label: 'Как часто кто-то садится, с', min: 1, max: 600, def: 5 },

  { group: 'Выбор стола', key: 'preferHumans', type: 'pct', label: 'Садятся к людям', def: 60 },
  { group: 'Выбор стола', key: 'preferResidents', type: 'pct', label: 'Садятся к другим резидентам', def: 25 },
  { group: 'Выбор стола', key: 'ownTableChance', type: 'pct', label: 'Открывают свой стол, если не нашли', def: 50 },
  { group: 'Выбор стола', key: 'ownTablesMax', type: 'num', label: 'Своих столов одновременно, максимум', min: 0, max: 30, def: 3 },

  { group: 'Столы с людьми', key: 'humanTables', type: 'bool', label: 'Подсаживаются к людям за кэш-столы', def: true },
  { group: 'Столы с людьми', key: 'humanShare', type: 'range', label: 'Занимают мест за столом, %', min: 0, max: 100, def: [35, 65] },
  { group: 'Столы с людьми', key: 'humanJoinSec', type: 'range', label: 'Подсаживаются раз в, с', min: 1, max: 600, def: [8, 25] },

  { group: 'Sit-n-go', key: 'sngJoin', type: 'bool', label: 'Записываются в sit-n-go, где ждёт человек', hint: 'Выключено — свободные места займут боты с пометкой', def: true },

  { group: 'Приглашения', key: 'inviteYes', type: 'pct', label: 'Принимают приглашение друга', def: 80 },
  { group: 'Приглашения', key: 'inviteOffStakes', type: 'pct', label: '…если ставки стола им не по вкусу', def: 45 },

  { group: 'Турниры по расписанию', key: 'mtt', type: 'bool', label: 'Участвуют в турнирах по расписанию', def: true },
  { group: 'Турниры по расписанию', key: 'mttCount', type: 'range', label: 'Записываются на один турнир, человек', min: 0, max: 50, def: [3, 8] },
  { group: 'Турниры по расписанию', key: 'mttRegMin', type: 'num', label: 'Начинают записываться за, мин до старта', min: 1, max: 720, def: 90 },
  { group: 'Турниры по расписанию', key: 'mttNeedHuman', type: 'bool', label: 'Только если уже записался человек', def: false },

  { group: 'Банк и ставки по уровням', key: 'bank', type: 'levels', label: 'Банк нового резидента', min: 0, max: 10_000_000,
    def: { novice: 10_000, amateur: 15_000, regular: 30_000, shark: 45_000, pro: 70_000 } },
  { group: 'Банк и ставки по уровням', key: 'bbMin', type: 'levels', label: 'Любимые ставки: большой блайнд от', min: 1, max: 100_000,
    def: { novice: 2, amateur: 2, regular: 5, shark: 10, pro: 10 } },
  { group: 'Банк и ставки по уровням', key: 'bbMax', type: 'levels', label: 'Любимые ставки: большой блайнд до', min: 1, max: 100_000,
    def: { novice: 10, amateur: 20, regular: 50, shark: 100, pro: 200 } },
];

const clamp = (v, f) => Math.min(f.max ?? 100, Math.max(f.min ?? 0, Math.round(Number(v))));

// Привести одно значение к схеме; негодное — null (тогда остаётся прежнее).
function cleanValue(f, v) {
  if (f.type === 'bool') return typeof v === 'boolean' ? v : null;
  if (f.type === 'num' || f.type === 'pct') return Number.isFinite(Number(v)) && v !== '' && v !== null ? clamp(v, f) : null;
  if (f.type === 'range') {
    if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => Number.isFinite(Number(x)) && x !== '' && x !== null)) return null;
    const [a, b] = v.map((x) => clamp(x, f));
    return [Math.min(a, b), Math.max(a, b)];
  }
  if (f.type === 'levels') {
    if (!v || typeof v !== 'object') return null;
    const out = {};
    for (const l of LEVELS) {
      if (!Number.isFinite(Number(v[l])) || v[l] === '' || v[l] === null) return null;
      out[l] = clamp(v[l], f);
    }
    return out;
  }
  return null;
}

const defaults = () => Object.fromEntries(SCHEMA.map((f) => [f.key, structuredClone(f.def)]));

// Состав: правки отдельных резидентов поверх списка из bot.js — ник, уровень, выключен.
function cleanRoster(raw, known) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) continue;
    const r = raw[key] || {};
    const item = {};
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, 20) : '';
    if (name) item.name = name;
    if (LEVELS.includes(r.style)) item.style = r.style;
    if (r.off === true) item.off = true;
    if (Object.keys(item).length) out[key] = item;
  }
  return out;
}

function createResidentsConfig(dataDir, residentKeys) {
  const file = path.join(dataDir, 'residents.json');
  const known = new Set(residentKeys);
  const settings = defaults();
  let roster = {};

  function apply(raw) {
    const errors = [];
    for (const f of SCHEMA) {
      if (!(f.key in raw)) continue;
      const v = cleanValue(f, raw[f.key]);
      if (v === null) errors.push(f.label);
      else settings[f.key] = v;
    }
    return errors;
  }

  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    apply(saved.settings || {});
    roster = cleanRoster(saved.roster, known);
  } catch { /* настроек ещё нет — значения по умолчанию */ }

  function save() {
    try {
      fs.writeFileSync(file, JSON.stringify({ settings, roster }, null, 2));
    } catch (err) {
      console.error('Не удалось сохранить настройки резидентов:', err.message);
    }
  }

  return {
    settings,                       // живой объект: сервер читает поля при каждом обходе
    roster: () => roster,
    schema: SCHEMA,
    levels: LEVELS,
    levelNames: LEVEL_NAMES,
    // Частичное обновление из админки: неверные поля не трогаем и называем.
    update(raw = {}) {
      const errors = apply(raw);
      save();
      return errors;
    },
    setRoster(raw) {
      roster = cleanRoster(raw, known);
      save();
      return roster;
    },
    reset() {
      Object.assign(settings, defaults());
      save();
    },
  };
}

module.exports = { createResidentsConfig, SCHEMA, LEVELS };
