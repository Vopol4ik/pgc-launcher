'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('svo', {
  getInfo: () => ipcRenderer.invoke('app:info'),
  getNews: () => ipcRenderer.invoke('news:fetch'),
  getServerStatus: () => ipcRenderer.invoke('server:status'),
  saveSettings: (data) => ipcRenderer.invoke('settings:save', data),
  launch: (username) => ipcRenderer.invoke('game:launch', username),
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close'),

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
