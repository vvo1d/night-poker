// Баннер cookie. Необходимые cookie работают всегда, Яндекс Метрика — только после «Принять»:
// сам счётчик ждёт в window.thpMetrika (его вставляет сервер, см. withMetrika).
(() => {
  const KEY = 'thp-cookies';
  const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const write = (value) => { try { localStorage.setItem(KEY, value); } catch { /* спросим в следующий раз */ } };
  const start = () => { if (window.thpMetrika) window.thpMetrika(); };

  function banner() {
    if (document.getElementById('cookie-banner')) return;
    const box = document.createElement('div');
    box.id = 'cookie-banner';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Настройки cookie');
    // Одна строка; только на самых узких телефонах кнопки уходят под текст.
    box.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(10px + env(safe-area-inset-bottom));z-index:9999;'
      + 'width:max-content;max-width:calc(100vw - 20px);box-sizing:border-box;display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:6px 12px;'
      + 'padding:7px 8px 7px 14px;border-radius:12px;background:#0e161a;border:1px solid rgba(201,162,74,.35);color:#d8e2e0;'
      + 'font:13px/1.3 "IBM Plex Sans",system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.45)';
    box.innerHTML = '<span style="flex:1 1 auto">Сайт использует <a href="/privacy" target="_blank" style="color:#c9a24a">cookie</a></span>'
      + '<span style="display:flex;align-items:center;gap:4px">'
      + '<button type="button" data-v="no" style="font:inherit;padding:6px 10px;border:0;border-radius:8px;background:none;color:#8a9da3;cursor:pointer">Отклонить</button>'
      + '<button type="button" data-v="yes" style="font:inherit;font-weight:600;padding:6px 14px;border:0;border-radius:8px;background:linear-gradient(180deg,#f0d68f,#c9a24a);color:#1a1305;cursor:pointer">Принять</button></span>';
    box.addEventListener('click', (e) => {
      const v = e.target.dataset && e.target.dataset.v;
      if (!v) return;
      const was = read();
      write(v);
      box.remove();
      if (v === 'yes') start();
      else if (was === 'yes') location.reload();   // отозвали — счётчик выгружается перезагрузкой
    });
    document.body.append(box);
  }

  document.addEventListener('click', (e) => {
    const link = e.target.closest && e.target.closest('[data-cookie-settings]');
    if (!link) return;
    e.preventDefault();
    banner();
  });

  const choice = read();
  if (choice === 'yes') start();
  else if (choice !== 'no') banner();
})();
