'use strict';

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

function getGameDir() {
  return path.join(getLauncherRoot(), 'client');
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
  getContentCacheDir,
  contentCachePath,
  portableContentHint
};
