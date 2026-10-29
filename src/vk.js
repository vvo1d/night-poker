'use strict';
// Вход через VK ID (id.vk.com): OAuth 2.1 с PKCE.
//
// Запасной путь (переходом по ссылке):
// 1. /auth/vk — запоминаем state и code_verifier и уводим игрока на id.vk.com/authorize.
// 2. VK возвращает на /auth/vk/callback с code и device_id.
// 3. Сервер меняет code на access_token (id.vk.com/oauth2/auth) и берёт имя и аватар
//    (id.vk.com/oauth2/user_info). Токен нигде не хранится — он нужен только на этот вход.
//
// Основной путь теперь — виджет VK ID One Tap (public/app.js): код на токены меняет
// браузер игрока, а сервер получает только id_token и проверяет его у VK через
// oauth2/public_info (verifyIdToken). Токен доступа к нашему серверу не попадает.
// Переход /auth/vk остаётся запасным — если скрипт VK не загрузился.
//
// Включается переменной VK_CLIENT_ID (ID приложения в кабинете VK ID).

const crypto = require('node:crypto');

const AUTHORIZE = 'https://id.vk.com/authorize';
const TOKEN = 'https://id.vk.com/oauth2/auth';
const USER_INFO = 'https://id.vk.com/oauth2/user_info';
const PUBLIC_INFO = 'https://id.vk.com/oauth2/public_info';
const PENDING_MS = 10 * 60_000;       // на подтверждение в VK — 10 минут
const PENDING_MAX = 5000;

const b64url = (buf) => buf.toString('base64url');

function createVk({ clientId, redirectUri }) {
  const pending = new Map();          // state -> { verifier, at, ...extra }

  function sweep(now = Date.now()) {
    for (const [k, v] of pending) if (now - v.at > PENDING_MS) pending.delete(k);
    // Защита от переполнения: самые старые — прочь.
    while (pending.size > PENDING_MAX) pending.delete(pending.keys().next().value);
  }

  // Адрес страницы VK. extra — что вернуть после входа: источник, друг, привязка к аккаунту.
  function start(extra = {}) {
    sweep();
    const state = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    pending.set(state, { verifier, at: Date.now(), ...extra });
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'vkid.personal_info',
    });
    return `${AUTHORIZE}?${q}`;
  }

  async function post(url, params) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error_description || data.error || `HTTP ${res.status}`);
    return data;
  }

  // Возврат из VK: { vk: { id, firstName, lastName, avatar }, extra } или { error }.
  async function finish({ code, state, device_id: deviceId }) {
    const p = state && pending.get(state);
    if (!p) return { error: 'Вход через VK устарел — попробуйте ещё раз' };
    pending.delete(state);
    if (!code || !deviceId) return { error: 'VK не подтвердил вход' };
    const { verifier, at, ...extra } = p;
    try {
      const token = await post(TOKEN, {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: clientId,
        device_id: deviceId,
        redirect_uri: redirectUri,
        state,
      });
      const info = await post(USER_INFO, { client_id: clientId, access_token: token.access_token });
      const u = info.user || {};
      const id = String(u.user_id || token.user_id || '');
      if (!id) return { error: 'VK не прислал данные профиля' };
      return {
        vk: { id, firstName: u.first_name || '', lastName: u.last_name || '', avatar: u.avatar || null },
        extra,
      };
    } catch (err) {
      console.error('Вход через VK:', err.message);
      return { error: 'VK не ответил — попробуйте ещё раз' };
    }
  }

  // id_token из виджета: VK сам проверяет подпись, срок и что он выдан нашему приложению,
  // и возвращает, чей он. Это единственное, чему сервер верит, — не данным из браузера.
  async function verifyIdToken(idToken) {
    if (!idToken || typeof idToken !== 'string' || idToken.length > 8192) return { error: 'VK не подтвердил вход' };
    try {
      const info = await post(PUBLIC_INFO, { client_id: clientId, id_token: idToken });
      const u = info.user || {};
      const id = String(u.user_id || '');
      if (!id) return { error: 'VK не прислал данные профиля' };
      return { vk: { id, firstName: u.first_name || '', lastName: u.last_name || '', avatar: u.avatar || null } };
    } catch (err) {
      console.error('Вход через VK (id_token):', err.message);
      return { error: 'VK не подтвердил вход — попробуйте ещё раз' };
    }
  }

  return { start, finish, verifyIdToken, clientId, redirectUri };
}

module.exports = { createVk };
