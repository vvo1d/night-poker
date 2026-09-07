'use strict';
// Звук синтезируется прямо в браузере: файлов нет, зависимостей тоже.
// Каждый эффект — короткая огибающая на осцилляторе или на шуме.

const Sound = (() => {
  const KEY = 'night-poker-sound';
  let ctx = null;
  let master = null;
  let noiseBuf = null;
  let enabled = localStorage.getItem(KEY) !== 'off';
  let lastAt = new Map();

  const resume = () => { if (ctx && ctx.state === 'suspended') Promise.resolve(ctx.resume()).catch(() => {}); };

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    // Секунда белого шума — из неё собираются шелест карт и стук фишек.
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return ctx;
  }

  function now(delay = 0) { return ctx.currentTime + delay; }

  function tone({ freq, to, dur = 0.18, type = 'sine', gain = 0.2, delay = 0, attack = 0.008 }) {
    const t0 = now(delay);
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(amp).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  function noise({ dur = 0.12, freq = 1800, to = 0, q = 0.9, gain = 0.2, delay = 0, type = 'bandpass' }) {
    const t0 = now(delay);
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, t0);
    if (to) filter.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    filter.Q.value = q;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(amp).connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  // Один щелчок фишки: короткий шумовой пик со случайной высотой.
  function clink(delay = 0, gain = 0.16) {
    const f = 2200 + Math.random() * 1400;
    noise({ dur: 0.05, freq: f, to: f * 0.5, q: 5, gain, delay });
    tone({ freq: f * 0.55, dur: 0.05, type: 'triangle', gain: gain * 0.35, delay });
  }

  const EFFECTS = {
    deal: () => noise({ dur: 0.13, freq: 900, to: 3200, q: 0.7, gain: 0.13 }),
    flip: () => { noise({ dur: 0.07, freq: 2600, to: 1200, q: 1.4, gain: 0.12 }); tone({ freq: 520, dur: 0.06, type: 'triangle', gain: 0.06 }); },
    check: () => { tone({ freq: 150, to: 90, dur: 0.14, type: 'sine', gain: 0.26 }); noise({ dur: 0.06, freq: 380, q: 1.2, gain: 0.1 }); },
    fold: () => noise({ dur: 0.22, freq: 2400, to: 420, q: 0.8, gain: 0.11 }),
    chips: () => { clink(0); clink(0.05); clink(0.11, 0.12); },
    raise: () => { clink(0); clink(0.06); clink(0.12); tone({ freq: 330, to: 520, dur: 0.22, type: 'triangle', gain: 0.1, delay: 0.02 }); },
    allin: () => {
      for (let i = 0; i < 6; i++) clink(i * 0.045, 0.14);
      tone({ freq: 220, to: 880, dur: 0.5, type: 'sawtooth', gain: 0.07 });
    },
    pot: () => { for (let i = 0; i < 5; i++) clink(i * 0.06, 0.12); },
    turn: () => { tone({ freq: 660, dur: 0.16, type: 'sine', gain: 0.16 }); tone({ freq: 990, dur: 0.22, type: 'sine', gain: 0.12, delay: 0.11 }); },
    win: () => {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
        tone({ freq: f, dur: 0.55 - i * 0.05, type: 'triangle', gain: 0.16, delay: i * 0.085 });
      });
      for (let i = 0; i < 8; i++) clink(0.15 + i * 0.05, 0.1);
    },
    lose: () => { tone({ freq: 300, to: 180, dur: 0.4, type: 'sine', gain: 0.12 }); },
    click: () => tone({ freq: 720, dur: 0.05, type: 'square', gain: 0.05 }),
    error: () => { tone({ freq: 320, dur: 0.1, type: 'square', gain: 0.09 }); tone({ freq: 220, dur: 0.16, type: 'square', gain: 0.09, delay: 0.09 }); },
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
