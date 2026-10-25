'use strict';
// Магазин оформления: рубашки карт, цвет сукна и рамки аватара за фишки.
// Ничего из этого не влияет на игру. Рубашка и сукно — только для самого
// игрока, рамку видят все за столом. Как выглядит предмет, знает клиент
// (по id), здесь — названия и цены.

const CATALOG = [
  { id: 'back-classic', kind: 'back', name: 'Синяя классика', price: 0 },
  { id: 'back-crimson', kind: 'back', name: 'Бордовая', price: 1500 },
  { id: 'back-emerald', kind: 'back', name: 'Изумрудная', price: 1500 },
  { id: 'back-graphite', kind: 'back', name: 'Графит', price: 2500 },
  { id: 'back-gold', kind: 'back', name: 'Золотая', price: 5000 },

  { id: 'felt-green', kind: 'felt', name: 'Зелёное сукно', price: 0 },
  { id: 'felt-blue', kind: 'felt', name: 'Синее сукно', price: 2000 },
  { id: 'felt-burgundy', kind: 'felt', name: 'Бордовое сукно', price: 2000 },
  { id: 'felt-graphite', kind: 'felt', name: 'Графитовое сукно', price: 3000 },
  { id: 'felt-violet', kind: 'felt', name: 'Фиолетовое сукно', price: 4000 },

  { id: 'frame-none', kind: 'frame', name: 'Без рамки', price: 0 },
  { id: 'frame-silver', kind: 'frame', name: 'Серебро', price: 3000 },
  { id: 'frame-gold', kind: 'frame', name: 'Золото', price: 8000 },
  { id: 'frame-neon', kind: 'frame', name: 'Неон', price: 12000 },
  { id: 'frame-fire', kind: 'frame', name: 'Пламя', price: 20000 },
];

const BY_ID = new Map(CATALOG.map((item) => [item.id, item]));
const KINDS = ['back', 'felt', 'frame'];
const DEFAULTS = Object.fromEntries(KINDS.map((k) => [k, CATALOG.find((i) => i.kind === k && i.price === 0).id]));

function item(id) { return BY_ID.get(String(id)) || null; }

// Что у игрока есть и что надето. Бесплатные предметы есть у всех.
function view(user) {
  const shop = user.meta.shop || {};
  return {
    owned: [...new Set([...CATALOG.filter((i) => !i.price).map((i) => i.id), ...(shop.owned || [])])],
    equip: { ...DEFAULTS, ...(shop.equip || {}) },
  };
}

module.exports = { CATALOG, KINDS, DEFAULTS, item, view };
