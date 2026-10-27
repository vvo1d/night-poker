'use strict';
// Боты с характерами. У каждого персонажа свой профиль: сколько рук играет,
// как часто повышает, насколько агрессивен после флопа, блефует ли, держится ли
// за руку и насколько точно считает. Решение строится как у живого игрока:
//
//   до флопа — по силе руки, позиции, числу соперников и тому, было ли повышение;
//   после флопа — по шансам выиграть (Монте-Карло против вероятных рук соперников),
//   цене колла, размеру банка и стеков.
//
// Новичок «считает» грубо и с большим шумом, профи — точно и почти без шума.

const { bestValue, rankOf, suitOf, holeStrength, evaluate, freshDeck } = require('./cards');

// ——— характеры ———

// vpip — доля рук, которые бот играет; pfr — какую часть из них разыгрывает повышением;
// aggr — агрессия после флопа (0…1); bluff — частота блефа; sticky — как держится за
// руку (уравнивает хуже, чем стоило бы); noise — ошибка в оценке шансов; sims — точность счёта;
// limp — входит ли в раздачу простым коллом блайнда.
const STYLES = {
  novice:  { label: 'новичок', vpip: 0.5, pfr: 0.15, aggr: 0.25, bluff: 0.04, sticky: 0.1, noise: 0.14, sims: 0, limp: true, reads: 0 },
  amateur: { label: 'любитель', vpip: 0.38, pfr: 0.35, aggr: 0.4, bluff: 0.07, sticky: 0.1, noise: 0.1, sims: 120, limp: true, reads: 0 },
  regular: { label: 'регуляр', vpip: 0.22, pfr: 0.75, aggr: 0.6, bluff: 0.1, sticky: 0.02, noise: 0.05, sims: 300, limp: false, reads: 0.3 },
  shark:   { label: 'акула', vpip: 0.3, pfr: 0.8, aggr: 0.78, bluff: 0.17, sticky: 0, noise: 0.03, sims: 400, limp: false, reads: 0.5 },
  pro:     { label: 'профи', vpip: 0.25, pfr: 0.8, aggr: 0.7, bluff: 0.12, sticky: 0.02, noise: 0.01, sims: 600, limp: false, reads: 1 },
};

// Персонажи. Сильные уровни носят имена известных игроков в покер — как дань уважения:
// боты никак не связаны с этими людьми и не повторяют их реальную игру (см. BOT_DISCLAIMER).
// Слабые уровни — вымышленные: реального профессионала новичком не изображаем.
const CHARACTERS = [
  { name: 'Ада', style: 'novice', bio: 'Играет почти каждую руку и верит в чудо на ривере' },
  { name: 'Борис', style: 'novice', bio: 'Уравнивает всё — «а вдруг блеф?»' },
  { name: 'Вера', style: 'novice', bio: 'Осторожна, но любит посмотреть флоп' },
  { name: 'Гоша', style: 'novice', bio: 'Олл-ин с любой парой' },
  { name: 'Дина', style: 'amateur', bio: 'Играет по учебнику, ставит только с сильной рукой' },
  { name: 'Ева', style: 'amateur', bio: 'Любит дро и редко сбрасывает' },
  { name: 'Жора', style: 'amateur', bio: 'Блефует, когда скучно' },
  { name: 'Зоя', style: 'amateur', bio: 'Внимательная, но предсказуемая' },
  { name: 'Крис Манимейкер', style: 'regular', bio: 'Мало рук, но играет их жёстко' },
  { name: 'Джонни Чан', style: 'regular', bio: 'Терпеливый — ждёт своего момента' },
  { name: 'Эрик Сайдел', style: 'regular', bio: 'Дисциплинированный, редко ошибается' },
  { name: 'Том Дуан', style: 'shark', bio: 'Давит ставками каждую раздачу' },
  { name: 'Ванесса Селбст', style: 'shark', bio: 'Блефует там, где не ждёшь' },
  { name: 'Фил Хельмут', style: 'shark', bio: 'Охотится на осторожных' },
  { name: 'Антонио Эсфандиари', style: 'shark', bio: 'Любит большие банки' },
  { name: 'Фил Айви', style: 'pro', bio: 'Считает каждую фишку, почти не ошибается' },
  { name: 'Даниэль Негреану', style: 'pro', bio: 'Читает соперников и подстраивается под них' },
  { name: 'Федор Хольц', style: 'pro', bio: 'Сбалансирован — его не прочитать' },
  { name: 'Джастин Бономо', style: 'pro', bio: 'Точен в каждом решении' },
];
// Резиденты — боты, которые живут как обычные игроки: ник, банк, профиль, рейтинг.
// Ключ (key) постоянный — по нему аккаунт находится, даже если ник поменяли.
const RESIDENTS = [
  { key: 'r01', name: 'Алексей_М', style: 'novice' },
  { key: 'r02', name: 'katya_k', style: 'novice' },
  { key: 'r03', name: 'Dimon77', style: 'novice' },
  { key: 'r04', name: 'Ирина', style: 'novice' },
  { key: 'r05', name: 'olegb', style: 'amateur' },
  { key: 'r06', name: 'Тимур', style: 'amateur' },
  { key: 'r07', name: 'NataliaS', style: 'amateur' },
  { key: 'r08', name: 'vlad1990', style: 'amateur' },
  { key: 'r09', name: 'Андрей Н', style: 'amateur' },
  { key: 'r10', name: 'MaxRiver', style: 'regular' },
  { key: 'r11', name: 'lena_p', style: 'regular' },
  { key: 'r12', name: 'Денис', style: 'regular' },
  { key: 'r13', name: 'AceHunter', style: 'shark' },
  { key: 'r14', name: 'Марина', style: 'shark' },
  { key: 'r15', name: 'kostya_nsk', style: 'shark' },
  { key: 'r16', name: 'Сергей К', style: 'shark' },
  { key: 'r17', name: 'Pavel_V', style: 'pro' },
  { key: 'r18', name: 'Grinder', style: 'pro' },
  { key: 'r19', name: 'Ольга', style: 'pro' },
];

const BOT_DISCLAIMER = 'Боты носят имена известных игроков в покер как дань уважения. Они не связаны с этими людьми и не повторяют их реальную игру.';
const BOT_NAMES = CHARACTERS.map((c) => c.name);
const BY_NAME = new Map(CHARACTERS.map((c) => [c.name, c]));

// Уровень бота: задан при посадке или — по имени персонажа (у ботов турнира по расписанию имя «Имя-12»).
function botLevel(p) {
  if (p.botStyle) return p.botStyle;
  const c = BY_NAME.get(String(p.name).replace(/-\d+$/, ''));
  return p.botStyle || (c && c.style) || 'amateur';
}
function styleOf(p) { return STYLES[botLevel(p)]; }

// Сколько бот «думает»: новички — быстро, сильные — дольше на крупных решениях.
function botThinkingTime() { return 300 + Math.random() * 1200; }   // от 0,3 до 1,5 секунды

// ——— сила стартовой руки ———

// Перцентиль руки среди всех 1326 стартовых: 0 — тузы, 1 — худшая. Шкала Чена
// с добором по старшей карте: для порогов «играю топ-25%» этого достаточно.
const HOLE_RANK = (() => {
  const deck = freshDeck();
  const all = [];
  for (let i = 0; i < deck.length; i++) {
    for (let j = i + 1; j < deck.length; j++) {
      const h = [deck[i], deck[j]];
      const hi = Math.max(rankOf(h[0]), rankOf(h[1]));
      const lo = Math.min(rankOf(h[0]), rankOf(h[1]));
      all.push({ key: holeKey(h), score: holeStrength(h) + hi / 1000 + lo / 100000 });
    }
  }
  all.sort((a, b) => b.score - a.score);
  const map = new Map();
  all.forEach((x, i) => { if (!map.has(x.key)) map.set(x.key, i / all.length); });
  return map;
})();

function holeKey(cards) {
  const [a, b] = [...cards].sort((x, y) => rankOf(y) - rankOf(x));
  return `${a[0]}${b[0]}${a[0] === b[0] ? '' : suitOf(a) === suitOf(b) ? 's' : 'o'}`;
}
const holePercent = (cards) => HOLE_RANK.get(holeKey(cards)) ?? 1;

// ——— шансы после флопа: Монте-Карло против вероятных рук ———

// Рука соперника подбирается под его поведение: повышал до флопа — тянем из
// лучших ~25% рук, просто входил — из ~60%, иначе — любая.
function equity(hole, board, opponents, sims) {
  const used = new Set([...hole, ...board]);
  const deck = freshDeck().filter((c) => !used.has(c));
  const need = 5 - board.length;
  const cards = new Array(7);
  let wins = 0;
  for (let s = 0; s < sims; s++) {
    // Перемешиваем только нужную часть колоды (Фишер — Йейтс с начала).
    let top = 0;
    const take = () => {
      const k = top + Math.floor(Math.random() * (deck.length - top));
      const t = deck[k]; deck[k] = deck[top]; deck[top] = t;
      return deck[top++];
    };
    const opp = [];
    for (const width of opponents) {
      let h = null;
      for (let tries = 0; tries < 12; tries++) {
        const save = top;
        const c1 = take(); const c2 = take();
        if (width >= 1 || holePercent([c1, c2]) <= width || tries === 11) { h = [c1, c2]; break; }
        top = save;   // не подошла — вернули карты и пробуем ещё
      }
      opp.push(h);
    }
    const rest = [];
    for (let i = 0; i < need; i++) rest.push(take());
    const full = [...board, ...rest];
    for (let i = 0; i < 5; i++) cards[i] = full[i];
    cards[5] = hole[0]; cards[6] = hole[1];
    const mine = bestValue(cards);
    let best = true;
    let tie = 0;
    for (const h of opp) {
      cards[5] = h[0]; cards[6] = h[1];
      const v = bestValue(cards);
      if (v > mine) { best = false; break; }
      if (v === mine) tie++;
    }
    if (best) wins += tie ? 1 / (tie + 1) : 1;
  }
  return wins / Math.max(1, sims);
}

// Грубая оценка без счёта — так «думает» новичок: по категории комбинации.
const CATEGORY_STRENGTH = [0.14, 0.34, 0.55, 0.68, 0.76, 0.82, 0.9, 0.96, 0.99];
function roughStrength(hole, board) {
  const res = evaluate([...hole, ...board]);
  const category = Math.floor(res.value / 16 ** 5);
  let strength = CATEGORY_STRENGTH[category];
  const usesHole = res.cards.filter((c) => hole.includes(c)).length;
  if (usesHole === 0) strength = Math.min(strength, 0.3);
  if (category === 0) strength = 0.06 + (Math.max(...hole.map(rankOf)) - 2) / 60;
  return Math.max(0.02, Math.min(0.99, strength));
}

// Кто из соперников что делал до флопа — от этого их вероятный диапазон.
function opponentRanges(table, me) {
  const acts = (table.history && table.history.actions) || [];
  const raised = new Set();
  const called = new Set();
  for (const a of acts) {
    if (a.st !== 'preflop') continue;
    if (a.a === 'raise' || a.a === 'bet') raised.add(a.seat);
    if (a.a === 'call') called.add(a.seat);
  }
  return table.inHand().filter((p) => p !== me).map((p) => (raised.has(p.seat) ? 0.25 : called.has(p.seat) ? 0.6 : 1));
}

// Позиция: 0 — ранняя, 1 — баттон. Поздняя позиция позволяет играть шире.
function positionOf(table, p) {
  const order = [];
  let seat = table.buttonSeat;
  for (let i = 0; i < table.maxSeats; i++) {
    seat = (seat + 1) % table.maxSeats;
    const x = table.seats[seat];
    if (x && x.inHand) order.push(x);
  }
  const idx = order.indexOf(p);
  return order.length > 1 ? idx / (order.length - 1) : 1;
}

// Как играет соперник — по памяти стола (Table.learnFrom). Пока рук мало, считаем его «средним».
function readOf(table, opp) {
  const r = table.reads && table.reads.get(opp.name);
  if (!r || r.hands < 15) return null;
  return {
    vpip: r.vpip / r.hands,
    pfr: r.pfr / r.hands,
    aggression: (r.aggro + 1) / (r.passive + 1),            // >2 — часто давит ставками
    foldToBet: r.faced >= 8 ? r.folded / r.faced : 0.45,    // как часто сдаётся на ставку
  };
}

const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;   // ~ −1…1, чаще около 0

// ——— решение ———

function decideBotAction(table, p) {
  const legal = table.legalActions(p);
  if (!legal) return { action: 'fold' };
  const st = styleOf(p);
  const bb = Math.max(1, table.bb);
  const toCall = legal.toCall;
  const pot = Math.max(bb, legal.pot);
  const canRaise = legal.minRaiseTo !== undefined;
  const raiseTo = (total) => ({ action: 'raise', amount: Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, Math.round(total))) });
  const fold = () => (legal.check ? { action: 'check' } : { action: 'fold' });
  const stackBb = (p.stack + p.bet) / bb;
  const pos = positionOf(table, p);
  const players = table.inHand().length;

  if (!table.board.length) return preflop();
  return postflop();

  function preflop() {
    const pct = holePercent(p.cards) + gauss() * st.noise * 0.6;
    // Короткий стек — пуш или фолд: играть «понемногу» уже нечем.
    if (stackBb <= 12 && canRaise) {
      const width = 0.18 + st.vpip * 0.4 + pos * 0.12 + (players <= 3 ? 0.12 : 0);
      if (pct <= width) return raiseTo(legal.maxRaiseTo);
      return toCall <= bb / 2 && legal.call ? { action: 'call' } : fold();
    }
    // Шире на поздних местах и когда за столом мало игроков.
    const shortHanded = players <= 3 ? 1.5 : players <= 5 ? 1.2 : 1;
    const play = Math.min(0.95, st.vpip * (0.75 + pos * 0.5) * shortHanded);
    const raiseRange = play * st.pfr;
    const facingRaise = table.currentBet > bb;
    if (!facingRaise) {
      if (pct <= raiseRange && canRaise) {
        const limpers = table.players().filter((x) => x.inHand && x.bet === bb && x !== p).length;
        return raiseTo((2.5 + Math.max(0, limpers - 1)) * bb);
      }
      if (pct <= play && (st.limp || toCall === 0)) return toCall === 0 ? { action: 'check' } : { action: 'call' };
      return fold();
    }
    // Против повышения: часть сильнейших — перебить, часть — уравнять, остальное — сбросить.
    const price = toCall / Math.max(1, p.stack);
    // Повышает тот, кто повышает много, — значит, у него часто ерунда: защищаемся шире.
    const raiser = table.seats[table.lastAggressorSeat];
    const rr = st.reads && raiser ? readOf(table, raiser) : null;
    const loose = rr ? 1 + st.reads * Math.max(-0.4, Math.min(1, (rr.pfr - 0.15) * 4)) : 1;
    const threeBet = raiseRange * 0.3 * loose;
    const callRange = play * (0.5 + st.sticky * 2) * (price > 0.3 ? 0.4 : 1) * loose;
    if (pct <= threeBet && canRaise) return raiseTo(table.currentBet * 3);
    if (pct <= callRange) return { action: 'call' };
    if (canRaise && Math.random() < st.bluff * 0.25 && pos > 0.6 && price < 0.15) return raiseTo(table.currentBet * 3);
    return fold();
  }

  function postflop() {
    // Шансы: новичок оценивает «на глаз», остальные считают против вероятных рук.
    const key = `${table.handId}:${table.board.length}:${players}`;
    if (!p.eq || p.eq.key !== key) {
      const ranges = opponentRanges(table, p);
      const raw = st.sims ? equity(p.cards, table.board, ranges, st.sims) : roughStrength(p.cards, table.board) ** (1 + (players - 2) * 0.35);
      p.eq = { key, raw };
    }
    const eq = Math.max(0, Math.min(1, p.eq.raw + gauss() * st.noise));
    const potOdds = toCall / (pot + toCall);
    const spr = p.stack / pot;
    const wet = table.board.length < 5;   // впереди ещё карты — дро чего-то стоит
    const aggrRoll = Math.random();

    // Против кого играем: сдаются ли на ставки, давят ли сами.
    const others = table.inHand().filter((x) => x !== p).map((x) => readOf(table, x)).filter(Boolean);
    const avg = (k, d) => (others.length ? others.reduce((sum, r) => sum + r[k], 0) / others.length : d);
    const foldy = st.reads * (avg('foldToBet', 0.45) - 0.45);       // >0 — соперники часто сдаются
    if (toCall === 0) {
      // Ставка на ценность: чем сильнее рука, тем крупнее. Против тех, кто не сдаётся, — тоньше.
      if (eq > 0.62 - st.aggr * 0.12 + Math.min(0, foldy) * 0.3 && canRaise && aggrRoll < 0.35 + st.aggr * 0.6) {
        const size = eq > 0.85 ? 0.75 : eq > 0.72 ? 0.6 : 0.45;
        return raiseTo(p.bet + pot * size);
      }
      // Блеф и полублеф: чаще в позиции, против одного соперника, с дро.
      const bluffChance = st.bluff * (players === 2 ? 1.5 : 0.7) * (pos > 0.5 ? 1.3 : 0.8) * (wet && eq > 0.3 ? 1.6 : 1) * Math.max(0.2, 1 + foldy * 3);
      if (canRaise && eq < 0.45 && Math.random() < bluffChance) return raiseTo(p.bet + pot * 0.55);
      return { action: 'check' };
    }

    // Против ставки.
    const commit = toCall >= p.stack * 0.5 || spr < 1;
    // Ставит любитель давить — ставка значит меньше; ставит пассивный — значит, сильно.
    const bettor = table.seats[table.lastAggressorSeat];
    const br = st.reads && bettor ? readOf(table, bettor) : null;
    const trust = br ? st.reads * Math.max(-0.08, Math.min(0.1, (1.6 - br.aggression) * 0.05)) : 0;
    const need = potOdds - st.sticky + (commit ? 0.05 : 0) + trust;
    if (eq > 0.8 && canRaise && aggrRoll < 0.4 + st.aggr * 0.5) {
      // Сильная рука — повышаем; при маленьком запасе стека — сразу олл-ин.
      return spr < 2.5 ? raiseTo(legal.maxRaiseTo) : raiseTo(table.currentBet * 2.6 + pot * 0.3);
    }
    if (eq >= need) return { action: 'call' };
    if (canRaise && wet && eq > 0.28 && Math.random() < st.bluff * 0.6 && toCall < pot * 0.5) return raiseTo(table.currentBet * 2.8);
    return { action: 'fold' };
  }
}

module.exports = { decideBotAction, botThinkingTime, botLevel, BOT_NAMES, CHARACTERS, RESIDENTS, BOT_DISCLAIMER, STYLES, equity, holePercent };
