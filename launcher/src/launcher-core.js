'use strict';

const { EventEmitter } = require('events');
const { Client } = require('minecraft-launcher-core');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const crypto = require('crypto');
const { download } = require('./download');
const { spawnSync } = require('child_process');

const config = require('./config');
const { getGameDir } = require('./paths');
const {
  extractContentToGame,
  resolveContentMeta,
  isModpackInstalled
} = require('./content-pack');
const { applyGameOptions } = require('./game-options');
const { ensureJava17 } = require('./java-runtime');
const { withJavaOnDiscreteGpu } = require('./gpu-env');
const {
  checkForUpdates,
  applyUpdates,
  applyManifestRemovals,
  refreshStateFromDisk,
  resolveBundledManifest,
  ensureCriticalModJars
} = require('./modpack-sync');

// Стабильный оффлайн-UUID на основе ника (как у самого Minecraft).
function offlineUUID(name) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30; // версия 3
  hash[8] = (hash[8] & 0x3f) | 0x80; // вариант
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function buildOfflineAuth(username) {
  const uuid = offlineUUID(username);
  return {
    access_token: uuid,
    client_token: uuid,
    uuid,
    name: username,
    user_properties: '{}',
    meta: { type: 'mojang', demo: false }
  };
}

// Проверка мажорной версии Java по пути к java.exe.
function javaMajorVersion(javaExe) {
  try {
    const res = spawnSync(javaExe, ['-version'], { encoding: 'utf8' });
    const out = `${res.stderr || ''}${res.stdout || ''}`;
    const m = out.match(/version "(\d+)(?:\.(\d+))?/);
    if (!m) return null;
    let major = parseInt(m[1], 10);
    if (major === 1 && m[2]) major = parseInt(m[2], 10); // старый формат 1.8
    return major;
  } catch {
    return null;
  }
}

// Поиск подходящей Java (17+) для Forge 1.20.1, предпочтительно 17 или 21.
function findJava() {
  const candidates = [];
  if (process.env.JAVA_HOME) {
    candidates.push(path.join(process.env.JAVA_HOME, 'bin', 'java.exe'));
  }
  const programFiles = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['ProgramW6432']
  ].filter(Boolean);
  const vendors = ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'AdoptOpenJDK', 'Amazon Corretto'];
  for (const pf of programFiles) {
    for (const vendor of vendors) {
      const dir = path.join(pf, vendor);
      try {
        for (const entry of fs.readdirSync(dir)) {
          candidates.push(path.join(dir, entry, 'bin', 'java.exe'));
        }
      } catch {
        // каталога нет — пропускаем
      }
    }
  }
  candidates.push('java'); // последний шанс — PATH

  const valid = [];
  for (const c of candidates) {
    if (c !== 'java' && !fs.existsSync(c)) continue;
    const major = javaMajorVersion(c);
    if (major && major >= 17) valid.push({ path: c, major });
  }
  if (valid.length === 0) return null;
  // Для Forge 1.20.1 предпочитаем Java 17 (самая совместимая), затем 21.
  valid.sort((a, b) => {
    const score = (v) => (v === 17 ? 0 : v === 21 ? 1 : 2 + Math.abs(v - 18));
    return score(a.major) - score(b.major);
  });
  return valid[0].path;
}

// Проверка, что jar — валидный zip-архив Forge-установщика.
function isValidForgeInstaller(file) {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < 1024 * 1024) return false;
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(file);
    const names = zip.getEntries().map((e) => e.entryName);
    return names.includes('install_profile.json') && names.includes('version.json');
  } catch {
    return false;
  }
}

// Рекурсивное копирование каталога.
async function copyDir(src, dest, overwrite = true) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(s, d, overwrite);
    } else {
      // Базовый конфиг (overwrite=false) не затираем — сохраняем правки игрока,
      // но докладываем недостающие файлы.
      if (!overwrite && fs.existsSync(d)) continue;
      await fsp.copyFile(s, d);
    }
  }
}

class GameLauncher extends EventEmitter {
  constructor() {
    super();
    this.gameDir = getGameDir();
    this.client = new Client();
    this.gameRunning = false;
  }

  log(msg) {
    this.emit('log', msg);
  }

  status(text, progress) {
    this.emit('status', { text, progress: typeof progress === 'number' ? progress : null });
  }

  // Где искать сборку модов.
  resolveModpackSource() {
    if (config.modpackSource && fs.existsSync(config.modpackSource)) {
      return config.modpackSource;
    }
    // В упакованном приложении сборка кладётся в resources/svo-build.
    const packaged = path.join(process.resourcesPath || '', 'svo-build');
    if (fs.existsSync(packaged)) return packaged;
    // В режиме разработки — папка svo-build рядом с launcher/.
    const dev = path.join(__dirname, '..', '..', 'svo-build');
    if (fs.existsSync(dev)) return dev;
    return null;
  }

  resolveModpackArchive() {
    // Только для режима разработки без content.7z.
    const dev = path.join(__dirname, '..', 'resources', 'modpack.dat');
    if (fs.existsSync(dev)) return dev;
    return null;
  }

  async extractEmbeddedModpack() {
    await extractContentToGame(this.gameDir, (m) => this.log(m), (t, p) => this.status(t, p));
    const modsDir = path.join(this.gameDir, 'mods');
    await this.stripBlockedMods(modsDir);
  }

  forgeProfileId() {
    const { version, forgeVersion } = config.minecraft;
    return `${version}-forge-${forgeVersion}`;
  }

  isMinecraftRuntimeReady() {
    const { version } = config.minecraft;
    const clientJar = path.join(this.gameDir, 'versions', version, `${version}.jar`);
    // MCLC кладёт Forge JSON в forge/<mcVersion>/ (например forge/1.20.1/), не в id профиля.
    const forgeJson = path.join(this.gameDir, 'forge', version, 'version.json');
    const libraries = path.join(this.gameDir, 'libraries');
    if (!fs.existsSync(clientJar) || !fs.existsSync(forgeJson)) return false;
    try {
      const meta = JSON.parse(fs.readFileSync(forgeJson, 'utf8'));
      if (meta.id !== this.forgeProfileId()) return false;
      return fs.readdirSync(libraries).length > 0;
    } catch {
      return false;
    }
  }

  async modsNeedInstall() {
    const meta = resolveContentMeta();
    if (meta && isModpackInstalled(this.gameDir, meta)) {
      return false;
    }
    const modsDir = path.join(this.gameDir, 'mods');
    try {
      const entries = await fsp.readdir(modsDir);
      return !entries.some((n) => n.toLowerCase().endsWith('.jar'));
    } catch {
      return true;
    }
  }

  async stripBlockedMods(modsDir) {
    const entries = await fsp.readdir(modsDir);
    for (const name of entries) {
      const lower = name.toLowerCase();
      const remove =
        lower.startsWith('fancymenu') ||
        lower.startsWith('fancymenu_') ||
        lower.includes('hcompass') ||
        lower.includes('bfcrr') ||
        lower.includes('cameraoverhaul') ||
        lower.includes('wrecked') ||
        lower.includes('mcsp-1.20.1') ||
        lower.includes('dragonrise_reforge') ||
        lower.includes('vvp-beta') ||
        lower.includes('ywzj_vehicle') ||
        lower.includes('superbwarfare-1.20.1-0.8.8') ||
        (lower.startsWith('pgcclient') && lower.endsWith('.jar') && lower !== `${config.clientModId}-${config.appVersion}.jar`.toLowerCase())
        || (lower.startsWith('svoclient') && lower.endsWith('.jar'));
      if (remove) {
        await fsp.rm(path.join(modsDir, name), { force: true });
        this.log(`Удалён мод: ${name}`);
      }
    }
  }

  async syncBaseFiles() {
    const source = this.resolveModpackSource();
    if (!source) return;
    const configFrom = path.join(source, 'config');
    if (fs.existsSync(configFrom)) {
      await copyDir(configFrom, path.join(this.gameDir, 'config'), false);
      const xaeroFrom = path.join(configFrom, 'xaero');
      const xaeroTo = path.join(this.gameDir, 'config', 'xaero');
      if (fs.existsSync(xaeroFrom)) {
        await copyDir(xaeroFrom, xaeroTo, false);
      }
      this.log('Базовый config/ применён.');
    }
    const shadersFrom = path.join(source, 'shaderpacks');
    if (fs.existsSync(shadersFrom)) {
      await copyDir(shadersFrom, path.join(this.gameDir, 'shaderpacks'), false);
      this.log('Паки шейдеров применены.');
    }
  }

  loadLauncherSettings() {
    try {
      const file = path.join(getGameDir(), 'launcher-settings.json');
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  }

  async autoApplyModpackUpdates() {
    const check = await checkForUpdates(this.gameDir);
    if (check.ok && check.revision > check.localRevision) {
      this.log(`Обновление сборки (рев. ${check.localRevision} → ${check.revision})…`);
    } else {
      this.log('Проверка обновлений сборки…');
    }
    this.status('Проверка обновлений…', 0);
    const result = await applyUpdates(
      this.gameDir,
      (m) => this.log(m),
      (t, p) => this.status(t, p)
    );
    const removed = await applyManifestRemovals(this.gameDir, (m) => this.log(m));
    if (removed > 0) {
      this.log(`Удалено устаревших файлов: ${removed}.`);
    }
    if (result.updated) {
      this.log(`Сборка обновлена: ${result.fileCount} файл(ов), рев. ${check.revision ?? '?'}.`);
    }
    await this.stripBlockedMods(path.join(this.gameDir, 'mods'));
    this.status('Готов к запуску', 0);
    return result;
  }

  /** Синхронизация при открытии лаунчера (до нажатия «Играть»). */
  async syncModpackOnStartup() {
    if (this.gameRunning) return { ok: true, skipped: true };
    await fsp.mkdir(this.gameDir, { recursive: true });
    if (await this.modsNeedInstall()) {
      this.log('Первая установка — полное обновление при запуске игры.');
      return { ok: true, skipped: true };
    }
    try {
      await this.autoApplyModpackUpdates();
      return { ok: true };
    } catch (e) {
      this.log(`Обновление при старте: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  async syncModpack() {
    const needMods = await this.modsNeedInstall();
    if (needMods) {
      this.status('Подготовка сборки…');
      await this.extractEmbeddedModpack();
      const bundled = resolveBundledManifest();
      if (bundled) {
        await refreshStateFromDisk(this.gameDir, bundled);
        this.log(`Манифест сборки: ревизия ${bundled.revision}.`);
      }
    } else {
      this.log('Модпак уже установлен — загрузка и распаковка пропущены.');
      await this.stripBlockedMods(path.join(this.gameDir, 'mods'));
    }
    await this.autoApplyModpackUpdates();
    const critical = await ensureCriticalModJars(this.gameDir, (m) => this.log(m));
    if (critical.updated) {
      this.log('Критичные моды сборки обновлены (pgcclient / Superb Warfare).');
    }
    await this.syncBaseFiles();
    const settings = this.loadLauncherSettings();
    const opts = await applyGameOptions(this.gameDir, this.resolveModpackSource(), {
      fullscreen: Boolean(settings.fullscreen)
    });
    if (opts.fresh) {
      this.log('Начальные настройки игры (options.txt) применены.');
    } else {
      this.log('Сохранённые настройки игры оставлены.');
    }
  }

  async checkModpackUpdates() {
    return checkForUpdates(this.gameDir);
  }

  async applyModpackUpdates() {
    const result = await applyUpdates(
      this.gameDir,
      (m) => this.log(m),
      (t, p) => this.status(t, p)
    );
    await this.stripBlockedMods(path.join(this.gameDir, 'mods'));
    return result;
  }

  forgeInstallerUrl() {
    const { version, forgeVersion } = config.minecraft;
    const id = `${version}-${forgeVersion}`;
    return `https://maven.minecraftforge.net/net/minecraftforge/forge/${id}/forge-${id}-installer.jar`;
  }

  async ensureForgeInstaller() {
    const { version, forgeVersion } = config.minecraft;
    const dir = path.join(this.gameDir, 'installers');
    await fsp.mkdir(dir, { recursive: true });
    const dest = path.join(dir, `forge-${version}-${forgeVersion}-installer.jar`);

    // Переиспользуем только валидный установщик нужной версии.
    if (isValidForgeInstaller(dest)) {
      return dest;
    }
    // Старая версия Forge — удаляем установщик и профиль, чтобы поставить новый.
    try {
      const oldForgeDir = path.join(this.gameDir, 'forge');
      if (fs.existsSync(oldForgeDir)) {
        for (const entry of fs.readdirSync(oldForgeDir)) {
          if (entry !== this.forgeProfileId()) {
            fs.rmSync(path.join(oldForgeDir, entry), { recursive: true, force: true });
            this.log(`Удалён старый профиль Forge: ${entry}`);
          }
        }
      }
    } catch {
      // не критично
    }
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith('forge-') && name.endsWith('-installer.jar') && path.join(dir, name) !== dest) {
          fs.rmSync(path.join(dir, name), { force: true });
        }
      }
    } catch {
      // ignore
    }
    fs.rmSync(dest, { force: true });

    this.status('Загрузка установщика Forge…', 0);
    await download(this.forgeInstallerUrl(), dest, (p) => {
      this.status('Загрузка установщика Forge…', p);
    });

    if (!isValidForgeInstaller(dest)) {
      fs.rmSync(dest, { force: true });
      throw new Error('Скачанный установщик Forge повреждён. Проверь интернет и запусти снова.');
    }
    this.log('Установщик Forge загружен и проверен.');
    return dest;
  }

  resolveMemory() {
    const s = this.loadLauncherSettings();
    const min = Number(s.memoryMin) || config.memory.min;
    const max = Number(s.memoryMax) || config.memory.max;
    const safeMin = Math.min(min, max);
    const safeMax = Math.max(min, max);
    return { max: `${safeMax}M`, min: `${safeMin}M` };
  }

  async launch(username) {
    if (!username || !/^[A-Za-z0-9_]{3,16}$/.test(username)) {
      throw new Error('Ник должен быть 3–16 символов: латиница, цифры и _.');
    }

    this.status('Подготовка Java 17…', 0);
    const runtimeDir = path.join(this.gameDir, 'runtime');
    const javaPath = await ensureJava17(
      runtimeDir,
      (p) => this.status('Загрузка Java 17…', p),
      (m) => this.log(m)
    );

    await fsp.mkdir(this.gameDir, { recursive: true });
    const forgeInstaller = await this.ensureForgeInstaller();
    await this.syncModpack();

    const version = { number: config.minecraft.version, type: 'release' };
    if (this.isMinecraftRuntimeReady()) {
      this.log('Minecraft и Forge уже установлены — повторная загрузка не требуется.');
    } else {
      this.log('Первый запуск: загрузка Minecraft, Forge и библиотек (далее из кэша).');
    }

    const opts = {
      authorization: buildOfflineAuth(username),
      root: this.gameDir,
      cache: path.join(this.gameDir, 'cache'),
      version,
      forge: forgeInstaller,
      memory: this.resolveMemory(),
      javaPath,
      customArgs: [...(config.jvmArgs || [])],
      overrides: {
        detached: true,
        maxSockets: 4
      }
    };

    this.status(
      this.isMinecraftRuntimeReady() ? 'Проверка файлов игры…' : 'Загрузка Minecraft и Forge…',
      0
    );

    let lastDebug = '';
    this.client.removeAllListeners();
    this.client.on('debug', (e) => { lastDebug = String(e); this.log(`[debug] ${e}`); });
    this.client.on('data', (e) => this.log(`[mc] ${String(e).trim()}`));
    this.client.on('progress', (e) => {
      const total = e.total || 1;
      const p = Math.min(1, (e.task || 0) / total);
      this.status(`Загрузка: ${e.type}…`, p);
    });
    this.client.on('download-status', (e) => {
      if (e.total) this.status(`Скачивание ресурсов…`, e.current / e.total);
    });
    this.client.on('arguments', () => this.status('Запуск Minecraft…', 1));
    this.client.on('close', async (code) => {
      this.gameRunning = false;
      this.emit('game-close', code);
    });

    this.log('Запуск игры…');
    if (process.platform === 'win32') {
      this.log('Видеокарта: режим дискретной GPU (NVIDIA/AMD).');
    }
    // minecraft-launcher-core при ЛЮБОЙ ошибке не бросает исключение,
    // а возвращает null (причина уходит в debug). Поэтому проверяем результат.
    const proc = await withJavaOnDiscreteGpu(async () => this.client.launch(opts));
    if (!proc) {
      throw new Error(`Не удалось запустить игру. ${lastDebug ? 'Причина: ' + lastDebug.replace(/^\[MCLC\]:\s*/, '') : 'Открой «Лог» для деталей.'}`);
    }

    this.status('Игра запущена', 1);
    this.gameRunning = true;
    this.emit('launched');
    return proc;
  }
}

module.exports = { GameLauncher, getGameDir, offlineUUID, findJava };
