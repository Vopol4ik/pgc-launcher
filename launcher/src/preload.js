'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('svo', {
  getInfo: () => ipcRenderer.invoke('app:info'),
  getNews: () => ipcRenderer.invoke('news:fetch'),
  getServerStatus: () => ipcRenderer.invoke('server:status'),
  login: (username, password, rememberPassword = true) =>
    ipcRenderer.invoke('auth:login', { username, password, rememberPassword }),
  checkLogin: (username) => ipcRenderer.invoke('auth:check', { username }),
  register: (username, password, confirmPassword, rememberPassword = true) =>
    ipcRenderer.invoke('auth:register', { username, password, confirmPassword, rememberPassword }),
  logout: () => ipcRenderer.invoke('auth:logout'),
  saveSettings: (data) => ipcRenderer.invoke('settings:save', data),
  launch: (username) => ipcRenderer.invoke('game:launch', username),
  checkUpdates: () => ipcRenderer.invoke('update:check'),
  applyUpdates: () => ipcRenderer.invoke('update:apply'),
  syncOnStartup: () => ipcRenderer.invoke('modpack:sync'),
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close'),
  setLogPanelOpen: (open, animate = true) =>
    ipcRenderer.send('window:log-panel', { open: Boolean(open), animate }),

  onStatus: (cb) => ipcRenderer.on('launcher:status', (_e, s) => cb(s)),
  onLog: (cb) => {
    ipcRenderer.on('launcher:log', (_e, m) => cb(m));
    ipcRenderer.on('launcher:log-batch', (_e, lines) => {
      if (Array.isArray(lines)) cb(lines);
    });
  },
  onLaunched: (cb) => ipcRenderer.on('launcher:launched', () => cb()),
  onGameClose: (cb) => ipcRenderer.on('launcher:game-close', (_e, code) => cb(code))
});
