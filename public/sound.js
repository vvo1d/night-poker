'use strict';
// Звук синтезируется прямо в браузере: файлов нет, зависимостей тоже.
//
// Чтобы звучало «живо», а не электронно, эффекты строятся по физике предметов:
// короткий удар (щелчок шума) возбуждает несколько резонансов — так звенит
// керамическая фишка или гудит деревянный борт стола; карты — это шелест
// скольжения по сукну. Каждый удар чуть отличается по высоте и силе, а всё
// вместе проходит через лёгкое эхо небольшой комнаты.

const Sound = (() => {
  const KEY = 'night-poker-sound';
  let ctx = null;
  let master = null;   // общий выход
  let dry = null;      // прямой звук
  let wet = null;      // отправка в эхо комнаты
  let noiseBuf = null;
  let enabled = localStorage.getItem(KEY) !== 'off';
  const lastAt = new Map();

  const rand = (a, b) => a + Math.random() * (b - a);
  const resume = () => { if (ctx && ctx.state === 'suspended') Promise.resolve(ctx.resume()).catch(() => {}); };

  // Отклик небольшой комнаты: затухающий шум, чуть приглушённый к хвосту.
  function roomImpulse(seconds = 0.35) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let prev = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // Простейший фильтр низких частот: хвост эха темнее начала.
        const n = Math.random() * 2 - 1;
        prev += (n - prev) * (0.6 - t * 0.45);
        d[i] = prev * (1 - t) ** 3;
      }
    }
    return buf;
  }

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.7;
    // Мягкий компрессор на выходе: когда случайные удары фишек совпадают,
    // пик срезается — без треска и перегруза.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -16;
    limiter.knee.value = 10;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.0005;
    limiter.release.value = 0.12;
    master.connect(limiter).connect(ctx.destination);
    dry = ctx.createGain();
    dry.gain.value = 1;
    dry.connect(master);
    const reverb = ctx.createConvolver();
    reverb.buffer = roomImpulse();
    wet = ctx.createGain();
    wet.gain.value = 0.16;
    wet.connect(reverb).connect(master);
    // Две секунды белого шума — из него собираются удары, шелест и стук.
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    loadSamples();
    return ctx;
  }

  const at = (delay = 0) => ctx.currentTime + delay;

  // Выход эффекта: прямой звук плюс немного в эхо.
  function out(node, send = 1) {
    node.connect(dry);
    if (send > 0) {
      const s = ctx.createGain();
      s.gain.value = send;
      node.connect(s).connect(wet);
    }
  }

  // Отрезок шума с огибающей: attack — нарастание, dur — общая длина.
  function noiseSource(t0, dur) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    // Каждый раз с нового места буфера — иначе одинаковые звуки звучали бы «склеенно».
    src.start(t0, rand(0, 1.5), dur + 0.05);
    return src;
  }

  function envelope(t0, { attack = 0.002, dur = 0.05, gain = 0.3, shape = 'exp' }) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    if (shape === 'exp') g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    else g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
    return g;
  }

  // Удар по твёрдому предмету: короткий щелчок шума возбуждает резонансы
  // (полосовые фильтры с высокой добротностью «звенят» на своей частоте).
  function strike({ delay = 0, modes, gain = 0.4, excite = 0.0025, tone = 4000, send = 1 }) {
    const t0 = at(delay);
    const src = noiseSource(t0, excite);
    const shaper = ctx.createBiquadFilter();
    shaper.type = 'lowpass';
    shaper.frequency.value = tone;
    const env = envelope(t0, { attack: 0.0006, dur: excite, gain: 1 });
    src.connect(shaper).connect(env);
    const bus = ctx.createGain();
    bus.gain.value = gain;
    for (const m of modes) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = m.f;
      bp.Q.value = m.q;
      const mg = ctx.createGain();
      mg.gain.value = m.g;
      env.connect(bp).connect(mg).connect(bus);
    }
    out(bus, send);
  }

  // Шумовой мазок: шелест, скольжение, глухой хлопок.
  function swish({ delay = 0, dur = 0.12, from = 1500, to = 4000, q = 1, gain = 0.2, attack = 0.02, type = 'bandpass', send = 0.6 }) {
    const t0 = at(delay);
    const src = noiseSource(t0, dur);
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(from, t0);
    f.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    f.Q.value = q;
    const env = envelope(t0, { attack, dur, gain });
    src.connect(f).connect(env);
    out(env, send);
  }

  // ——— предметы ———

  // Керамическая фишка о фишку: негармоничный набор частот диска, у каждого удара свой.
  function clack(delay = 0, gain = 0.35) {
    const f = rand(2600, 3600);
    strike({
      delay,
      gain: gain * rand(0.7, 1.1),
      excite: rand(0.0015, 0.003),
      tone: 9000,
      modes: [
        { f, q: rand(22, 34), g: 1 },
        { f: f * 1.59, q: 30, g: 0.7 },
        { f: f * 2.31, q: 36, g: 0.45 },
        { f: f * 3.07, q: 40, g: 0.25 },
      ],
    });
    // Сам щелчок соприкосновения — сухой и очень короткий.
    swish({ delay, dur: 0.006, from: 7000, to: 6000, q: 0.7, gain: gain * 0.35, attack: 0.0006, type: 'highpass', send: 0.2 });
  }

  // Несколько фишек ложатся в стопку: удары чаще и тише к концу.
  function stack(n, delay = 0, gain = 0.32) {
    let t = delay;
    for (let i = 0; i < n; i++) {
      clack(t, gain * (1 - i * 0.07));
      t += rand(0.03, 0.065) * (1 - i * 0.05);
    }
  }

  // ——— записи ———
  // Ставки звучат настоящими записями фишек (Kenney «Casino Audio», CC0):
  // россыпь живых фишек синтезом убедительно не собрать. Записи грузятся
  // один раз при первом звуке; пока не загрузились — играет синтез.
  const SAMPLES = {
    stack: [1, 2, 3, 4, 5, 6].map((n) => `stack-${n}`),
    handle: [1, 2, 3, 4].map((n) => `handle-${n}`),
    allin: ['allin'],
    deal: [1, 2, 3, 4, 5].map((n) => `deal-${n}`),
    flip: [1, 2, 3, 4].map((n) => `flip-${n}`),
    fold: [1, 2, 3].map((n) => `fold-${n}`),
    knock: [1, 2, 3, 4, 5].map((n) => `knock-${n}`),
    fan: ['fan'],
    click: [1, 2, 3, 4].map((n) => `click-${n}`),
  };
  const buffers = {};
  let loading = false;

  function loadSamples() {
    if (loading) return;
    loading = true;
    for (const [group, names] of Object.entries(SAMPLES)) {
      buffers[group] = [];
      for (const name of names) {
        fetch(`/sounds/${name}.wav`)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject()))
          // Старый Safari знает только decodeAudioData с колбэками.
          .then((data) => new Promise((ok, fail) => ctx.decodeAudioData(data, ok, fail)))
          .then((buf) => buffers[group].push(buf))
          .catch(() => {});
      }
    }
  }

  // Случайная запись из группы, чуть разной высоты и громкости — без «пулемёта».
  function sample(group, delay = 0, gain = 0.2) {
    const list = buffers[group];
    if (!list || !list.length) return false;
    const src = ctx.createBufferSource();
    src.buffer = list[Math.floor(Math.random() * list.length)];
    src.playbackRate.value = rand(0.95, 1.05);
    const g = ctx.createGain();
    g.gain.value = gain * rand(0.85, 1.05);
    src.connect(g);
    out(g, 0.3);
    src.start(at(delay));
    return true;
  }

  // Фишки, сдвинутые по сукну: шорох плюс редкие стуки.
  function slide(delay = 0, dur = 0.3, gain = 0.12) {
    swish({ delay, dur, from: 900, to: 1700, q: 0.6, gain, attack: dur * 0.3, send: 0.5 });
    const hits = Math.round(dur / 0.06);
    for (let i = 0; i < hits; i++) clack(delay + dur * 0.2 + i * rand(0.04, 0.07), 0.16);
  }

  // Карта скользит по сукну: щелчок с колоды, шелест, мягкая посадка.
  function card(delay = 0, gain = 1) {
    swish({ delay, dur: 0.004, from: 6000, to: 5000, q: 0.7, gain: 0.12 * gain, attack: 0.0005, type: 'highpass', send: 0.2 });
    swish({ delay: delay + 0.003, dur: rand(0.09, 0.13), from: rand(1800, 2400), to: rand(4200, 5200), q: 0.9, gain: 0.16 * gain, attack: 0.03, send: 0.5 });
    swish({ delay: delay + 0.1, dur: 0.035, from: 380, to: 220, q: 0.8, gain: 0.18 * gain, attack: 0.003, type: 'lowpass', send: 0.4 });
  }

  // Стук костяшками по деревянному борту стола: затухающие частоты дерева
  // (низкий «бум» гаснет дольше высоких) и глухой шлепок удара. Короткий шум
  // такие низкие резонансы не раскачивает, поэтому моды задаём прямо синусами.
  function knock(delay = 0, gain = 0.5) {
    const t0 = at(delay);
    const base = rand(150, 175);
    [[1, 1, 0.11], [2.17, 0.45, 0.06], [4.6, 0.18, 0.03]].forEach(([mul, g, dur]) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      // Дерево после удара чуть «проседает» по высоте.
      osc.frequency.setValueAtTime(base * mul * 1.06, t0);
      osc.frequency.exponentialRampToValueAtTime(base * mul, t0 + 0.02);
      const env = envelope(t0, { attack: 0.0015, dur, gain: gain * 0.5 * g });
      osc.connect(env);
      out(env, 0.8);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    });
    swish({ delay, dur: 0.025, from: 900, to: 300, q: 0.7, gain: gain * 0.35, attack: 0.001, type: 'lowpass', send: 0.3 });
  }

  // Простой тон из первой версии — сигнал «ваш ход». Идёт мимо эха и
  // компрессора, прямо на выход с прежней громкостью 0.5: звучит как раньше.
  function tone({ freq, dur = 0.18, gain = 0.2, delay = 0, attack = 0.008 }) {
    const t0 = at(delay);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(gain * 0.5, t0 + attack);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(amp).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  // Каждый эффект — запись; синтез после «||» звучит, пока записи не загрузились.
  // Только сигнал своего хода остаётся синтезом: это не предмет, а оповещение.
  const EFFECTS = {
    deal: () => sample('deal', 0, 0.11) || card(0, 0.9),
    flip: () => sample('flip', 0, 0.15) || card(0, 0.7),
    check: () => {
      if (sample('knock', 0, 0.22)) sample('knock', 0.13, 0.16);
      else { knock(0, 0.38); knock(0.13, 0.28); }
    },
    fold: () => sample('fold', 0, 0.12) || swish({ dur: 0.2, from: 1200, to: 2600, q: 0.7, gain: 0.13, attack: 0.05 }),
    chips: () => sample('stack') || stack(3),
    raise: () => sample('handle', 0, 0.16) || stack(5),
    allin: () => {
      if (sample('allin', 0, 0.22)) sample('stack', 0.55, 0.16);
      else { slide(0, 0.45, 0.1); stack(8, 0.1, 0.12); }
    },
    pot: () => sample('handle', 0, 0.1) || slide(0, 0.32, 0.12),
    turn: () => { tone({ freq: 660, dur: 0.16, gain: 0.16 }); tone({ freq: 990, dur: 0.22, gain: 0.12, delay: 0.11 }); },
    // Выигрыш: банк сгребают к себе и складывают в стопки.
    win: () => {
      if (sample('allin', 0, 0.2)) { sample('stack', 0.45, 0.16); sample('stack', 0.7, 0.13); }
      else { slide(0, 0.5, 0.14); stack(9, 0.25, 0.26); }
    },
    lose: () => sample('fan', 0, 0.12) || swish({ dur: 0.25, from: 1100, to: 600, q: 0.6, gain: 0.08, attack: 0.04 }),
    click: () => sample('click', 0, 0.07) || swish({ dur: 0.012, from: 3500, to: 2500, q: 1.2, gain: 0.08, attack: 0.001, send: 0 }),
    error: () => {
      if (sample('knock', 0, 0.22)) sample('knock', 0.1, 0.17);
      else { knock(0, 0.22); knock(0.1, 0.18); }
    },
  };

  function play(name, { throttle = 0 } = {}) {
    if (!enabled || !EFFECTS[name]) return;
    const t = performance.now();
    if (throttle && t - (lastAt.get(name) || 0) < throttle) return;
    lastAt.set(name, t);
    if (!ensure()) return;
    resume();
    try { EFFECTS[name](); } catch { /* звук не критичен */ }
  }

  function setEnabled(value) {
    enabled = value;
    localStorage.setItem(KEY, value ? 'on' : 'off');
    if (value) { ensure(); resume(); play('click'); }
  }

  // Браузеры разрешают звук только после действия пользователя.
  const unlock = () => {
    if (enabled) { ensure(); resume(); }
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  return { play, setEnabled, isEnabled: () => enabled };
})();
