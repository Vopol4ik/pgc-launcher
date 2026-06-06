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

let mainWindow = null;
const launcher = new GameLauncher();

const WINDOW_SIZE = { width: 970, height: 600, logExtra: 210 };
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

// --- IPC ---

ipcMain.handle('app:info', () => {
  const saved = loadSettings();
  return {
    brand: config.brand,
    version: config.minecraft.version,
    forge: config.minecraft.forgeVersion,
    appVersion: config.appVersion || app.getVersion(),
    javaMajor: config.java?.major ?? 17,
    defaults: config.launcherDefaults,
    memoryOptions: [2048, 4096, 6144, 8192, 10240, 12288, 16384, 20480, 24576, 28672],
    settings: { ...config.launcherDefaults, ...saved }
  };
});

ipcMain.handle('settings:save', (_e, data) => {
  const current = loadSettings();
  const merged = { ...current, ...data };
  saveSettings(merged);
  return merged;
});

ipcMain.handle('game:launch', async (_e, username) => {
  try {
    const current = loadSettings();
    saveSettings({ ...current, username });
    await launcher.launch(username);
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
