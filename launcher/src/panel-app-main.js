'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const {
  startPanelServer,
  stopPanelServer,
  getPanelServerInfo
} = require('./panel-server');
const { ensurePanelData, readLauncherJournalFile } = require('./panel-store');

if (process.platform === 'win32') {
  app.commandLine.appendSwitch('force-high-performance-gpu');
}

let mainWindow = null;

function getPanelLiveData() {
  return {
    settings: {},
    sessionStartedAt: null,
    sessionEvents: [],
    launcherJournal: readLauncherJournalFile(),
    panelUrl: getPanelServerInfo().url
  };
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'PGC Panel',
    backgroundColor: '#07090d',
    icon: path.join(__dirname, 'assets', 'app-icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(url);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, nextUrl) => {
    if (!nextUrl.startsWith('http://127.0.0.1:')) {
      event.preventDefault();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  await ensurePanelData();
  const info = await startPanelServer(getPanelLiveData);
  createWindow(info.url);
});

app.on('window-all-closed', () => {
  stopPanelServer();
  app.quit();
});

app.on('activate', async () => {
  if (mainWindow) return;
  const info = getPanelServerInfo();
  if (!info.running) await startPanelServer(getPanelLiveData);
  createWindow(getPanelServerInfo().url);
});

app.on('will-quit', () => {
  stopPanelServer();
});
