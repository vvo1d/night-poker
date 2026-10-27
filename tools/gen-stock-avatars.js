'use strict';
// Готовые аватары, которые игрок может выбрать вместо своего фото: 15 мужских
// и 15 женских портретов — лицо, причёска, одежда, аксессуары.
// Рисуем сами (SVG), чтобы не зависеть от чужих лицензий.
// Запуск: node tools/gen-stock-avatars.js → public/stock-avatars/m01.svg … f15.svg

const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'public', 'stock-avatars');

const SKIN = { a: '#f3cfb1', b: '#e3b08a', c: '#c98d64', d: '#9c6646', e: '#6f4530' };
const HAIR = { black: '#1e1b1a', dark: '#3a291f', brown: '#6b4a2f', auburn: '#8e3f26', blond: '#d6ad66', grey: '#9a9a9a', red: '#b5502e' };
// Фон — сдержанные градиенты в тон сукну и латуни интерфейса.
const BG = [
  ['#1f4d4a', '#0f2a2c'], ['#5a2430', '#2b1016'], ['#23395d', '#111c30'], ['#4c5a2a', '#232b12'],
  ['#4a2f57', '#21142a'], ['#3b4650', '#1a2026'], ['#7a5a25', '#38270d'], ['#2e5a3a', '#13291a'],
  ['#5a3a22', '#2a1a0e'], ['#244f63', '#0f2530'], ['#6a2a45', '#2f1020'], ['#3d3d52', '#1b1b26'],
  ['#2d5560', '#132a30'], ['#59452e', '#2a1f12'], ['#463a5e', '#1e182c'],
];
const CLOTH = ['#c9a24a', '#e8e1cf', '#2b2f36', '#8a2a1f', '#3f6e8c', '#4f7a4a', '#7b4b8f', '#d06a3c', '#1d3c4a', '#b8b8b8', '#6b2836', '#2e4d3b', '#a8873a', '#33475b', '#c26d7f'];

// ——— детали ———

const HEAD = (skin, ears = true) => `
  <path d="M112 132 L144 132 L146 178 C138 186 118 186 110 178 Z" fill="${skin}"/>
  <path d="M110 160 C120 170 136 170 146 160 L146 172 C136 180 120 180 110 172 Z" fill="#000" opacity="0.12"/>
  ${ears ? `<ellipse cx="88" cy="114" rx="7" ry="11" fill="${skin}"/>
  <ellipse cx="168" cy="114" rx="7" ry="11" fill="${skin}"/>` : ''}
  <ellipse cx="128" cy="108" rx="41" ry="50" fill="${skin}"/>`;

// Плечи и вырез: обычный, V-вырез, водолазка, худи, рубашка с воротником.
function body(kind, color, skin) {
  const shoulders = `<path d="M24 256 C28 200 76 172 128 172 C180 172 228 200 232 256 Z" fill="${color}"/>`;
  const shade = '<path d="M24 256 C28 214 60 192 92 182 C80 206 76 232 78 256 Z" fill="#000" opacity="0.10"/>';
  const extra = {
    crew: `<path d="M106 174 C114 186 142 186 150 174" fill="none" stroke="#000" stroke-opacity="0.18" stroke-width="5" stroke-linecap="round"/>`,
    vneck: `<path d="M108 172 L128 206 L148 172 Z" fill="${skin}"/><path d="M104 170 L128 210 L152 170" fill="none" stroke="#000" stroke-opacity="0.15" stroke-width="5"/>`,
    turtle: `<path d="M106 160 L150 160 L152 186 C140 194 116 194 104 186 Z" fill="${color}"/><path d="M106 170 L150 170 M106 178 L150 178" stroke="#000" stroke-opacity="0.15" stroke-width="3"/>`,
    hoodie: `<path d="M70 196 C80 170 104 160 128 160 C152 160 176 170 186 196 C170 186 150 182 128 182 C106 182 86 186 70 196 Z" fill="#000" opacity="0.18"/><path d="M118 188 L116 222 M138 188 L140 222" stroke="#f4efe2" stroke-opacity="0.7" stroke-width="3" stroke-linecap="round"/>`,
    collar: `<path d="M108 170 L128 196 L148 170 Z" fill="#f4efe2"/><path d="M104 170 L122 200 L116 206 L96 182 Z M152 170 L134 200 L140 206 L160 182 Z" fill="#f4efe2"/><path d="M124 196 L132 196 L136 236 L128 244 L120 236 Z" fill="${color === '#8a2a1f' ? '#1d3c4a' : '#8a2a1f'}"/>`,
    blazer: `<path d="M108 170 L128 214 L148 170 Z" fill="#f4efe2"/><path d="M100 172 L128 236 L112 256 L86 256 L80 196 Z M156 172 L128 236 L144 256 L170 256 L176 196 Z" fill="#000" opacity="0.22"/>`,
  }[kind] || '';
  return shoulders + shade + extra;
}

// Волосы: back — за головой (длинные), front — поверх головы.
const HAIRS = {
  crop: { front: 'M86 110 C84 68 104 54 128 54 C152 54 172 68 170 110 C164 92 150 82 128 82 C106 82 92 92 86 110 Z' },
  side: { front: 'M86 114 C82 66 108 50 132 50 C158 50 174 70 170 110 C166 92 160 84 150 80 C130 94 104 90 92 102 Z' },
  buzz: { front: 'M88 100 C88 70 104 58 128 58 C152 58 168 70 168 100 C160 84 146 76 128 76 C110 76 96 84 88 100 Z', opacity: 0.85 },
  quiff: { front: 'M86 110 C84 72 100 60 112 58 C110 40 150 34 162 56 C172 66 172 86 170 110 C164 92 150 82 128 82 C106 82 92 92 86 110 Z' },
  curly: { front: 'curly' },
  long: { back: 'M80 108 C76 60 104 46 128 46 C152 46 180 60 176 108 L186 206 C160 220 96 220 70 206 Z', front: 'M86 108 C84 66 106 50 128 50 C150 50 172 66 170 108 C160 84 146 74 128 74 C112 80 98 92 86 108 Z' },
  bob: { back: 'M80 110 C76 62 104 48 128 48 C152 48 180 62 176 110 L178 160 C160 170 96 170 78 160 Z', front: 'M86 104 C84 64 106 50 128 50 C150 50 172 64 170 104 L170 96 C150 90 112 88 86 104 Z' },
  pony: { back: 'M158 76 C200 84 206 150 186 196 C180 156 170 124 154 100 Z', front: 'M86 108 C84 66 106 52 128 52 C150 52 172 66 170 108 C160 86 146 76 128 76 C110 76 96 86 86 108 Z' },
  bun: { back: 'circle:128,50,22', front: 'M86 108 C84 66 106 54 128 54 C150 54 172 66 170 108 C160 86 146 78 128 78 C110 78 96 86 86 108 Z' },
  pixie: { front: 'M86 112 C80 64 108 48 134 50 C160 52 174 72 170 104 C164 94 156 88 146 86 C128 98 102 92 86 112 Z' },
  wavy: { back: 'M78 108 C70 56 104 44 128 44 C152 44 186 56 178 108 C188 140 176 160 190 196 C170 214 150 206 128 210 C106 206 86 214 66 196 C80 160 68 140 78 108 Z', front: 'M86 108 C84 64 108 48 130 48 C154 48 172 66 170 108 C158 80 140 72 124 74 C108 78 94 90 86 108 Z' },
  afro: { back: 'circle:128,96,70', front: '' },
  braid: { back: 'M80 108 C76 60 104 46 128 46 C152 46 180 60 176 108 L174 150 C150 160 106 160 82 150 Z', front: 'M86 106 C84 64 106 50 128 50 C150 50 172 64 170 106 C156 86 140 76 120 78 C104 82 94 92 86 106 Z', braid: true },
  bald: {},
};

function curlyFront(color) {
  const dots = [];
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI * (1.05 + (i / 10) * 0.9);
    dots.push(`<circle cx="${(128 + Math.cos(a) * 40).toFixed(1)}" cy="${(104 + Math.sin(a) * 48).toFixed(1)}" r="14" fill="${color}"/>`);
  }
  dots.push(`<circle cx="112" cy="66" r="14" fill="${color}"/><circle cx="144" cy="66" r="14" fill="${color}"/><circle cx="128" cy="60" r="14" fill="${color}"/>`);
  return dots.join('');
}

function hairLayer(style, color, layer) {
  const h = HAIRS[style];
  const d = h && h[layer];
  if (!d) return '';
  if (d === 'curly') return curlyFront(color);
  if (d.startsWith('circle:')) {
    const [cx, cy, r] = d.slice(7).split(',');
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>`;
  }
  let out = `<path d="${d}" fill="${color}"${h.opacity ? ` opacity="${h.opacity}"` : ''}/>`;
  if (layer === 'back' && h.braid) {
    for (let i = 0; i < 5; i++) out += `<ellipse cx="${86 - i * 2}" cy="${160 + i * 18}" rx="12" ry="11" fill="${color}"/>`;
  }
  return out;
}

const EXTRAS = {
  beard: (c) => `<path d="M88 116 C90 160 110 174 128 174 C146 174 166 160 168 116 C160 138 150 146 128 146 C106 146 96 138 88 116 Z" fill="${c}"/>`,
  stubble: (c) => `<path d="M90 120 C94 158 112 170 128 170 C144 170 162 158 166 120 C158 140 148 150 128 150 C108 150 98 140 90 120 Z" fill="${c}" opacity="0.45"/>`,
  mustache: (c) => `<path d="M110 136 C118 128 126 132 128 134 C130 132 138 128 146 136 C138 140 132 140 128 138 C124 140 118 140 110 136 Z" fill="${c}"/>`,
  glasses: () => '<g fill="none" stroke="#1b1b1b" stroke-width="4"><rect x="96" y="100" width="26" height="18" rx="6"/><rect x="134" y="100" width="26" height="18" rx="6"/><path d="M122 108 L134 108 M96 106 L88 104 M160 106 L168 104"/></g>',
  shades: () => '<g><rect x="94" y="100" width="30" height="18" rx="7" fill="#151515"/><rect x="132" y="100" width="30" height="18" rx="7" fill="#151515"/><path d="M124 106 L132 106" stroke="#151515" stroke-width="4"/><path d="M100 104 L108 104" stroke="#fff" stroke-opacity="0.35" stroke-width="3" stroke-linecap="round"/></g>',
  cap: (c) => `<path d="M84 104 C84 62 106 46 128 46 C150 46 172 62 172 104 Z" fill="${c}"/><path d="M84 100 C112 90 160 92 198 104 C172 112 110 112 84 106 Z" fill="${c}"/><path d="M84 100 C112 90 160 92 198 104" fill="none" stroke="#000" stroke-opacity="0.25" stroke-width="3"/><circle cx="128" cy="48" r="4" fill="#000" opacity="0.25"/>`,
  beanie: (c) => `<path d="M84 100 C82 54 110 40 128 40 C146 40 174 54 172 100 Z" fill="${c}"/><rect x="80" y="88" width="96" height="20" rx="9" fill="${c}"/><path d="M84 98 L172 98" stroke="#000" stroke-opacity="0.18" stroke-width="3"/><circle cx="128" cy="38" r="11" fill="${c}"/>`,
  fedora: (c) => `<ellipse cx="128" cy="78" rx="70" ry="13" fill="${c}"/><path d="M94 78 C94 46 108 38 128 44 C148 38 162 46 162 78 Z" fill="${c}"/><path d="M94 70 L162 70" stroke="#000" stroke-opacity="0.35" stroke-width="7"/>`,
  phones: () => '<path d="M84 112 C80 52 176 52 172 112" fill="none" stroke="#202326" stroke-width="9" stroke-linecap="round"/><rect x="72" y="100" width="20" height="32" rx="8" fill="#202326"/><rect x="164" y="100" width="20" height="32" rx="8" fill="#202326"/><rect x="76" y="106" width="8" height="20" rx="4" fill="#c9a24a"/><rect x="172" y="106" width="8" height="20" rx="4" fill="#c9a24a"/>',
  beret: (c) => `<ellipse cx="136" cy="58" rx="50" ry="17" fill="${c}" transform="rotate(-10 136 58)"/><circle cx="140" cy="40" r="4" fill="${c}"/>`,
  sunhat: (c) => `<ellipse cx="128" cy="70" rx="84" ry="16" fill="${c}"/><path d="M92 70 C92 38 112 30 128 30 C144 30 164 38 164 70 Z" fill="${c}"/><path d="M92 62 L164 62" stroke="#8a2a1f" stroke-width="7"/>`,
  band: (c) => `<path d="M86 84 C104 62 152 62 170 84" fill="none" stroke="${c}" stroke-width="9" stroke-linecap="round"/>`,
  earrings: () => '<circle cx="88" cy="132" r="4" fill="#e8c76a"/><circle cx="168" cy="132" r="4" fill="#e8c76a"/>',
  scarf: (c) => `<path d="M74 120 C70 54 104 36 128 36 C152 36 186 54 182 120 C186 176 160 200 128 202 C96 200 70 176 74 120 Z" fill="${c}"/><path d="M60 212 C84 186 172 186 196 212 L200 256 L56 256 Z" fill="${c}"/>`,
};

// ——— 30 портретов ———
// [кожа, причёска, цвет волос, одежда, вырез, допы]
const MEN = [
  ['a', 'crop', 'dark', 2, 'crew', []],
  ['b', 'side', 'brown', 4, 'collar', []],
  ['c', 'buzz', 'black', 3, 'crew', ['beard']],
  ['a', 'quiff', 'blond', 0, 'blazer', []],
  ['d', 'curly', 'black', 5, 'hoodie', []],
  ['b', 'crop', 'dark', 8, 'vneck', ['stubble', 'glasses']],
  ['a', 'bald', 'grey', 12, 'turtle', ['beard']],
  ['e', 'buzz', 'black', 1, 'crew', ['phones']],
  ['b', 'side', 'auburn', 6, 'collar', ['mustache']],
  ['c', 'crop', 'dark', 10, 'hoodie', ['cap']],
  ['a', 'side', 'grey', 13, 'blazer', ['glasses']],
  ['d', 'crop', 'black', 11, 'crew', ['beanie', 'stubble']],
  ['b', 'quiff', 'brown', 9, 'vneck', ['shades']],
  ['c', 'side', 'dark', 7, 'collar', ['fedora', 'beard']],
  ['e', 'curly', 'black', 14, 'turtle', ['glasses']],
];
const WOMEN = [
  ['a', 'long', 'blond', 14, 'vneck', ['earrings']],
  ['b', 'bob', 'black', 2, 'turtle', []],
  ['c', 'pony', 'dark', 4, 'crew', []],
  ['a', 'wavy', 'auburn', 1, 'blazer', ['earrings']],
  ['d', 'afro', 'black', 7, 'crew', ['earrings']],
  ['b', 'bun', 'brown', 10, 'vneck', ['glasses']],
  ['a', 'pixie', 'red', 12, 'turtle', []],
  ['e', 'braid', 'black', 0, 'crew', []],
  ['b', 'long', 'dark', 6, 'hoodie', ['phones']],
  ['c', 'wavy', 'brown', 3, 'vneck', ['sunhat']],
  ['a', 'bob', 'blond', 8, 'collar', ['beret']],
  ['b', 'long', 'black', 11, 'blazer', ['shades']],
  ['d', 'bald', 'black', 5, 'crew', ['scarf', 'earrings']],
  ['a', 'pony', 'grey', 13, 'turtle', ['glasses']],
  ['c', 'long', 'auburn', 9, 'crew', ['band', 'earrings']],
];

// Лицо: брови цвета волос, глаза с бликом, нос, рот. Выражение — по номеру портрета:
// улыбка, полуулыбка, спокойное, широкая улыбка. У женских — ресницы, губы и румянец.
const MOODS = ['smile', 'half', 'calm', 'grin'];
function face({ hair, female, mood, mouthY = 136, beard = false }) {
  const ink = '#2a1d17';
  const brow = hair === HAIR.blond || hair === HAIR.grey ? '#8a6a45' : hair;
  const browY = mood === 'grin' ? 93 : 95;
  const tilt = mood === 'calm' ? 0 : 2;
  let out = `
  <path d="M100 ${browY + tilt} Q111 ${browY - 5} 122 ${browY}" fill="none" stroke="${brow}" stroke-width="${female ? 3 : 4.5}" stroke-linecap="round"/>
  <path d="M134 ${browY} Q145 ${browY - 5} 156 ${browY + tilt}" fill="none" stroke="${brow}" stroke-width="${female ? 3 : 4.5}" stroke-linecap="round"/>
  <ellipse cx="112" cy="109" rx="5.5" ry="${mood === 'grin' ? 4.5 : 6}" fill="${ink}"/>
  <ellipse cx="144" cy="109" rx="5.5" ry="${mood === 'grin' ? 4.5 : 6}" fill="${ink}"/>
  <circle cx="114" cy="107" r="1.8" fill="#fff" opacity="0.9"/>
  <circle cx="146" cy="107" r="1.8" fill="#fff" opacity="0.9"/>
  <path d="M128 112 Q124 124 126 126 Q128 128 132 126" fill="none" stroke="#000" stroke-opacity="0.22" stroke-width="2.5" stroke-linecap="round"/>`;
  if (female) {
    out += `
  <path d="M105 105 L102 101 M108 103 L106 99 M151 105 L154 101 M148 103 L150 99" stroke="${ink}" stroke-width="2" stroke-linecap="round"/>
  <ellipse cx="102" cy="124" rx="8" ry="5" fill="#e8737a" opacity="0.22"/>
  <ellipse cx="154" cy="124" rx="8" ry="5" fill="#e8737a" opacity="0.22"/>`;
  }
  // Рот — отдельным слоем поверх бороды; на бороде губы светлее, иначе не видно.
  const lips = female ? '#b9505c' : beard ? '#e0a08a' : '#7a3b30';
  const y = mouthY;
  let mouth = '';
  if (mood === 'grin') {
    mouth = `<path d="M114 ${y - 2} Q128 ${y + 14} 142 ${y - 2} Z" fill="#5b2224"/><path d="M116 ${y - 1} Q128 ${y + 4} 140 ${y - 1} L139 ${y + 2} Q128 ${y + 6} 117 ${y + 2} Z" fill="#fff"/>`;
  } else if (mood === 'smile') {
    mouth = `<path d="M115 ${y - 1} Q128 ${y + 10} 141 ${y - 1}" fill="none" stroke="${lips}" stroke-width="${female ? 4 : 3.5}" stroke-linecap="round"/>`;
  } else if (mood === 'half') {
    mouth = `<path d="M117 ${y + 1} Q130 ${y + 6} 141 ${y - 2}" fill="none" stroke="${lips}" stroke-width="${female ? 4 : 3.5}" stroke-linecap="round"/>`;
  } else {
    mouth = `<path d="M119 ${y + 2} Q128 ${y + 5} 137 ${y + 2}" fill="none" stroke="${lips}" stroke-width="${female ? 4 : 3.5}" stroke-linecap="round"/>`;
  }
  return { upper: out, mouth };
}

function portrait(id, [skinKey, hair, hairKey, clothIdx, neck, extras], bgIdx) {
  const skin = SKIN[skinKey];
  const hc = HAIR[hairKey];
  const cloth = CLOTH[clothIdx];
  const [bg1, bg2] = BG[bgIdx % BG.length];
  const acc = (name) => (EXTRAS[name] ? EXTRAS[name](name === 'scarf' || name === 'band' || name === 'beret' || name === 'sunhat' || name === 'beanie' || name === 'cap' || name === 'fedora' ? CLOTH[(clothIdx + 5) % CLOTH.length] : hc) : '');
  const behind = extras.filter((e) => e === 'scarf').map(acc).join('');
  const look = face({
    hair: hc, female: id[0] === 'f', mood: MOODS[(bgIdx * 3 + clothIdx) % MOODS.length],
    mouthY: extras.includes('mustache') ? 143 : 136, beard: extras.includes('beard'),
  });
  const onFace = extras.filter((e) => ['beard', 'stubble', 'mustache', 'earrings'].includes(e)).map(acc).join('');
  const onTop = extras.filter((e) => !['beard', 'stubble', 'mustache', 'earrings', 'scarf'].includes(e)).map(acc).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
<defs><radialGradient id="g${id}" cx="35%" cy="25%" r="90%"><stop offset="0" stop-color="${bg1}"/><stop offset="1" stop-color="${bg2}"/></radialGradient></defs>
<rect width="256" height="256" fill="url(#g${id})"/>
<circle cx="128" cy="118" r="96" fill="#fff" opacity="0.04"/>
${body(neck, cloth, skin)}
${hairLayer(hair, hc, 'back')}
${behind}
${HEAD(skin, !extras.includes('scarf'))}
${look.upper}
${onFace}
${look.mouth}
${hairLayer(hair, hc, 'front')}
${onTop}
</svg>
`;
}

fs.mkdirSync(OUT, { recursive: true });
const list = [];
MEN.forEach((p, i) => { const id = `m${String(i + 1).padStart(2, '0')}`; fs.writeFileSync(path.join(OUT, `${id}.svg`), portrait(id, p, i)); list.push(id); });
WOMEN.forEach((p, i) => { const id = `f${String(i + 1).padStart(2, '0')}`; fs.writeFileSync(path.join(OUT, `${id}.svg`), portrait(id, p, i + 7)); list.push(id); });
console.log(`Готово: ${list.length} аватаров в ${OUT}`);
