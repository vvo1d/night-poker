'use strict';
// Telegram: вход через Telegram, игра внутри Telegram (Mini App) и бот.
//
// Всё включается переменной TELEGRAM_BOT_TOKEN. Без неё сайт работает как
// раньше, а кнопки Telegram просто не показываются. Бот слушает обновления
// длинным опросом — вебхук и отдельный порт не нужны.

const crypto = require('node:crypto');

const AUTH_TTL = 24 * 3600;      // подпись Telegram старше суток не принимаем
const API = 'https://api.telegram.org';

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function fresh(authDate) {
  const age = Date.now() / 1000 - Number(authDate);
  return Number.isFinite(age) && age < AUTH_TTL && age > -300;
}

// Виджет «Войти через Telegram» на сайте: подпись — HMAC от строки полей,
// ключ — SHA-256 от токена бота. https://core.telegram.org/widgets/login
function verifyLogin(data, token) {
  if (!data || typeof data !== 'object' || !data.hash || !data.id) return null;
  const check = Object.keys(data).filter((k) => k !== 'hash' && data[k] !== undefined && data[k] !== null)
    .sort().map((k) => `${k}=${data[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(token).digest();
  const hash = hmac(secret, check).toString('hex');
  if (!safeEqual(hash, String(data.hash)) || !fresh(data.auth_date)) return null;
  return { id: String(data.id), username: data.username || null, firstName: data.first_name || '' };
}

// Mini App: Telegram передаёт initData, ключ — HMAC токена с меткой WebAppData.
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function verifyWebApp(initData, token) {
  if (typeof initData !== 'string' || !initData) return null;
  const params = new URLSearchParams(initData);
  const given = params.get('hash');
  if (!given) return null;
  params.delete('hash');
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = hmac('WebAppData', token);
  const hash = hmac(secret, check).toString('hex');
  if (!safeEqual(hash, given) || !fresh(params.get('auth_date'))) return null;
  let user;
  try { user = JSON.parse(params.get('user')); } catch { return null; }
  if (!user || !user.id) return null;
  return {
    id: String(user.id), username: user.username || null, firstName: user.first_name || '',
    startParam: params.get('start_param') || null,
  };
}

class Bot {
  // appUrl — адрес игры (кнопка «Играть» открывает его внутри Telegram).
  constructor(token, { appUrl = 'https://thpoker.ru', onStart = () => {} } = {}) {
    this.token = token;
    this.appUrl = appUrl.replace(/\/$/, '');
    this.onStart = onStart;
    this.username = null;
    this.offset = 0;
    this.running = false;
  }

  async call(method, body = {}) {
    const res = await fetch(`${API}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(40_000),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`${method}: ${data.description || res.status}`);
    return data.result;
  }

  async start() {
    const me = await this.call('getMe');
    this.username = me.username;
    // Кнопка меню у бота открывает игру как Mini App.
    await this.call('setChatMenuButton', {
      menu_button: { type: 'web_app', text: 'Играть', web_app: { url: `${this.appUrl}/play` } },
    }).catch((err) => console.error('Telegram: кнопку меню поставить не удалось:', err.message));
    await this.call('setMyCommands', {
      commands: [{ command: 'start', description: 'Открыть THPoker' }],
    }).catch(() => {});
    this.running = true;
    this.poll();
    return this.username;
  }

  stop() { this.running = false; }

  // Длинный опрос: сервер Telegram держит запрос до 25 секунд, пока не придут новости.
  async poll() {
    while (this.running) {
      try {
        const updates = await this.call('getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message'] });
        for (const u of updates) {
          this.offset = u.update_id + 1;
          if (u.message) await this.handle(u.message).catch((err) => console.error('Telegram:', err.message));
        }
      } catch (err) {
        if (this.running) console.error('Telegram: опрос не удался:', err.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  async handle(msg) {
    const text = msg.text || '';
    if (!text.startsWith('/start')) return;
    // /start join_КОД — пришли по ссылке-приглашению t.me/бот?start=join_КОД.
    const payload = text.split(' ')[1] || '';
    const code = payload.startsWith('join_') ? payload.slice(5) : null;
    const url = `${this.appUrl}/play${code ? `?join=${encodeURIComponent(code)}` : ''}`;
    this.onStart(msg.from);
    await this.send(msg.chat.id, code
      ? 'Вас зовут за стол в THPoker. Нажмите «Играть» — стол откроется прямо здесь, в Telegram.'
      : 'THPoker — бесплатный покер на виртуальные фишки: техасский холдем, сит-н-гоу и столы с друзьями.\n\n'
        + 'Нажмите «Играть» — игра откроется прямо в Telegram. Бот напишет, когда вас позовут в друзья или начнётся ваш турнир.',
    { text: 'Играть', url });
  }

  // Сообщение с кнопкой, открывающей игру внутри Telegram.
  send(chatId, text, button = null) {
    const body = { chat_id: chatId, text, disable_web_page_preview: true };
    if (button) {
      body.reply_markup = { inline_keyboard: [[{ text: button.text, web_app: { url: button.url } }]] };
    }
    return this.call('sendMessage', body);
  }

  // Уведомление игроку: если он не писал боту, Telegram откажет — это не ошибка.
  notify(chatId, text, path = '/play') {
    return this.send(chatId, text, { text: 'Открыть THPoker', url: `${this.appUrl}${path}` })
      .catch((err) => { if (!/blocked|chat not found|initiate/i.test(err.message)) console.error('Telegram:', err.message); });
  }
}

module.exports = { verifyLogin, verifyWebApp, Bot };
