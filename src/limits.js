'use strict';
// Защита входа от подбора пароля: неудачные попытки считаются отдельно по IP
// и по имени игрока. Пять неудач подряд — пауза, каждая следующая длиннее.
// Ещё здесь ограничение регистраций с одного IP: иначе можно наплодить
// аккаунтов ради стартовых фишек.

const FAILS_ALLOWED = 5;               // столько неудач подряд можно без паузы
const LOCK_MS = 5 * 60_000;            // первая пауза
const LOCK_MAX_MS = 60 * 60_000;       // дольше часа не держим
const FORGET_MS = 30 * 60_000;         // через полчаса тишины счётчик обнуляется

const REGISTER_PER_IP = 5;             // регистраций с одного IP
const REGISTER_WINDOW_MS = 60 * 60_000;

class LoginGuard {
  constructor() {
    this.fails = new Map();     // ключ -> { count, lockedUntil, locks, last }
    this.registers = new Map(); // ip -> [время регистрации…]
  }

  // Сколько ещё ждать по этому ключу, мс. 0 — можно пробовать.
  waitFor(key, now = Date.now()) {
    const rec = this.fails.get(key);
    return rec && rec.lockedUntil > now ? rec.lockedUntil - now : 0;
  }

  // Проверка перед попыткой входа: заперт либо IP, либо имя.
  check(ip, name, now = Date.now()) {
    return Math.max(this.waitFor(`ip:${ip}`, now), this.waitFor(`name:${name}`, now));
  }

  failed(ip, name, now = Date.now()) {
    for (const key of [`ip:${ip}`, `name:${name}`]) {
      let rec = this.fails.get(key);
      if (!rec || now - rec.last > FORGET_MS) rec = { count: 0, lockedUntil: 0, locks: 0, last: now };
      rec.count += 1;
      rec.last = now;
      if (rec.count >= FAILS_ALLOWED) {
        // Каждая новая пауза вдвое длиннее прошлой.
        rec.lockedUntil = now + Math.min(LOCK_MAX_MS, LOCK_MS * 2 ** rec.locks);
        rec.locks += 1;
        rec.count = 0;
      }
      this.fails.set(key, rec);
    }
  }

  // Удачный вход снимает счётчик с имени. С IP — тоже: за одним IP бывает
  // целая семья или офис, и чужие ошибки не должны их запирать надолго.
  succeeded(ip, name) {
    this.fails.delete(`ip:${ip}`);
    this.fails.delete(`name:${name}`);
  }

  canRegister(ip, now = Date.now()) {
    const recent = (this.registers.get(ip) || []).filter((t) => now - t < REGISTER_WINDOW_MS);
    this.registers.set(ip, recent);
    if (recent.length < REGISTER_PER_IP) return 0;
    return recent[0] + REGISTER_WINDOW_MS - now;
  }

  registered(ip, now = Date.now()) {
    const list = this.registers.get(ip) || [];
    list.push(now);
    this.registers.set(ip, list);
  }

  // Старые записи не копятся в памяти.
  purge(now = Date.now()) {
    for (const [key, rec] of this.fails) {
      if (rec.lockedUntil < now && now - rec.last > FORGET_MS) this.fails.delete(key);
    }
    for (const [ip, list] of this.registers) {
      if (!list.some((t) => now - t < REGISTER_WINDOW_MS)) this.registers.delete(ip);
    }
  }
}

// «через 4 мин», «через 40 с»
function waitText(ms) {
  const sec = Math.ceil(ms / 1000);
  return sec >= 60 ? `${Math.ceil(sec / 60)} мин` : `${sec} с`;
}

module.exports = { LoginGuard, waitText };
