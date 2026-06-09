'use strict';

const fs = require('fs');
const path = require('path');

// Версия релиза — единый источник: version.json (в resources при сборке или в корне репо).
function readVersionMeta() {
  const candidates = [
    path.join(process.resourcesPath || '', 'version.json'),
    path.join(__dirname, '..', '..', 'version.json')
  ];
  for (const file of candidates) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // try next
    }
  }
  try {
    return { version: require('../package.json').version };
  } catch {
    return { version: '0.0.0' };
  }
}

const versionMeta = readVersionMeta();
const appVersion = versionMeta.version || '0.0.0';
const clientModId = versionMeta.clientModId || 'pgcclient';
/** Версия jar pgcclient в сборке (не обязана совпадать с версией лаунчера). */
const clientModVersion = versionMeta.clientModVersion || '2.1.0';
const clientModJarName = `${clientModId}-${clientModVersion}.jar`;
const clientModRel = `mods/${clientModJarName}`;
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
  downloadUrl: null,
  manifestUrl: null,
  filesBaseUrl: null
};

const contentUrls = resolveContentUrls(github, contentLegacy);

// Центральная конфигурация лаунчера Project Global Conflict.
module.exports = {
  appVersion,
  clientModVersion,

  clientModId,
  clientModJarName,
  clientModRel,

  github,

  brand: {
    name: 'Project Global Conflict',
    shortName: 'PGC',
    title: `Project Global Conflict Launcher v${appVersion}`,
    titlebar: 'PROJECT GLOBAL CONFLICT',
    server: 'operativniki.minerent.io',
    /** Опционально: JSON с полем tps для блока статуса в лаунчере. */
    statusUrl: null,
    description:
      'Клиент Project Global Conflict: Forge 1.20.1, фиксированный сервер проекта, модовое вооружение, голосовой чат и единые настройки.'
  },

  java: {
    major: 17,
    maxCpuPercent: 75
  },

  /** Распаковка content.7z: лимит ядер процесса 7-Zip (affinity). */
  extractCpuPercent: 85,

  /** Потоки 7-Zip: 0 = все ядра (-mmt=on), иначе точное число. */
  extractThreads: 0,

  /** Параллельных загрузок файлов модпака. */
  downloadConcurrency: 6,

  /** Одновременных HTTP-соединений при загрузке. */
  maxDownloadSockets: 8,

  // Версия игры
  minecraft: {
    version: '1.20.1',
    // Версия Forge для 1.20.1. Полный id профиля: 1.20.1-forge-47.4.20
    forgeVersion: '47.4.20'
  },

  // Память JVM (в мегабайтах), значения по умолчанию в настройках лаунчера
  memory: {
    min: 2048,
    max: 28672,
    maxCap: 16384
  },

  logReport: {
    maxLogBytes: 1_500_000,
    autoOnQuit: true
  },

  /**
   * Админ-панель: npm run panel (отдельно от лаунчера игроков).
   * remoteUrl — адрес панели для лаунчеров игроков (http://IP:17890).
   */
  panel: {
    host: '127.0.0.1',
    bindHost: '127.0.0.1',
    port: 17890,
    clientSecret: 'PGC-Panel-Client-2026',
    remoteUrl: null,
    remoteHost: '127.0.0.1',
    pollIntervalMs: 5000
  },

  launcherDefaults: {
    memoryMin: 4096,
    memoryMax: 12288,
    fullscreen: false,
    uiFont: 'default',
    discordWebhookUrl: '',
    logEncryptKey: '',
    autoReportLogs: true
  },

  // Где лежит твоя сборка модов (mods/, config/, ...).
  // По умолчанию ищем папку svo-build рядом с лаунчером.
  // Можно указать абсолютный путь, например: 'C:/Users/Intel/Desktop/SVO_mods'
  modpackSource: null,

  /** Сборка modpack (content.7z) — только GitHub Releases (см. trusted-urls.js). */
  content: {
    downloadUrl: null,
    manifestUrl: contentUrls.manifestUrl,
    filesBaseUrl: contentUrls.filesBaseUrl,
    useGithubReleases: contentUrls.useGithubReleases,
    releaseTag: contentUrls.releaseTag || github.releaseTag
  },

  /** Пока лаунчер открыт — проверка обновлений modpack (без перезапуска). */
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
    '-Djava.net.preferIPv4Stack=true',
    '-Dorg.lwjgl.system.allocator=system'
  ]
};
