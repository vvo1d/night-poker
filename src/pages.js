'use strict';
// Страницы, которые сервер собирает сам: публичный профиль игрока.
// Обычная статика не подходит — у каждой страницы своё превью для
// мессенджеров и соцсетей, а его читают без скриптов.

const seasons = require('./seasons');
const { ACHIEVEMENTS, achievementView } = require('./achievements');

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const fmt = (n) => Number(n || 0).toLocaleString('ru-RU');
const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };

function miniCards(cards) {
  return (cards || []).map((c) => `<i class="m m--${c[1]}">${c[0] === 'T' ? '10' : c[0]}${SUIT[c[1]]}</i>`).join('');
}

// Профиль с малым числом раздач поисковику не показываем: пустые страницы вредят сайту.
const INDEX_FROM_HANDS = 50;

function profilePage(user, origin, avatar = null) {
  const s = user.stats;
  const season = seasons.view(user);
  const achievements = ACHIEVEMENTS.map((a) => achievementView(a, user)).filter((a) => a.tier > 0);
  const tiers = achievements.reduce((sum, a) => sum + a.tier, 0);
  const winRate = user.handsPlayed ? Math.round((s.handsWon / user.handsPlayed) * 100) : 0;
  const url = `${origin}/u/${encodeURIComponent(user.name)}`;
  // С числом месяц встаёт в родительный падеж: «с 24 октября 2026 г.».
  const since = new Date(user.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

  const facts = [
    `лига «${season.league.name}»`,
    tiers ? `${tiers} ${tiers % 10 === 1 && tiers % 100 !== 11 ? 'ступень' : 'ступеней'} ачивок` : null,
    s.bestHand ? `лучшая комбинация — ${s.bestHand.name}` : null,
    `${fmt(user.handsPlayed)} раздач`,
  ].filter(Boolean);
  const title = `${user.name} — игрок THPoker`;
  const description = `${facts.join(' · ')}. THPoker — бесплатный онлайн покер без денег.`;

  const stat = (value, label) => `<div class="pp-stat"><b>${value}</b><span>${label}</span></div>`;
  const history = season.history.length
    ? `<div class="pp-seasons">${season.history.map((h) => `<span class="pp-season"><i class="pp-league pp-league--${h.league}"></i>${escapeHtml(h.name)} · ${fmt(h.points)} очк.</span>`).join('')}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(url)}">
<meta name="robots" content="${user.handsPlayed >= INDEX_FROM_HANDS ? 'index, follow' : 'noindex, follow'}">
<meta name="theme-color" content="#0d1317">
<meta property="og:type" content="profile">
<meta property="og:site_name" content="THPoker">
<meta property="og:url" content="${escapeHtml(url)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${origin}/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/favicon-120.png" sizes="120x120" type="image/png">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="stylesheet" href="/fonts/fonts.css">
<link rel="stylesheet" href="/landing.css">
</head>
<body>
<header class="nav">
  <div class="wrap nav__in">
    <a class="logo" href="/"><span class="logo__mark" aria-hidden="true">♠</span>THPoker</a>
    <nav class="nav__links" aria-label="Разделы"><a href="/articles/">Статьи</a><a href="/#rules">Правила</a></nav>
    <a class="btn btn--primary btn--sm" href="/play">Играть</a>
  </div>
</header>
<main class="wrap pp">
  <section class="pp-head">
    <div class="pp-avatar" aria-hidden="true">${avatar
      ? `<img src="${escapeHtml(avatar)}" alt="" width="80" height="80">`
      : escapeHtml(user.name.slice(0, 1).toUpperCase())}</div>
    <div>
      <h1>${escapeHtml(user.name)}</h1>
      ${user.meta && user.meta.bot ? `<p class="pp-bot">Бот THPoker${user.meta.bot.bio ? ` — ${escapeHtml(user.meta.bot.bio)}` : ''}. Боты носят имена известных игроков в покер как дань уважения; они не связаны с этими людьми и не повторяют их реальную игру.</p>` : ''}
      <p class="pp-sub"><i class="pp-league pp-league--${season.league.id}"></i>Лига «${season.league.name}» · ${fmt(season.points)} очк. в сезоне «${escapeHtml(season.name)}» · в игре с ${since}</p>
    </div>
  </section>

  <section class="pp-stats">
    ${stat(fmt(user.handsPlayed), 'раздач сыграно')}
    ${stat(`${winRate}%`, 'раздач выиграно')}
    ${stat(fmt(s.biggestPot), 'крупнейший банк')}
    ${stat(fmt(s.sngWins), 'побед в sit-n-go')}
    ${s.bestHand ? `<div class="pp-stat pp-stat--wide"><b>${escapeHtml(s.bestHand.name)}</b><span>лучшая комбинация</span><span class="hand">${miniCards(s.bestHand.cards)}</span></div>` : ''}
  </section>
  ${history}

  <section class="pp-block">
    <h2>Ачивки${tiers ? ` · ${tiers} ступ.` : ''}</h2>
    ${achievements.length ? `<ul class="pp-ach">${achievements.map((a) => `
      <li class="pp-ach__item tier-${a.tier}"><span class="pp-ach__icon"><img src="/achievements/${escapeHtml(a.id)}.webp" alt="" loading="lazy"></span>
      <span><b>${escapeHtml(a.title)}</b> · ${escapeHtml(a.tierName)}<small>${escapeHtml(a.done)}</small></span></li>`).join('')}</ul>`
    : '<p class="pp-empty">Пока ни одной — всё впереди.</p>'}
  </section>

  <section class="final">
    <div class="final__in">
      <h2>Ваша очередь за столом</h2>
      <p>Бесплатный покер на виртуальные фишки: техасский холдем, турниры и столы с друзьями.</p>
      <a class="btn btn--primary btn--lg" href="/play">Играть в THPoker</a>
    </div>
  </section>
</main>
<footer class="footer"><div class="wrap footer__in">
  <a class="logo logo--sm" href="/"><span class="logo__mark" aria-hidden="true">♠</span>THPoker</a>
  <p>Бесплатный онлайн покер на виртуальные фишки. Фишки нельзя купить, продать или вывести.</p>
<p class="footer__legal"><b class="age-mark" title="Только для совершеннолетних">18+</b> <a href="/privacy">Политика конфиденциальности</a> <a href="/terms">Пользовательское соглашение</a> <a href="/consent">Согласие на обработку данных</a></p>
</div></footer>
<script src="/landing.js" defer></script>
</body>
</html>`;
}

module.exports = { profilePage, escapeHtml };
