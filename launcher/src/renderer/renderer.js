'use strict';

const $ = (id) => document.getElementById(id);

const nickInput = $('nickname');
const nickHint = $('nick-hint');
const profileAvatar = $('profile-avatar');
const avatarInput = $('avatar-input');
const playBtn = $('play-btn');
const statusText = $('status-text');
const progressFill = $('progress-fill');
const logEl = $('log');
const logPanel = $('log-panel');
const contentRoot = $('content-root');
const logToggle = $('log-toggle');
const logClose = $('log-close');
const logClear = $('log-clear');
const settingsBtn = $('settings-btn');
const settingsOverlay = $('settings-overlay');
const settingsClose = $('settings-close');
const settingsSave = $('settings-save');
const memoryMin = $('memory-min');
const memoryMax = $('memory-max');
const fullscreenCb = $('fullscreen');

const NICK_RE = /^[A-Za-z0-9_]{3,16}$/;
const LOG_CLOSE_MS = 260;
const LOG_MAX_LINES = 600;
let launching = false;
let memoryOptions = [];
let logAnimating = false;
let logLines = [];
let logFlushScheduled = false;
let appInfo = null;
const SERVER_STATUS_POLL_MS = 15000;
const NEWS_POLL_MS = 120000;
let serverStatusTimer = null;
let newsPollTimer = null;
let lastNewsUpdatedAt = null;
let customAvatarUrl = '';

function applyAvatarImage(dataUrl) {
  if (!profileAvatar) return;
  customAvatarUrl = dataUrl || '';
  if (customAvatarUrl) {
    profileAvatar.style.backgroundImage = `url("${customAvatarUrl}")`;
    profileAvatar.classList.add('has-image');
    profileAvatar.textContent = '';
  } else {
    profileAvatar.style.backgroundImage = '';
    profileAvatar.classList.remove('has-image');
    updateProfileAvatarLetter();
  }
}

function updateProfileAvatarLetter() {
  if (!profileAvatar || profileAvatar.classList.contains('has-image')) return;
  const v = nickInput.value.trim();
  profileAvatar.textContent = v ? v.charAt(0).toUpperCase() : '?';
}

function resizeAvatarFile(file) {
  const maxSize = 128;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.88));
      };
      img.onerror = () => reject(new Error('Не удалось прочитать изображение'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('Не удалось открыть файл'));
    reader.readAsDataURL(file);
  });
}

async function saveAvatarFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  try {
    const dataUrl = await resizeAvatarFile(file);
    applyAvatarImage(dataUrl);
    const saved = await window.svo.saveSettings({ avatarDataUrl: dataUrl });
    appInfo = { ...appInfo, settings: { ...appInfo.settings, ...saved } };
  } catch (err) {
    appendLog(`Аватар: ${err.message || err}`);
  } finally {
    avatarInput.value = '';
  }
}

function syncNewsSidebarHeight() {
  const sidebar = document.querySelector('.news-sidebar');
  if (!sidebar) return;
  sidebar.style.height = '';
}

function startNewsSidebarSync() {
  syncNewsSidebarHeight();
}

function setStatus(text, progress, updating) {
  const payload = typeof text === 'object' && text !== null ? text : { text, progress, updating };
  statusText.textContent = payload.text || '';
  const isUpdating = Boolean(payload.updating);
  statusText.classList.toggle('is-updating', isUpdating);
  progressFill.classList.toggle('is-updating', isUpdating);
  if (typeof payload.progress === 'number') {
    progressFill.style.width = `${Math.round(payload.progress * 100)}%`;
  }
}

function updateProfileAvatar() {
  updateProfileAvatarLetter();
}

function nickValid() {
  return NICK_RE.test(nickInput.value.trim());
}

function updateActions() {
  playBtn.disabled = !nickValid() || launching;
}

function validateNick() {
  const v = nickInput.value.trim();
  if (v.length === 0) {
    nickHint.textContent = '';
    nickHint.classList.remove('error');
  } else if (!nickValid()) {
    nickHint.textContent = 'Ник: 3–16 символов, латиница, цифры и _';
    nickHint.classList.add('error');
  } else {
    nickHint.textContent = '';
    nickHint.classList.remove('error');
  }
  updateActions();
  updateProfileAvatar();
  return nickValid();
}

function scheduleLogPaint() {
  if (logFlushScheduled) return;
  logFlushScheduled = true;
  requestAnimationFrame(() => {
    logFlushScheduled = false;
    logEl.textContent = logLines.join('\n');
    logEl.scrollTop = logEl.scrollHeight;
  });
}

function appendLog(input) {
  const lines = Array.isArray(input) ? input : [input];
  for (const line of lines) {
    if (line == null || line === '') continue;
    logLines.push(String(line));
  }
  if (logLines.length > LOG_MAX_LINES) {
    logLines = logLines.slice(-LOG_MAX_LINES);
  }
  scheduleLogPaint();
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatNewsDate(value) {
  if (!value) return '';
  const parts = String(value).split('-');
  if (parts.length === 3) return `${parts[2]}.${parts[1]}.${parts[0]}`;
  return String(value);
}

function formatNewsLoadedAt(at = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(at.getDate())}.${pad(at.getMonth() + 1)}.${at.getFullYear()} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function renderNewsSync(data) {
  const el = $('news-sync');
  if (!el) return;

  el.classList.remove('is-loading', 'is-ok', 'is-error', 'is-flash', 'is-remote');

  if (data?.loading) {
    el.textContent = 'Загрузка новостей…';
    el.classList.add('is-loading');
    return;
  }

  if (data?.ok === false) {
    el.textContent = 'Не удалось загрузить новости';
    el.classList.add('is-error');
    return;
  }

  if (data?.source === 'remote') {
    const stamp = data.updatedAt || null;
    const isFresh = Boolean(stamp && stamp !== lastNewsUpdatedAt);
    if (stamp) lastNewsUpdatedAt = stamp;

    const loadedAt = formatNewsLoadedAt(new Date());
    el.textContent = `Обновлено с GitHub · ${loadedAt}`;
    el.classList.add('is-ok', 'is-remote');
    if (isFresh) {
      el.classList.add('is-flash');
      window.setTimeout(() => el.classList.remove('is-flash'), 2800);
    }
    return;
  }

  if ((data?.items || []).length > 0) {
    const loadedAt = formatNewsLoadedAt(new Date());
    el.textContent = `Локальная копия · ${loadedAt}`;
    el.classList.add('is-ok');
    return;
  }

  el.textContent = data?.remoteError
    ? 'GitHub недоступен · новостей нет'
    : 'Новостей пока нет';
}

function renderNews(data) {
  const list = $('news-list');
  const badge = $('news-badge');
  if (!list || !badge) return;

  if (data?.updateAvailable) {
    badge.textContent = 'есть обновление';
    badge.classList.add('is-update');
  } else if (data?.modpackRevision) {
    badge.textContent = `сборка rev. ${data.modpackRevision}`;
    badge.classList.remove('is-update');
  } else {
    badge.textContent = 'PGC';
    badge.classList.remove('is-update');
  }

  list.innerHTML = '';
  const items = (data?.items || []).slice(0, 12);
  if (items.length === 0) {
    list.innerHTML = '<p class="news-item-text">Новостей пока нет.</p>';
    syncNewsSidebarHeight();
    return;
  }

  for (const item of items) {
    const article = document.createElement('article');
    article.className = 'news-item';
    article.innerHTML = `
      <div class="news-meta">
        <span class="news-date">${escapeHtml(formatNewsDate(item.date))}</span>
        ${item.tag ? `<span class="news-tag">${escapeHtml(item.tag)}</span>` : ''}
      </div>
      <div class="news-item-title">${escapeHtml(item.title)}</div>
      <p class="news-item-text">${escapeHtml(item.text)}</p>
    `;
    list.appendChild(article);
  }
  syncNewsSidebarHeight();
}

async function loadNews() {
  renderNewsSync({ loading: true });
  try {
    const data = await window.svo.getNews();
    renderNews(data);
    renderNewsSync(data);
  } catch {
    renderNews({ ok: true, source: 'none', items: [] });
    renderNewsSync({ ok: true, source: 'none', items: [], remoteError: true });
  }
}

function startNewsPolling() {
  if (newsPollTimer) clearInterval(newsPollTimer);
  newsPollTimer = setInterval(loadNews, NEWS_POLL_MS);
}

function formatTps(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return Number(value).toFixed(1);
}

function formatPing(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return `${Math.round(Number(value))} ms`;
}

function formatOnline(data) {
  if (!data?.online) return 'офлайн';
  const online = Number(data.playersOnline);
  const max = Number(data.playersMax);
  if (Number.isFinite(online) && Number.isFinite(max) && max > 0) {
    return `${online}/${max}`;
  }
  if (Number.isFinite(online)) return String(online);
  return 'онлайн';
}

function paintMetric(el, text, tone) {
  if (!el) return;
  el.textContent = text;
  el.classList.remove('is-online', 'is-offline', 'is-warn');
  if (tone) el.classList.add(tone);
}

function renderServerStatus(data) {
  const onlineEl = $('stat-online');
  const tpsEl = $('stat-tps');
  const pingEl = $('stat-ping');
  const dotEl = $('server-dot');

  dotEl?.classList.remove('is-online', 'is-offline');

  if (!data?.ok || !data.online) {
    paintMetric(onlineEl, 'офлайн', 'is-offline');
    paintMetric(tpsEl, '—', null);
    paintMetric(pingEl, '—', null);
    dotEl?.classList.add('is-offline');
    return;
  }

  dotEl?.classList.add('is-online');
  paintMetric(onlineEl, formatOnline(data), 'is-online');

  paintMetric(tpsEl, formatTps(data.tps), null);
  if (data.tps != null) {
    const tps = Number(data.tps);
    if (tps >= 18) tpsEl.classList.add('is-online');
    else if (tps >= 15) tpsEl.classList.add('is-warn');
    else tpsEl.classList.add('is-offline');
  }

  paintMetric(pingEl, formatPing(data.pingMs), null);
  if (data.pingMs != null) {
    const ping = Number(data.pingMs);
    if (ping <= 80) pingEl.classList.add('is-online');
    else if (ping <= 150) pingEl.classList.add('is-warn');
    else pingEl.classList.add('is-offline');
  }
}

async function loadServerStatus() {
  try {
    const data = await window.svo.getServerStatus();
    renderServerStatus(data);
  } catch {
    renderServerStatus({ ok: false, online: false });
  }
}

function startServerStatusPolling() {
  if (serverStatusTimer) clearInterval(serverStatusTimer);
  loadServerStatus();
  serverStatusTimer = setInterval(loadServerStatus, SERVER_STATUS_POLL_MS);
}

async function init() {
  appInfo = await window.svo.getInfo();
  document.title = appInfo.brand.title;
  const titleEl = document.querySelector('.titlebar-title');
  if (titleEl) titleEl.textContent = `${appInfo.brand.titlebar || appInfo.brand.name} · v${appInfo.appVersion}`;
  $('version-label').textContent =
    `Launcher ${appInfo.appVersion} · MC ${appInfo.version} · Forge ${appInfo.forge} · Java ${appInfo.javaMajor}`;

  if (appInfo.settings?.username) {
    nickInput.value = appInfo.settings.username;
  }
  if (appInfo.settings?.avatarDataUrl) {
    applyAvatarImage(appInfo.settings.avatarDataUrl);
  }

  memoryOptions = appInfo.memoryOptions || [2048, 4096, 8192];
  fillMemorySelect(memoryMin, memoryOptions);
  fillMemorySelect(memoryMax, memoryOptions);
  memoryMin.value = String(appInfo.settings.memoryMin || appInfo.defaults.memoryMin);
  memoryMax.value = String(appInfo.settings.memoryMax || appInfo.defaults.memoryMax);
  fullscreenCb.checked = Boolean(appInfo.settings.fullscreen);

  validateNick();
  startNewsSidebarSync();
  await loadNews();
  startNewsPolling();
  startServerStatusPolling();
}

function fillMemorySelect(select, values) {
  select.innerHTML = '';
  for (const mb of values) {
    const opt = document.createElement('option');
    opt.value = String(mb);
    opt.textContent = `${mb} МБ (${(mb / 1024).toFixed(1)} ГБ)`;
    select.appendChild(opt);
  }
}

function openSettings() {
  settingsOverlay.classList.remove('hidden');
  settingsOverlay.setAttribute('aria-hidden', 'false');
}

function closeSettings() {
  settingsOverlay.classList.add('hidden');
  settingsOverlay.setAttribute('aria-hidden', 'true');
}

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) closeSettings();
});

settingsSave.addEventListener('click', async () => {
  let min = Number(memoryMin.value);
  let max = Number(memoryMax.value);
  if (min > max) [min, max] = [max, min];
  await window.svo.saveSettings({
    memoryMin: min,
    memoryMax: max,
    fullscreen: fullscreenCb.checked
  });
  appInfo = { ...appInfo, settings: { ...appInfo.settings, memoryMin: min, memoryMax: max, fullscreen: fullscreenCb.checked } };
  closeSettings();
  setStatus('Настройки сохранены', 0);
});

playBtn.addEventListener('click', async () => {
  if (!validateNick() || launching) return;

  launching = true;
  updateActions();
  playBtn.querySelector('span').textContent = 'Запуск…';
  setStatus('Подготовка…', 0);

  const username = nickInput.value.trim();
  await window.svo.saveSettings({ username });

  const res = await window.svo.launch(username);
  if (!res.ok) {
    setStatus(`Ошибка: ${res.error}`, 0);
    nickHint.textContent = res.error;
    nickHint.classList.add('error');
    setLogOpen(true);
    launching = false;
    playBtn.querySelector('span').textContent = 'Играть';
    updateActions();
  }
});

nickInput.addEventListener('input', validateNick);
nickInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') playBtn.click();
});

profileAvatar?.addEventListener('click', () => avatarInput?.click());
avatarInput?.addEventListener('change', () => {
  const file = avatarInput.files?.[0];
  if (file) saveAvatarFile(file);
});

function isLogOpen() {
  return logPanel.classList.contains('is-open');
}

function openLog() {
  if (logAnimating || isLogOpen()) return;
  logAnimating = true;
  logPanel.setAttribute('aria-hidden', 'false');
  logToggle.classList.add('active');
  logToggle.setAttribute('aria-expanded', 'true');
  logPanel.classList.add('is-open');
  scheduleLogPaint();
  setTimeout(() => {
    logAnimating = false;
  }, LOG_CLOSE_MS + 40);
}

function closeLog() {
  if (logAnimating || !isLogOpen()) return;
  logAnimating = true;
  logPanel.classList.remove('is-open');
  logToggle.classList.remove('active');
  logToggle.setAttribute('aria-expanded', 'false');

  setTimeout(() => {
    logPanel.setAttribute('aria-hidden', 'true');
    logAnimating = false;
  }, LOG_CLOSE_MS + 40);
}

function setLogOpen(open) {
  if (open) openLog();
  else closeLog();
}

function toggleLog() {
  if (isLogOpen()) closeLog();
  else openLog();
}

logToggle.addEventListener('click', toggleLog);
logClose.addEventListener('click', () => setLogOpen(false));
logClear.addEventListener('click', () => {
  logLines = [];
  logEl.textContent = '';
});

$('min-btn').addEventListener('click', () => window.svo.minimize());
$('close-btn').addEventListener('click', () => window.svo.close());

window.svo.onStatus((s) => {
  setStatus(s);
  if (s?.text && /обновлен|актуальн|Сборка обновлена/i.test(s.text)) {
    loadNews();
  }
});
window.svo.onLog((m) => appendLog(m));
window.svo.onLaunched(() => {
  setStatus('Игра запущена. Приятной игры!', 1);
  playBtn.querySelector('span').textContent = 'Играем';
  if (isLogOpen()) closeLog();
});
window.svo.onGameClose((code) => {
  launching = false;
  playBtn.querySelector('span').textContent = 'Играть';
  if (code !== 0) {
    setStatus('Игра завершилась с ошибкой — откройте «Лог»', 0);
    setLogOpen(true);
  } else {
    setStatus('Игра закрыта', 0);
  }
  validateNick();
});

init();
