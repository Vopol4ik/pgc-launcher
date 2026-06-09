'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
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
const { sanitizeSettingsForRenderer } = require('./credentials-store');
const { checkForUpdates } = require('./modpack-sync');
const {
  detectConnectFailure,
  detectGameErrors,
  isErrorLogLine,
  sendEncryptedLogReport
} = require('./log-report');
const { startPanelClientLoop, getMachineHwid, syncPendingRegistration } = require('./panel-client');
const {
  isRegistered,
  encryptPasswordForSettings,
  writePendingRegistration,
  hasPendingRegistration
} = require('./registration-store');
const {
  appendSessionRecord,
  appendActivity,
  appendLauncherJournalLine,
  findActiveBan
} = require('./panel-store');

let mainWindow = null;
const launcher = new GameLauncher();

const WINDOW_SIZE = { width: 1010, height: 635 };
const LOG_FLUSH_MS = 48;
const MAX_CPU_PERCENT = config.java?.maxCpuPercent ?? 75;

let logFlushTimer = null;
const logPending = [];
const launcherJournal = [];
const sessionEvents = [];
const MAX_JOURNAL_LINES = 600;
let sessionStartedAt = new Date().toISOString();
let quitReportInProgress = false;
let quitReportDone = false;
let sessionPersisted = false;
let stopPanelClient = null;

function flushLogBuffer() {
  logFlushTimer = null;
  if (!mainWindow || logPending.length === 0) return;
  const batch = logPending.splice(0);
  mainWindow.webContents.send('launcher:log-batch', batch);
}

function recordSessionEvent(type, detail) {
  const entry = {
    at: new Date().toISOString(),
    type: String(type || 'event'),
    detail: detail ? String(detail).slice(0, 500) : ''
  };
  sessionEvents.push(entry);
  appendActivity({
    type: entry.type,
    detail: entry.detail
  }).catch(() => {});
}

function handlePanelCommand(cmd) {
  const type = String(cmd?.type || '');
  if (type === 'close-launcher') {
    const reason = cmd.payload?.reason || 'Лаунчер закрыт администратором';
    recordSessionEvent('panel-close', reason);
    if (mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Project Global Conflict',
        message: reason
      }).finally(() => app.quit());
    } else {
      app.quit();
    }
    return;
  }
  if (type === 'stop-game') {
    if (launcher.stopGame()) {
      recordSessionEvent('panel-stop-game', 'game-killed');
    }
    return;
  }
  if (type === 'message') {
    const text = String(cmd.payload?.text || 'Сообщение от администратора');
    recordSessionEvent('panel-message', text.slice(0, 200));
    if (mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Администратор',
        message: text
      }).catch(() => {});
    }
  }
}

function handlePanelBan(reason) {
  const msg = reason || 'Доступ заблокирован администратором';
  recordSessionEvent('panel-ban', msg);
  if (mainWindow) {
    dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Доступ заблокирован',
      message: msg
    }).finally(() => app.quit());
  } else {
    app.quit();
  }
}

async function persistSessionRecord(outcome, detail) {
  if (sessionPersisted) return;
  sessionPersisted = true;
  const settings = loadSettings();
  await appendSessionRecord({
    startedAt: sessionStartedAt,
    endedAt: new Date().toISOString(),
    username: settings.username || null,
    outcome: outcome || 'closed',
    detail: detail || '',
    events: sessionEvents.slice(-40)
  }).catch(() => {});
}

function queueLogLine(line) {
  const entries = Array.isArray(line) ? line : [line];
  for (const entry of entries) {
    const text = String(entry);
    logPending.push(text);
    launcherJournal.push(text);
    if (launcherJournal.length > MAX_JOURNAL_LINES) launcherJournal.shift();
    appendLauncherJournalLine(text).catch(() => {});
    if (isErrorLogLine(text)) {
      recordSessionEvent('game-log', text.slice(0, 240));
    }
  }
  if (!logFlushTimer) {
    logFlushTimer = setTimeout(flushLogBuffer, LOG_FLUSH_MS);
  }
}

function reportLauncherError(reason, detail) {
  recordSessionEvent(reason, detail);
}

async function sendSessionLogOnQuit() {
  if (quitReportDone || quitReportInProgress) return null;
  const settings = loadSettings();
  if (settings.autoReportLogs === false) return null;
  if (!settings.discordWebhookUrl || !settings.logEncryptKey) return null;

  quitReportInProgress = true;
  try {
    recordSessionEvent('launcher-quit', `session=${sessionStartedAt}`);
    const result = await sendEncryptedLogReport({
      gameDir: getGameDir(),
      webhookUrl: settings.discordWebhookUrl,
      encryptPassphrase: settings.logEncryptKey,
      username: settings.username || 'unknown',
      launcherVersion: config.appVersion,
      reason: 'session-close',
      launcherLines: launcherJournal,
      sessionEvents
    });
    quitReportDone = true;
    return result;
  } finally {
    quitReportInProgress = false;
  }
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
    maxHeight: WINDOW_SIZE.height,
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
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  mainWindow.webContents.on('did-finish-load', applyCpuLimitsToWindow);

  launcher.on('status', (s) => mainWindow?.webContents.send('launcher:status', s));
  launcher.on('log', (m) => queueLogLine(m));
  launcher.on('launched', () => {
    recordSessionEvent('game-launched');
    mainWindow?.webContents.send('launcher:launched');
  });
  launcher.on('game-close', (code) => {
    mainWindow?.webContents.send('launcher:game-close', code);
    const gameDir = getGameDir();
    const detail = code != null && code !== 0 ? `exit=${code}` : 'game-closed';
    if (detectConnectFailure(gameDir)) {
      recordSessionEvent('connect-fail', detail);
    } else if (detectGameErrors(gameDir)) {
      recordSessionEvent('game-errors', detail);
    } else {
      recordSessionEvent('game-close', detail);
    }
  });
}

app.whenReady().then(async () => {
  recordSessionEvent('launcher-start', sessionStartedAt);
  applyDiscreteGpuToProcessEnv();
  applyLauncherCpuLimit(MAX_CPU_PERCENT, process.pid);
  stopPanelClient = startPanelClientLoop({
    getUsername: () => loadSettings().username || null,
    isGameRunning: () => Boolean(launcher.gameRunning),
    onBanned: handlePanelBan,
    onCommand: handlePanelCommand
  });
  createWindow();
  mainWindow.webContents.once('did-finish-load', () => {
    launcher.startBackgroundUpdateLoop();
    launcher.syncModpackOnStartup().catch((err) => {
      reportLauncherError('modpack-startup-error', formatLaunchError(err));
    });
  });
});

app.on('before-quit', (event) => {
  launcher.stopBackgroundUpdateLoop();
  persistSessionRecord('launcher-quit');
  if (quitReportDone || quitReportInProgress) return;

  const settings = loadSettings();
  if (settings.autoReportLogs === false || !settings.discordWebhookUrl || !settings.logEncryptKey) {
    return;
  }

  event.preventDefault();
  sendSessionLogOnQuit()
    .catch(() => {})
    .finally(() => {
      quitReportDone = true;
      app.quit();
    });
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

ipcMain.handle('auth:status', async () => {
  const settings = loadSettings();
  return {
    registered: isRegistered(settings),
    username: settings.username || null,
    pendingSync: await hasPendingRegistration()
  };
});

ipcMain.handle('auth:register', async (_e, payload) => {
  try {
    const nick = String(payload?.username || '').trim();
    const password = String(payload?.password || '');
    if (!/^[A-Za-z0-9_]{3,16}$/.test(nick)) {
      return { ok: false, error: 'Ник: 3–16 символов, латиница, цифры и _' };
    }
    if (password.length < 6) {
      return { ok: false, error: 'Пароль минимум 6 символов' };
    }
    const { passwordSalt, passwordHash } = encryptPasswordForSettings(password);
    const hwid = getMachineHwid();
    await writePendingRegistration({
      username: nick.toLowerCase(),
      passwordHash,
      hwid
    });
    const current = loadSettings();
    saveSettings({
      ...current,
      registered: true,
      username: nick.toLowerCase(),
      passwordSalt,
      passwordHash
    });
    recordSessionEvent('register', nick.toLowerCase());
    await syncPendingRegistration().catch(() => {});
    return {
      ok: true,
      username: nick.toLowerCase(),
      pendingSync: await hasPendingRegistration()
    };
  } catch (err) {
    return { ok: false, error: formatLaunchError(err) };
  }
});

ipcMain.handle('app:info', async () => {
  const saved = loadSettings();
  const settings = sanitizeSettingsForRenderer({ ...config.launcherDefaults, ...saved });
  return {
    brand: config.brand,
    version: config.minecraft.version,
    forge: config.minecraft.forgeVersion,
    appVersion: config.appVersion || app.getVersion(),
    javaMajor: config.java?.major ?? 17,
    defaults: config.launcherDefaults,
    memoryOptions: [2048, 4096, 6144, 8192, 10240, 12288, 16384, 20480, 24576, 28672],
    settings
  };
});

ipcMain.handle('settings:save', (_e, data) => {
  const current = loadSettings();
  const merged = { ...current, ...data };
  if (!String(data.discordWebhookUrl || '').trim() && current.discordWebhookUrl) {
    merged.discordWebhookUrl = current.discordWebhookUrl;
  }
  if (!String(data.logEncryptKey || '').trim() && current.logEncryptKey) {
    merged.logEncryptKey = current.logEncryptKey;
  }
  delete merged.password;
  delete merged.savedPassword;
  delete merged.savedPasswordEnc;
  delete merged.rememberPassword;
  delete merged.authSession;
  saveSettings(merged);
  return sanitizeSettingsForRenderer(merged);
});

ipcMain.handle('logs:report', async (_e, payload) => {
  try {
    const settings = loadSettings();
    if (!settings.discordWebhookUrl || !settings.logEncryptKey) {
      return { ok: false, error: 'В настройках укажите Discord webhook и ключ шифрования.' };
    }
    const result = await sendEncryptedLogReport({
      gameDir: getGameDir(),
      webhookUrl: settings.discordWebhookUrl,
      encryptPassphrase: settings.logEncryptKey,
      username: settings.username || payload?.username || 'unknown',
      launcherVersion: config.appVersion,
      reason: payload?.reason || 'manual',
      launcherLines: launcherJournal,
      sessionEvents
    });
    return { ok: true, filename: result.filename };
  } catch (err) {
    return { ok: false, error: formatLaunchError(err) };
  }
});

ipcMain.handle('game:launch', async (_e, username) => {
  try {
    const settings = loadSettings();
    if (!isRegistered(settings)) {
      return { ok: false, error: 'Сначала пройдите регистрацию.' };
    }
    const nick = String(username || settings.username || '').trim();
    if (!nick) {
      return { ok: false, error: 'Введите ник.' };
    }
    const ban = await findActiveBan({ player: nick, hwid: getMachineHwid() });
    if (ban) {
      return { ok: false, error: `Доступ заблокирован: ${ban.reason}` };
    }
    const current = loadSettings();
    saveSettings({ ...current, username: nick.toLowerCase() });
    await launcher.launch(nick);
    return { ok: true };
  } catch (err) {
    const msg = formatLaunchError(err);
    reportLauncherError('launch-error', msg);
    return { ok: false, error: msg };
  }
});

ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:close', () => mainWindow?.close());

app.on('will-quit', () => {
  stopPanelClient?.();
});
