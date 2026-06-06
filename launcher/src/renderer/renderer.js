'use strict';

const $ = (id) => document.getElementById(id);

const nickInput = $('nickname');
const nickHint = $('nick-hint');
const playBtn = $('play-btn');
const statusText = $('status-text');
const progressFill = $('progress-fill');
const logEl = $('log');
const logPanel = $('log-panel');
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

function setStatus(text, progress) {
  statusText.textContent = text;
  if (typeof progress === 'number') {
    progressFill.style.width = `${Math.round(progress * 100)}%`;
  }
}

function validateNick() {
  const v = nickInput.value.trim();
  const ok = NICK_RE.test(v);
  if (v.length === 0) {
    nickHint.textContent = '3–16 символов: латиница, цифры и _';
    nickHint.classList.remove('error');
  } else if (!ok) {
    nickHint.textContent = 'Недопустимый ник. Разрешены: A-Z, a-z, 0-9, _';
    nickHint.classList.add('error');
  } else {
    nickHint.textContent = 'Ник принят';
    nickHint.classList.remove('error');
  }
  playBtn.disabled = !ok || launching;
  return ok;
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

async function init() {
  const info = await window.svo.getInfo();
  $('project-desc').textContent = info.brand.description || info.brand.name;
  document.title = info.brand.title;
  const titleEl = document.querySelector('.titlebar-title');
  if (titleEl) titleEl.textContent = `${info.brand.titlebar || info.brand.name} · v${info.appVersion}`;
  const heroTitle = $('hero-title');
  if (heroTitle) heroTitle.textContent = info.brand.name;
  $('version-label').textContent =
    `Launcher ${info.appVersion} · MC ${info.version} · Forge ${info.forge} · Java ${info.javaMajor}`;

  if (info.settings && info.settings.username) {
    nickInput.value = info.settings.username;
  }

  memoryOptions = info.memoryOptions || [2048, 4096, 8192];
  fillMemorySelect(memoryMin, memoryOptions);
  fillMemorySelect(memoryMax, memoryOptions);
  memoryMin.value = String(info.settings.memoryMin || info.defaults.memoryMin);
  memoryMax.value = String(info.settings.memoryMax || info.defaults.memoryMax);
  fullscreenCb.checked = Boolean(info.settings.fullscreen);

  validateNick();
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
  closeSettings();
  setStatus('Настройки сохранены', 0);
});

playBtn.addEventListener('click', async () => {
  if (!validateNick() || launching) return;
  launching = true;
  playBtn.disabled = true;
  playBtn.textContent = 'ЗАПУСК…';
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
    playBtn.textContent = 'ИГРАТЬ';
    validateNick();
  }
});

nickInput.addEventListener('input', validateNick);
nickInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') playBtn.click();
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
  window.svo.setLogPanelOpen(true, true);
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
  window.svo.setLogPanelOpen(false, true);

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

window.svo.onStatus((s) => setStatus(s.text, s.progress));
window.svo.onLog((m) => appendLog(m));
window.svo.onLaunched(() => {
  setStatus('Игра запущена. Приятной игры!', 1);
  playBtn.textContent = 'ИГРАЕМ';
  if (isLogOpen()) closeLog();
});
window.svo.onGameClose((code) => {
  launching = false;
  playBtn.textContent = 'ИГРАТЬ';
  if (code !== 0) {
    setStatus('Игра завершилась с ошибкой — откройте «Лог»', 0);
    setLogOpen(true);
  } else {
    setStatus('Игра закрыта', 0);
  }
  validateNick();
});

init();
