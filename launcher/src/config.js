'use strict';

const fs = require('fs');
const path = require('path');

// Версия релиза — единый источник: ../version.json (см. npm run sync-version).
function readAppVersion() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'version.json'), 'utf8');
    return JSON.parse(raw).version;
  } catch {
    try {
      return require('../package.json').version;
    } catch {
      return '0.0.0';
    }
  }
}

const appVersion = readAppVersion();
const { resolveContentUrls } = require('./github-updates');

const github = {
  /** Замените на свой GitHub-логин и репозиторий с обновлениями (публичный). */
  owner: 'Vopol4ik',
  repo: 'globalwar-updates',
  branch: 'main',
  /** Release с jar/zip — лаунчер качает отсюда при автообновлении. */
  releaseTag: 'modpack-latest'
};

const contentLegacy = {
  downloadUrl: 'https://operativniki.minerent.io/launcher/content.7z',
  manifestUrl: 'https://operativniki.minerent.io/launcher/modpack-manifest.json',
  filesBaseUrl: 'https://operativniki.minerent.io/launcher/files/'
};

const contentUrls = resolveContentUrls(github, contentLegacy);

// Центральная конфигурация лаунчера Project Global Conflict.
module.exports = {
  appVersion,

  /** id мода Forge и имя jar: pgcclient-<версия>.jar */
  clientModId: 'pgcclient',

  github,

  brand: {
    name: 'Project Global Conflict',
    shortName: 'PGC',
    title: `Project Global Conflict Launcher v${appVersion}`,
    titlebar: 'PROJECT GLOBAL CONFLICT',
    server: 'operativniki.minerent.io',
    description:
      'Клиент Project Global Conflict: Forge 1.20.1, фиксированный сервер проекта, модовое вооружение, голосовой чат и единые настройки.'
  },

  java: {
    major: 17,
    maxCpuPercent: 75
  },

  // Версия игры
  minecraft: {
    version: '1.20.1',
    // Версия Forge для 1.20.1. Полный id профиля: 1.20.1-forge-47.4.20
    forgeVersion: '47.4.20'
  },

  // Память JVM (в мегабайтах), значения по умолчанию в настройках лаунчера
  memory: {
    min: 2048,
    max: 28672
  },

  launcherDefaults: {
    memoryMin: 4096,
    memoryMax: 12288,
    fullscreen: false
  },

  // Где лежит твоя сборка модов (mods/, config/, ...).
  // По умолчанию ищем папку svo-build рядом с лаунчером.
  // Можно указать абсолютный путь, например: 'C:/Users/Intel/Desktop/SVO_mods'
  modpackSource: null,

  /** Сборка modpack (content.7z) — не в установщике, качается при первом запуске. */
  content: {
    downloadUrl: contentLegacy.downloadUrl,
    manifestUrl: contentUrls.manifestUrl,
    filesBaseUrl: contentUrls.filesBaseUrl,
    useGithubReleases: contentUrls.useGithubReleases,
    releaseTag: contentUrls.releaseTag || github.releaseTag
  },

  /** Пока лаунчер открыт — проверка GitHub каждые 2 минуты. */
  updatePollIntervalMs: 120000,

  /** JVM: меньше вылетов при долгой игре на тяжёлой сборке. */
  jvmArgs: [
    '-XX:+UseG1GC',
    '-XX:G1HeapRegionSize=16M',
    '-XX:G1ReservePercent=15',
    '-XX:MaxGCPauseMillis=200',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxMetaspaceSize=512M',
    '-XX:+DisableExplicitGC',
    '-Djava.net.preferIPv4Stack=true'
  ]
};
