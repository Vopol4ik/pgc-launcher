'use strict';

const fs = require('fs');
const path = require('path');

function isDevRuntime() {
  const exe = path.basename(process.execPath).toLowerCase();
  return exe === 'electron.exe' || exe === 'node.exe';
}

/** Корень данных: папка с .exe (установка) или корень репозитория при разработке. */
function getLauncherRoot() {
  if (isDevRuntime()) {
    return path.resolve(__dirname, '..', '..');
  }
  return path.dirname(process.execPath);
}

function gameDirCandidates() {
  const root = getLauncherRoot();
  const localAppData = process.env.LOCALAPPDATA || '';
  const list = [
    process.env.PGC_CLIENT_DIR,
    path.join(root, 'client'),
    path.join(root, '..', 'Project Global Conflict Launcher', 'client'),
    localAppData && path.join(localAppData, 'Programs', 'Project Global Conflict Launcher', 'client'),
    localAppData && path.join(localAppData, 'Programs', 'PGC Panel', 'client')
  ].filter(Boolean);
  return [...new Set(list)];
}

function getGameDir() {
  for (const dir of gameDirCandidates()) {
    try {
      if (fs.existsSync(dir)) return dir;
    } catch {
      // skip
    }
  }
  return path.join(getLauncherRoot(), 'client');
}

function getPanelExeCandidates() {
  const root = getLauncherRoot();
  const localAppData = process.env.LOCALAPPDATA || '';
  return [
    path.join(root, 'PGC Panel.exe'),
    path.join(root, '..', 'PGC Panel', 'PGC Panel.exe'),
    localAppData && path.join(localAppData, 'Programs', 'PGC Panel', 'PGC Panel.exe')
  ].filter(Boolean);
}

function findPanelExe() {
  for (const file of getPanelExeCandidates()) {
    try {
      if (fs.existsSync(file)) return file;
    } catch {
      // skip
    }
  }
  return null;
}

function getContentCacheDir() {
  return path.join(getLauncherRoot(), 'cache');
}

function contentCachePath() {
  return path.join(getContentCacheDir(), 'content.7z');
}

function portableContentHint() {
  const root = getLauncherRoot();
  if (isDevRuntime()) {
    return `Оффлайн: положите content.7z в ${root}`;
  }
  return `Оффлайн: положите content.7z в ${root}`;
}

module.exports = {
  isDevRuntime,
  getLauncherRoot,
  getGameDir,
  gameDirCandidates,
  findPanelExe,
  getContentCacheDir,
  contentCachePath,
  portableContentHint
};
