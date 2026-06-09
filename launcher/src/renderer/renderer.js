'use strict';

const $ = (id) => document.getElementById(id);

const profileNick = $('profile-nick');
const profileAvatar = $('profile-avatar');
const avatarInput = $('avatar-input');
const playBtn = $('play-btn');
const statusText = $('status-text');
const progressFill = $('progress-fill');
const logEl = $('log');
const logPanel = $('log-panel');
const logToggle = $('log-toggle');
const logClose = $('log-close');
const logClear = $('log-clear');
const shopBtn = $('shop-btn');
const shopOverlay = $('shop-overlay');
const shopClose = $('shop-close');
const settingsBtn = $('settings-btn');
const settingsOverlay = $('settings-overlay');
const settingsClose = $('settings-close');
const settingsSave = $('settings-save');
const registerOverlay = $('register-overlay');
const registerNick = $('register-nick');
const registerPassword = $('register-password');
const registerHint = $('register-hint');
const registerSubmit = $('register-submit');
const memoryMin = $('memory-min');
const memoryMax = $('memory-max');
const memoryMinValue = $('memory-min-value');
const memoryMaxValue = $('memory-max-value');
const uiFontSelect = $('ui-font');
const fullscreenCb = $('fullscreen');
const UI_FONTS = [
  { id: 'default', label: 'Segoe UI (по умолчанию)', stack: '"Segoe UI", system-ui, sans-serif' },
  { id: 'system', label: 'Системный', stack: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  { id: 'arial', label: 'Arial', stack: '"Arial", "Helvetica Neue", Helvetica, sans-serif' },
  { id: 'tahoma', label: 'Tahoma', stack: '"Tahoma", "Segoe UI", sans-serif' },
  { id: 'georgia', label: 'Georgia', stack: '"Georgia", "Times New Roman", serif' }
];

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
let registered = false;
let currentUsername = '';

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
  profileAvatar.textContent = currentUsername ? currentUsername.charAt(0).toUpperCase() : '?';
}

function setProfileUsername(name) {
  currentUsername = String(name || '').trim();
  if (profileNick) profileNick.textContent = currentUsername || '—';
  updateProfileAvatarLetter();
  updateActions();
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

function nickValid(name) {
  return NICK_RE.test(String(name || '').trim());
}

function updateActions() {
  playBtn.disabled = !registered || !nickValid(currentUsername) || launching;
}

function openModal(overlay) {
  if (!overlay) return;
  overlay.classList.add('is-open');
  overlay.setAttribute('aria-hidden', 'false');
}

function closeModal(overlay) {
  if (!overlay) return;
  overlay.classList.remove('is-open');
  overlay.setAttribute('aria-hidden', 'true');
}

function openSettings() {
  openModal(settingsOverlay);
}

function closeSettings() {
  closeModal(settingsOverlay);
}

function openShop() {
  openModal(shopOverlay);
}

function closeShop() {
  closeModal(shopOverlay);
}

function openRegister() {
  openModal(registerOverlay);
  registerNick?.focus();
}

function closeRegister() {
  closeModal(registerOverlay);
}

function validateRegisterForm() {
  const nick = registerNick?.value.trim() || '';
  const pass = registerPassword?.value || '';
  if (!nickValid(nick)) {
    registerHint.textContent = 'Ник: 3–16 символов, латиница, цифры и _';
    registerHint.classList.add('error');
    return null;
  }
  if (pass.length < 6) {
    registerHint.textContent = 'Пароль минимум 6 символов';
    registerHint.classList.add('error');
    return null;
  }
  registerHint.textContent = '';
  registerHint.classList.remove('error');
  return { username: nick, password: pass };
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
  const auth = await window.svo.getAuthStatus();
  registered = Boolean(auth?.registered);
  document.title = appInfo.brand.title;
  const titleEl = document.querySelector('.titlebar-title');
  if (titleEl) titleEl.textContent = `${appInfo.brand.titlebar || appInfo.brand.name} · v${appInfo.appVersion}`;
  $('version-label').textContent =
    `Launcher ${appInfo.appVersion} · MC ${appInfo.version} · Forge ${appInfo.forge} · Java ${appInfo.javaMajor}`;

  if (auth?.username || appInfo.settings?.username) {
    setProfileUsername(auth?.username || appInfo.settings.username);
  }
  if (appInfo.settings?.avatarDataUrl) {
    applyAvatarImage(appInfo.settings.avatarDataUrl);
  }

  memoryOptions = appInfo.memoryOptions || [2048, 4096, 8192];
  setupMemorySlider(memoryMin, memoryMinValue, memoryOptions, appInfo.settings.memoryMin || appInfo.defaults.memoryMin);
  setupMemorySlider(memoryMax, memoryMaxValue, memoryOptions, appInfo.settings.memoryMax || appInfo.defaults.memoryMax);
  bindMemorySliderSync();
  fillFontSelect(uiFontSelect);
  const uiFont = appInfo.settings.uiFont || appInfo.defaults.uiFont || 'default';
  uiFontSelect.value = UI_FONTS.some((f) => f.id === uiFont) ? uiFont : 'default';
  applyUiFont(uiFontSelect.value);
  fullscreenCb.checked = Boolean(appInfo.settings.fullscreen);

  updateActions();
  startNewsSidebarSync();
  await loadNews();
  startNewsPolling();
  startServerStatusPolling();

  if (!registered) {
    openRegister();
  }
}

function formatMemoryMb(mb) {
  return `${mb} МБ (${(mb / 1024).toFixed(1)} ГБ)`;
}

function snapMemoryIndex(options, mb) {
  if (!options.length) return 0;
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < options.length; i++) {
    const diff = Math.abs(options[i] - mb);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best;
}

function memoryMbFromSlider(slider) {
  return memoryOptions[Number(slider.value)] || memoryOptions[0];
}

function updateMemorySliderLabel(slider, valueEl) {
  const mb = memoryMbFromSlider(slider);
  valueEl.textContent = formatMemoryMb(mb);
  slider.setAttribute('aria-valuenow', String(mb));
}

function setupMemorySlider(slider, valueEl, options, initialMb) {
  slider.min = '0';
  slider.max = String(Math.max(0, options.length - 1));
  slider.step = '1';
  slider.value = String(snapMemoryIndex(options, initialMb));
  updateMemorySliderLabel(slider, valueEl);
}

function bindMemorySliderSync() {
  memoryMin.addEventListener('input', () => {
    updateMemorySliderLabel(memoryMin, memoryMinValue);
    if (Number(memoryMin.value) > Number(memoryMax.value)) {
      memoryMax.value = memoryMin.value;
      updateMemorySliderLabel(memoryMax, memoryMaxValue);
    }
  });
  memoryMax.addEventListener('input', () => {
    updateMemorySliderLabel(memoryMax, memoryMaxValue);
    if (Number(memoryMax.value) < Number(memoryMin.value)) {
      memoryMin.value = memoryMax.value;
      updateMemorySliderLabel(memoryMin, memoryMinValue);
    }
  });
}

function readMemorySettings() {
  let min = memoryMbFromSlider(memoryMin);
  let max = memoryMbFromSlider(memoryMax);
  if (min > max) [min, max] = [max, min];
  return { memoryMin: min, memoryMax: max };
}

function fillFontSelect(select) {
  select.innerHTML = '';
  for (const font of UI_FONTS) {
    const opt = document.createElement('option');
    opt.value = font.id;
    opt.textContent = font.label;
    opt.style.fontFamily = font.stack;
    select.appendChild(opt);
  }
}

function resolveUiFontStack(fontId) {
  const found = UI_FONTS.find((f) => f.id === fontId);
  return found?.stack || UI_FONTS[0].stack;
}

function applyUiFont(fontId) {
  document.documentElement.style.setProperty('--ui-font', resolveUiFontStack(fontId));
}

shopBtn?.addEventListener('click', openShop);
shopClose?.addEventListener('click', closeShop);
shopOverlay?.addEventListener('click', (e) => {
  if (e.target === shopOverlay) closeShop();
});

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) closeSettings();
});

registerSubmit?.addEventListener('click', async () => {
  const payload = validateRegisterForm();
  if (!payload) return;
  registerSubmit.disabled = true;
  registerSubmit.querySelector('span').textContent = 'Регистрация…';
  const res = await window.svo.register(payload);
  registerSubmit.disabled = false;
  registerSubmit.querySelector('span').textContent = 'ЗАРЕГИСТРИРОВАТЬСЯ';
  if (!res.ok) {
    registerHint.textContent = res.error || 'Ошибка регистрации';
    registerHint.classList.add('error');
    return;
  }
  registered = true;
  setProfileUsername(res.username);
  closeRegister();
  setStatus('Регистрация завершена', 0);
});

registerPassword?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') registerSubmit?.click();
});
registerNick?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') registerPassword?.focus();
});

settingsSave.addEventListener('click', async () => {
  const { memoryMin: min, memoryMax: max } = readMemorySettings();
  const uiFont = UI_FONTS.some((f) => f.id === uiFontSelect.value) ? uiFontSelect.value : 'default';
  const saved = await window.svo.saveSettings({
    memoryMin: min,
    memoryMax: max,
    fullscreen: fullscreenCb.checked,
    uiFont
  });
  applyUiFont(uiFont);
  appInfo = { ...appInfo, settings: { ...appInfo.settings, ...saved } };
  closeSettings();
  setStatus('Настройки сохранены', 0);
});

uiFontSelect.addEventListener('change', () => {
  applyUiFont(uiFontSelect.value);
});

playBtn.addEventListener('click', async () => {
  if (!registered || !nickValid(currentUsername) || launching) return;

  launching = true;
  updateActions();
  playBtn.querySelector('span').textContent = 'Запуск…';
  setStatus('Подготовка…', 0);

  const res = await window.svo.launch(currentUsername);
  if (!res.ok) {
    setStatus(`Ошибка: ${res.error}`, 0);
    if (!registered) openRegister();
    setLogOpen(true);
    launching = false;
    playBtn.querySelector('span').textContent = 'Играть';
    updateActions();
  }
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
  updateActions();
});

init();
