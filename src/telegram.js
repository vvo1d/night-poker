'use strict';
// Telegram: вход через Telegram, игра внутри Telegram (Mini App) и бот.
//
// Всё включается переменной TELEGRAM_BOT_TOKEN. Без неё сайт работает как
// раньше, а кнопки Telegram просто не показываются. Бот слушает обновления
// длинным опросом — вебхук и отдельный порт не нужны.

const crypto = require('node:crypto');

const AUTH_TTL = 24 * 3600;      // подпись Telegram старше суток не принимаем
// Адрес Telegram API можно подменить прокси, если хостинг закрывает доступ к Telegram.
const API = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');

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
  constructor(token, { appUrl = 'https://thpoker.ru', username = null, onStart = () => {} } = {}) {
    this.token = token;
    this.appUrl = appUrl.replace(/\/$/, '');
    this.onStart = onStart;
    // Имя бота можно задать заранее: тогда вход через Telegram работает, даже пока API недоступен.
    this.username = username;
    this.offset = 0;
    this.running = false;
  }

  async call(method, body = {}) {
    let res;
    try {
      res = await fetch(`${API}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(40_000),
      });
    } catch (err) {
      // «fetch failed» ничего не объясняет — достаём настоящую причину.
      const cause = err.cause ? (err.cause.code || err.cause.message) : err.message;
      throw new Error(`${method}: нет связи с ${new URL(API).host} (${cause})`);
    }
    const data = await res.json();
    if (!data.ok) throw new Error(`${method}: ${data.description || res.status}`);
    return data.result;
  }

  // poll: true — сами спрашиваем Telegram о новых сообщениях (нужен выход к API).
  // poll: false — режим вебхука: сообщения приносит сам Telegram (см. reply).
  async start({ poll = true } = {}) {
    if (this.running) return this.username;
    const me = await this.call('getMe');
    this.username = me.username;
    // Кнопка меню у бота открывает игру как Mini App.
    await this.call('setChatMenuButton', {
      menu_button: { type: 'web_app', text: 'Играть', web_app: { url: `${this.appUrl}/play` } },
    }).catch((err) => console.error('Telegram: кнопку меню поставить не удалось:', err.message));
    await this.call('setMyCommands', {
      commands: [{ command: 'start', description: 'Открыть THPoker' }],
    }).catch(() => {});
    this.running = true;          // связь с API есть — можно слать уведомления
    if (poll) this.poll();
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
          const answer = this.reply(u);
          if (answer) {
            const { method, ...body } = answer;
            await this.call(method, body).catch((err) => console.error('Telegram:', err.message));
          }
        }
      } catch (err) {
        if (this.running) console.error('Telegram: опрос не удался:', err.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  // Ответ на сообщение — готовый вызов API. При опросе мы его отправляем сами,
  // при вебхуке он уходит телом ответа на запрос Telegram: выход к API не нужен.
  reply(update) {
    const msg = update && update.message;
    const text = (msg && msg.text) || '';
    if (!text.startsWith('/start')) return null;
    // /start join_КОД — пришли по ссылке-приглашению t.me/бот?start=join_КОД.
    const payload = text.split(' ')[1] || '';
    const code = payload.startsWith('join_') ? payload.slice(5) : null;
    const url = `${this.appUrl}/play${code ? `?join=${encodeURIComponent(code)}` : ''}`;
    console.log(`Telegram: /start от ${msg.from.username ? `@${msg.from.username}` : msg.from.id}${code ? ` по приглашению ${code}` : ''}`);
    this.onStart(msg.from);
    return {
      method: 'sendMessage',
      ...this.message(msg.chat.id, code
        ? 'Вас зовут за стол в THPoker. Нажмите «Играть» — стол откроется прямо здесь, в Telegram.'
        : 'THPoker — бесплатный покер на виртуальные фишки: техасский холдем, сит-н-гоу и столы с друзьями.\n\n'
          + 'Нажмите «Играть» — игра откроется прямо в Telegram.',
      { text: 'Играть', url }),
    };
  }

  // Сообщение с кнопкой, открывающей игру внутри Telegram.
  message(chatId, text, button = null) {
    const body = { chat_id: chatId, text, disable_web_page_preview: true };
    if (button) {
      body.reply_markup = { inline_keyboard: [[{ text: button.text, web_app: { url: button.url } }]] };
    }
    return body;
  }

  send(chatId, text, button = null) {
    return this.call('sendMessage', this.message(chatId, text, button));
  }

  // Уведомление игроку: если он не писал боту, Telegram откажет — это не ошибка.
  notify(chatId, text, path = '/play') {
    return this.send(chatId, text, { text: 'Открыть THPoker', url: `${this.appUrl}${path}` })
      .catch((err) => { if (!/blocked|chat not found|initiate/i.test(err.message)) console.error('Telegram:', err.message); });
  }
}

module.exports = { verifyLogin, verifyWebApp, Bot };
