'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

if (process.platform === 'win32') {
  app.commandLine.appendSwitch('force-high-performance-gpu');
}

const config = require('./config');
const { formatLaunchError } = require('./errors');
const { GameLauncher, getGameDir } = require('./launcher-core');
const { applyLauncherCpuLimit } = require('./cpu-limit');
const { applyDiscreteGpuToProcessEnv } = require('./gpu-env');
const { fetchNews } = require('./news');
const { fetchServerStatus } = require('./server-status');
const { login, registerAccount, checkLoginExists, validateSession } = require('./launcher-auth');
const { applyRememberPassword, sanitizeSettingsForRenderer } = require('./credentials-store');
const { checkForUpdates } = require('./modpack-sync');

let mainWindow = null;
const launcher = new GameLauncher();

const WINDOW_SIZE = { width: 1010, height: 635, logExtra: 235 };
const LOG_ANIM_MS = 240;
const LOG_FLUSH_MS = 48;
const MAX_CPU_PERCENT = config.java?.maxCpuPercent ?? 75;

let logFlushTimer = null;
const logPending = [];

function flushLogBuffer() {
  logFlushTimer = null;
  if (!mainWindow || logPending.length === 0) return;
  const batch = logPending.splice(0);
  mainWindow.webContents.send('launcher:log-batch', batch);
}

function queueLogLine(line) {
  logPending.push(line);
  if (!logFlushTimer) {
    logFlushTimer = setTimeout(flushLogBuffer, LOG_FLUSH_MS);
  }
}

function applyWindowHeight(height) {
  if (!mainWindow) return;
  mainWindow.setMinimumSize(WINDOW_SIZE.width, height);
  mainWindow.setMaximumSize(WINDOW_SIZE.width, height);
  mainWindow.setSize(WINDOW_SIZE.width, height, true);
}

function animateWindowHeight(targetHeight, durationMs = LOG_ANIM_MS) {
  if (!mainWindow) return;
  const startHeight = mainWindow.getSize()[1];
  const delta = targetHeight - startHeight;
  if (delta === 0) return;

  const frames = 8;
  const stepMs = Math.max(24, Math.floor(durationMs / frames));
  let frame = 0;
  const tick = () => {
    frame += 1;
    const t = Math.min(1, frame / frames);
    const eased = 1 - (1 - t) ** 3;
    applyWindowHeight(Math.round(startHeight + delta * eased));
    if (t < 1) setTimeout(tick, stepMs);
  };
  tick();
}

function applyCpuLimitsToWindow() {
  if (!mainWindow) return;
  const pids = [process.pid, mainWindow.webContents.getOSProcessId()].filter(Boolean);
  applyLauncherCpuLimit(MAX_CPU_PERCENT, ...pids);
}

function settingsPath() {
  return path.join(getGameDir(), 'launcher-settings.json');
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveSettings(data) {
  try {
    fs.mkdirSync(getGameDir(), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // не критично
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: WINDOW_SIZE.width,
    height: WINDOW_SIZE.height,
    minWidth: WINDOW_SIZE.width,
    maxWidth: WINDOW_SIZE.width,
    minHeight: WINDOW_SIZE.height,
    maxHeight: WINDOW_SIZE.height + WINDOW_SIZE.logExtra,
    resizable: false,
    frame: false,
    transparent: true,
    roundedCorners: true,
    backgroundColor: '#00000000',
    title: config.brand.title,
    icon: path.join(__dirname, 'assets', 'app-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.on('did-finish-load', applyCpuLimitsToWindow);

  // Проброс событий лаунчера в окно.
  launcher.on('status', (s) => mainWindow?.webContents.send('launcher:status', s));
  launcher.on('log', (m) => queueLogLine(m));
  launcher.on('launched', () => mainWindow?.webContents.send('launcher:launched'));
  launcher.on('game-close', (code) => mainWindow?.webContents.send('launcher:game-close', code));
}

app.whenReady().then(() => {
  applyDiscreteGpuToProcessEnv();
  applyLauncherCpuLimit(MAX_CPU_PERCENT, process.pid);
  createWindow();
  mainWindow.webContents.once('did-finish-load', () => {
    launcher.startBackgroundUpdateLoop();
    launcher.syncModpackOnStartup().catch(() => {});
  });
});

app.on('before-quit', () => {
  launcher.stopBackgroundUpdateLoop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('news:fetch', async () => {
  const news = await fetchNews();
  let modpackRevision = null;
  let updateAvailable = false;
  try {
    const check = await checkForUpdates(getGameDir());
    if (check.ok) {
      modpackRevision = check.revision;
      updateAvailable = Boolean(check.available);
    }
  } catch {
    // не критично для новостей
  }
  return {
    ok: true,
    ...news,
    modpackRevision,
    updateAvailable
  };
});

ipcMain.handle('server:status', async () => {
  try {
    return { ok: true, ...(await fetchServerStatus()) };
  } catch (err) {
    return {
      ok: false,
      online: false,
      playersOnline: null,
      playersMax: null,
      pingMs: null,
      tps: null,
      error: formatLaunchError(err)
    };
  }
});

ipcMain.handle('app:info', async () => {
  const saved = loadSettings();
  let auth = { ok: false, login: null };
  if (saved.authSession) {
    auth = await validateSession(getGameDir(), saved.authSession);
  }
  const settings = sanitizeSettingsForRenderer({ ...config.launcherDefaults, ...saved });
  return {
    brand: config.brand,
    version: config.minecraft.version,
    forge: config.minecraft.forgeVersion,
    appVersion: config.appVersion || app.getVersion(),
    javaMajor: config.java?.major ?? 17,
    defaults: config.launcherDefaults,
    memoryOptions: [2048, 4096, 6144, 8192, 10240, 12288, 16384, 20480, 24576, 28672],
    settings,
    auth: auth.ok ? { ok: true, login: auth.login } : { ok: false, login: null }
  };
});

ipcMain.handle('settings:save', (_e, data) => {
  const current = loadSettings();
  const merged = applyRememberPassword({ ...current, ...data }, data);
  if ('password' in merged) delete merged.password;
  if ('savedPassword' in merged) delete merged.savedPassword;
  saveSettings(merged);
  return sanitizeSettingsForRenderer(merged);
});

function persistAuthSession(login, session, password, rememberPassword) {
  const current = loadSettings();
  const merged = applyRememberPassword({
    ...current,
    username: login,
    authSession: session,
    rememberPassword: rememberPassword !== false
  }, {
    rememberPassword: rememberPassword !== false,
    savedPassword: rememberPassword !== false ? password : ''
  });
  if ('savedPassword' in merged) delete merged.savedPassword;
  saveSettings(merged);
}

ipcMain.handle('auth:check', async (_e, payload) => {
  try {
    const username = String(payload?.username || '').trim();
    return await checkLoginExists(getGameDir(), username);
  } catch (err) {
    return { ok: false, exists: false, error: formatLaunchError(err) };
  }
});

ipcMain.handle('auth:register', async (_e, payload) => {
  try {
    const username = String(payload?.username || '').trim();
    const password = String(payload?.password || '');
    const confirmPassword = String(payload?.confirmPassword || '');
    const result = await registerAccount(getGameDir(), username, password, confirmPassword);
    if (!result.ok) return result;

    persistAuthSession(
      result.login,
      result.session,
      password,
      payload?.rememberPassword !== false
    );
    return { ok: true, login: result.login };
  } catch (err) {
    return { ok: false, error: formatLaunchError(err) };
  }
});

ipcMain.handle('auth:login', async (_e, payload) => {
  try {
    const username = String(payload?.username || '').trim();
    const password = String(payload?.password || '');
    if (!username || !password) {
      return { ok: false, error: 'Введите ник и пароль.' };
    }
    const result = await login(getGameDir(), username, password);
    if (!result.ok) return result;

    persistAuthSession(
      result.login,
      result.session,
      password,
      payload?.rememberPassword !== false
    );
    return { ok: true, login: result.login };
  } catch (err) {
    return { ok: false, error: formatLaunchError(err) };
  }
});

ipcMain.handle('auth:logout', () => {
  const current = loadSettings();
  const next = { ...current };
  delete next.authSession;
  saveSettings(next);
  return { ok: true };
});

ipcMain.handle('game:launch', async (_e, username) => {
  try {
    const nick = String(username || '').trim();
    if (!nick) {
      return { ok: false, error: 'Введите ник.' };
    }
    const current = loadSettings();
    saveSettings({ ...current, username: nick.toLowerCase() });
    await launcher.launch(nick);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: formatLaunchError(err) };
  }
});

ipcMain.handle('update:check', async () => {
  try {
    return { ok: true, ...(await launcher.checkModpackUpdates()) };
  } catch (err) {
    return { ok: false, error: formatLaunchError(err), available: false };
  }
});

ipcMain.handle('modpack:sync', async () => {
  if (launcher.gameRunning) {
    return { ok: false, error: 'Закройте игру перед обновлением.' };
  }
  try {
    await launcher.syncModpackOnStartup();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: formatLaunchError(err) };
  }
});

ipcMain.handle('update:apply', async () => {
  if (launcher.gameRunning) {
    return { ok: false, error: 'Закройте игру перед обновлением.' };
  }
  try {
    const result = await launcher.applyModpackUpdates();
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: formatLaunchError(err) };
  }
});

ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:close', () => mainWindow?.close());

ipcMain.on('window:log-panel', (_e, payload) => {
  const open = typeof payload === 'boolean' ? payload : Boolean(payload?.open);
  const animate = typeof payload === 'boolean' ? true : payload?.animate !== false;
  const target = open ? WINDOW_SIZE.height + WINDOW_SIZE.logExtra : WINDOW_SIZE.height;
  if (animate) animateWindowHeight(target, LOG_ANIM_MS);
  else applyWindowHeight(target);
});
