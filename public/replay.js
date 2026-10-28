'use strict';
// Повтор раздачи по шагам: блайнды, каждый ход, улицы и итог.
// Общий для игры (окно «Последние раздачи») и страницы общей ссылки /h/код.
// Раздача приходит с сервера уже очищенной: чужие карты — только открытые на вскрытии.

const HandReplay = (() => {
  const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
  const ACTION = {
    sb: 'малый блайнд', bb: 'большой блайнд', fold: 'фолд', check: 'чек',
    call: 'колл', bet: 'бет', raise: 'рейз',
  };
  const STREET = { flop: 'Флоп', turn: 'Тёрн', river: 'Ривер' };
  const KIND = { cash: 'кэш-стол', sng: 'sit-n-go', spin: 'спин', mtt: 'турнир' };
  const PLAY_MS = 1100;

  const nf = new Intl.NumberFormat('ru-RU');
  const fmt = (n) => nf.format(Math.round(n || 0));
  const node = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };

  // Карта той же разметки, что и за столом: лицо или рубашка.
  function card(code, small = true) {
    const c = node('div', `card${small ? ' card--sm' : ''}`);
    const inner = node('div', 'card__inner');
    const front = node('div', 'card__face card__front');
    if (code) {
      c.classList.add(`card--${code[1]}`);
      window.CardFace.fill(front, code);
    } else {
      c.classList.add('card--back');
    }
    inner.append(front, node('div', 'card__face card__back'));
    c.append(inner);
    return c;
  }

  const cardText = (code) => `${code[0] === 'T' ? '10' : code[0]}${SUIT[code[1]]}`;

  // Из списка действий — снимки стола после каждого шага.
  function buildSteps(hand) {
    const byName = new Map(hand.players.map((p) => [p.seat, p.name]));
    const seats = new Map(hand.players.map((p) => [p.seat, { stack: p.stack, bet: 0, folded: false, last: null }]));
    let pot = 0;
    const board = [];
    const steps = [];
    const snap = (caption, active = -1, final = false) => steps.push({
      caption, active, final, pot, board: [...board],
      seats: new Map([...seats].map(([k, v]) => [k, { ...v }])),
    });
    const collect = () => {
      for (const s of seats.values()) { pot += s.bet; s.bet = 0; if (!s.folded) s.last = null; }
    };

    const actions = hand.actions || [];
    let i = 0;
    for (; i < actions.length && (actions[i].a === 'sb' || actions[i].a === 'bb'); i++) {
      const a = actions[i];
      const s = seats.get(a.seat);
      s.stack -= a.amt; s.bet = a.to; s.last = ACTION[a.a];
    }
    snap(`Раздача: блайнды ${fmt(hand.sb)}/${fmt(hand.bb)}`);

    for (; i < actions.length; i++) {
      const a = actions[i];
      if (a.a === 'board') {
        collect();
        board.push(...a.cards);
        snap(`${STREET[a.st] || 'Улица'}: ${a.cards.map(cardText).join(' ')}`);
        continue;
      }
      const s = seats.get(a.seat);
      if (!s) continue;
      s.stack -= a.amt || 0;
      s.bet = a.to;
      if (a.a === 'fold') s.folded = true;
      const word = a.a === 'raise' ? `рейз до ${fmt(a.to)}`
        : a.a === 'bet' ? `бет ${fmt(a.to)}` : a.a === 'call' ? `колл ${fmt(a.amt)}` : ACTION[a.a];
      s.last = `${word}${a.allIn ? ' · олл-ин' : ''}`;
      snap(`${byName.get(a.seat)}: ${s.last}`, a.seat);
    }

    // Итог: ставки в банк, у победителей — выигрыш, стеки — как после раздачи.
    collect();
    const winners = hand.players.filter((p) => p.won > 0);
    for (const p of hand.players) {
      const s = seats.get(p.seat);
      s.stack = p.stack + p.net;
      s.won = p.won;
      s.last = p.won > 0 ? `+${fmt(p.won)}` : s.folded ? 'фолд' : p.hand || s.last;
    }
    pot = 0;
    snap(winners.length
      ? winners.map((p) => `${p.name} выигрывает ${fmt(p.won)}${p.hand ? ` — ${p.hand}` : ''}`).join(' · ')
      : 'Раздача окончена', -1, true);
    return steps;
  }

  // Смонтировать повтор в контейнер. opts.onShare — показать кнопку «Поделиться».
  function mount(box, hand, opts = {}) {
    box.textContent = '';
    const steps = buildSteps(hand);
    let at = 0;
    let timer = null;

    const root = node('div', 'replay');
    const head = node('div', 'replay__head');
    head.append(node('b', null, hand.table));
    head.append(node('span', null, `${KIND[hand.kind] || 'стол'} · блайнды ${fmt(hand.sb)}/${fmt(hand.bb)} · `
      + new Date(hand.at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })));
    if (hand.sharedBy) head.append(node('span', 'replay__by', `Поделился ${hand.sharedBy}`));

    const felt = node('div', 'replay__felt');
    const boardBox = node('div', 'replay__board');
    const potBox = node('div', 'replay__pot');
    felt.append(boardBox, potBox);

    const list = node('ul', 'replay__players');
    const caption = node('p', 'replay__caption');

    const controls = node('div', 'replay__controls');
    const btn = (label, title, fn) => {
      const b = node('button', 'btn btn--sm replay__btn', label);
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('click', fn);
      controls.append(b);
      return b;
    };
    const stop = () => { clearInterval(timer); timer = null; play.textContent = '▶'; play.title = 'Воспроизвести'; };
    btn('⏮', 'В начало', () => { stop(); show(0); });
    btn('◀', 'Шаг назад', () => { stop(); show(at - 1); });
    const play = btn('▶', 'Воспроизвести', () => {
      if (timer) { stop(); return; }
      if (at >= steps.length - 1) show(0);
      play.textContent = '❚❚';
      play.title = 'Пауза';
      timer = setInterval(() => { if (at >= steps.length - 1) stop(); else show(at + 1); }, PLAY_MS);
    });
    btn('▶', 'Шаг вперёд', () => { stop(); show(at + 1); }).classList.add('replay__next');
    btn('⏭', 'К итогу', () => { stop(); show(steps.length - 1); });
    const counter = node('span', 'replay__count');
    controls.append(counter);

    // Подпись шага и кнопки прилипают к низу: на телефоне список игроков длинный.
    const foot = node('div', 'replay__foot');
    foot.append(caption, controls);
    if (opts.onShare) {
      const share = node('button', 'btn btn--primary btn--sm replay__share', 'Поделиться раздачей');
      share.type = 'button';
      share.addEventListener('click', () => opts.onShare(hand));
      foot.append(share);
    }
    root.append(head, felt, list, foot);
    box.append(root);

    function show(n) {
      at = Math.max(0, Math.min(steps.length - 1, n));
      const st = steps[at];
      boardBox.textContent = '';
      for (let k = 0; k < 5; k++) boardBox.append(st.board[k] ? card(st.board[k], false) : node('span', 'replay__slot'));
      potBox.textContent = st.pot ? `Банк ${fmt(st.pot)}` : '';
      list.textContent = '';
      for (const p of hand.players) {
        const s = st.seats.get(p.seat);
        const li = node('li', 'replay__player');
        li.classList.toggle('is-active', st.active === p.seat);
        li.classList.toggle('is-folded', s.folded);
        li.classList.toggle('is-winner', st.final && p.won > 0);
        li.classList.toggle('is-me', p.seat === hand.mySeat);
        const who = node('span', 'replay__name', p.name + (p.bot ? ' •' : ''));
        if (p.seat === hand.button) who.prepend(node('i', 'replay__dealer', 'D'));
        const cards = node('span', 'replay__cards');
        // Свои карты видны сразу; открытые на вскрытии чужие — только в итоге.
        const open = p.cards && (p.seat === hand.mySeat || st.final);
        if (!(s.folded && !open)) for (let k = 0; k < 2; k++) cards.append(card(open ? p.cards[k] : null));
        const stack = node('span', 'replay__stack', fmt(s.stack));
        const act = node('span', 'replay__act', s.bet ? `${s.last ? `${s.last} · ` : ''}ставка ${fmt(s.bet)}` : s.last || '');
        li.append(who, cards, stack, act);
        list.append(li);
      }
      caption.textContent = st.caption;
      counter.textContent = `${at + 1} / ${steps.length}`;
    }
    show(0);
    return { stop };
  }

  return { mount };
})();
