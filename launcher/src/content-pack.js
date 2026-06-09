'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fsp = require('fs/promises');
const os = require('os');
const { extract7z } = require('./archive-7z');
const { download } = require('./download');
const config = require('./config');
const { isGithubConfigured, releaseContent7zUrl } = require('./github-updates');
const { filterTrustedUrls } = require('./trusted-urls');

function expectedLauncherVersion(meta) {
  return meta?.launcherVersion || null;
}

function contentMismatchMessage(meta, actualSize) {
  const needMb = meta?.size ? (meta.size / (1024 * 1024)).toFixed(0) : '?';
  const gotMb = actualSize ? (actualSize / (1024 * 1024)).toFixed(0) : '?';
  const ver = expectedLauncherVersion(meta);
  const verHint = ver ? ` (лаунчер ${ver})` : '';
  return (
    `Сборка content.7z не совпадает с этой версией лаунчера${verHint}. `
    + `Нужно ~${needMb} МБ, получено ~${gotMb} МБ — на GitHub, скорее всего, старый файл. `
    + `Администратору: npm run publish:github. `
    + `Или положите свежий content.7z из сборки в папку лаунчера (см. подсказку ниже).`
  );
}
const {
  contentCachePath,
  getContentCacheDir,
  getLauncherRoot,
  portableContentHint
} = require('./paths');

function contentDownloadUrls(meta) {
  const urls = [];
  if (Array.isArray(meta?.urls)) urls.push(...meta.urls);
  if (meta?.url) urls.push(meta.url);
  const gh = releaseContent7zUrl(config.github);
  if (gh) urls.unshift(gh);
  return filterTrustedUrls(urls);
}

function contentCacheMetaPath() {
  return `${contentCachePath()}.meta.json`;
}

function resolveContentMeta() {
  const candidates = [
    path.join(process.resourcesPath || '', 'content-meta.json'),
    path.join(__dirname, '..', 'resources', 'content-meta.json')
  ];
  const file = candidates.find((p) => fs.existsSync(p));
  if (!file) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function resolveBundledArchive() {
  const candidates = [
    path.join(process.resourcesPath || '', 'content.7z'),
    path.join(__dirname, '..', 'resources', 'content.7z')
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function resolvePortableArchive() {
  const root = getLauncherRoot();
  const candidates = [
    path.join(root, 'content.7z'),
    path.join(root, 'launcher', 'resources', 'content.7z')
  ];
  try {
    const exeDir = path.dirname(process.execPath);
    candidates.push(path.join(exeDir, 'content.7z'));
    candidates.push(path.join(path.dirname(exeDir), 'content.7z'));
  } catch {
    // ignore
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function readCacheMeta() {
  try {
    return JSON.parse(fs.readFileSync(contentCacheMetaPath(), 'utf8'));
  } catch {
    return null;
  }
}

async function writeCacheMeta(meta, sha256) {
  const sidecar = {
    sha256,
    size: meta.size,
    launcherVersion: expectedLauncherVersion(meta) || config.appVersion,
    builtAt: meta.builtAt ?? null,
    cachedAt: new Date().toISOString()
  };
  await fsp.writeFile(contentCacheMetaPath(), JSON.stringify(sidecar, null, 2), 'utf8');
}

function hashArchiveFile(archive) {
  return crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
}

/** Быстрая проверка кэша без чтения всего .7z (только sidecar + размер). */
function isCacheValidForMeta(meta) {
  const cache = contentCachePath();
  if (!meta?.sha256 || !fs.existsSync(cache)) return false;
  const stat = fs.statSync(cache);
  if (meta.size && stat.size !== meta.size) return false;
  const sidecar = readCacheMeta();
  const wantVer = expectedLauncherVersion(meta) || config.appVersion;
  if (sidecar?.launcherVersion && sidecar.launcherVersion !== wantVer) return false;
  return sidecar?.sha256 === meta.sha256;
}

async function verifyArchiveFile(archive, meta, log) {
  if (!meta?.sha256) {
    throw new Error('content-meta.json повреждён: нет sha256.');
  }
  const sidecar = readCacheMeta();
  const stat = fs.statSync(archive);
  if (sidecar?.sha256 === meta.sha256 && (!meta.size || stat.size === meta.size)) {
    return { archive, meta };
  }
  if (meta.size && stat.size !== meta.size) {
    throw new Error(contentMismatchMessage(meta, stat.size));
  }
  log?.('Проверка целостности сборки (один раз)…');
  const hash = hashArchiveFile(archive);
  if (hash !== meta.sha256) {
    throw new Error(contentMismatchMessage(meta, stat.size));
  }
  await writeCacheMeta(meta, hash);
  return { archive, meta };
}

async function copyToCache(archive, meta, log) {
  const cache = contentCachePath();
  await fsp.mkdir(path.dirname(cache), { recursive: true });
  if (path.resolve(archive) !== path.resolve(cache)) {
    await fsp.copyFile(archive, cache);
  }
  return verifyArchiveFile(cache, meta, log);
}

async function downloadContentArchive(meta, log, status) {
  const urls = contentDownloadUrls(meta);
  if (!urls.length) {
    throw new Error(
      'Сборка не найдена. Положите content.7z рядом с лаунчером или укажите URL в настройках проекта.'
    );
  }

  const cache = contentCachePath();
  await fsp.mkdir(path.dirname(cache), { recursive: true });
  const tmp = `${cache}.download`;
  const sizeMb = meta?.size ? (meta.size / (1024 * 1024)).toFixed(0) : '?';

  let lastErr = null;
  for (const url of urls) {
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch {
      // ignore
    }
    log?.(`Скачивание сборки (${sizeMb} МБ) с ${host}…`);
    status?.('Скачивание сборки…', 0);
    await fsp.rm(tmp, { force: true });
    try {
      await download(url, tmp, (p) => status?.('Скачивание сборки…', p));
      await fsp.rm(cache, { force: true });
      await fsp.rm(contentCacheMetaPath(), { force: true });
      await fsp.rename(tmp, cache);
      const downloadedSize = fs.statSync(cache).size;
      if (meta.size && downloadedSize !== meta.size) {
        await fsp.rm(cache, { force: true });
        await fsp.rm(contentCacheMetaPath(), { force: true });
        throw new Error(contentMismatchMessage(meta, downloadedSize));
      }
      log?.('Сборка загружена в кэш.');
      return verifyArchiveFile(cache, meta, log);
    } catch (e) {
      lastErr = e;
      log?.(`Загрузка не удалась (${host}): ${e.message}`);
      await fsp.rm(tmp, { force: true });
    }
  }

  throw lastErr || new Error('Не удалось скачать сборку ни с одного зеркала.');
}

async function ensureContentArchive(log, status) {
  const meta = resolveContentMeta();
  if (!meta) {
    throw new Error('content-meta.json не найден в лаунчере.');
  }

  const cache = contentCachePath();
  if (isCacheValidForMeta(meta)) {
    log?.('Сборка в кэше — повторная загрузка не нужна.');
    return { archive: cache, meta };
  }

  if (fs.existsSync(cache)) {
    try {
      return await verifyArchiveFile(cache, meta, log);
    } catch (e) {
      log?.(`Кэш сборки недействителен: ${e.message}`);
      await fsp.rm(cache, { force: true });
      await fsp.rm(contentCacheMetaPath(), { force: true });
    }
  }

  const bundled = resolveBundledArchive();
  if (bundled) {
    log?.('Сборка из встроенного архива лаунчера.');
    return copyToCache(bundled, meta, log);
  }

  const portable = resolvePortableArchive();
  if (portable) {
    log?.('Сборка из content.7z рядом с лаунчером.');
    try {
      return await copyToCache(portable, meta, log);
    } catch (e) {
      log?.(`Локальный content.7z не подходит: ${e.message}`);
    }
  }

  try {
    return await downloadContentArchive(meta, log, status);
  } catch (e) {
    const sizeMb = meta?.size ? (meta.size / (1024 * 1024)).toFixed(0) : '?';
    const hint =
      `Проверьте интернет. Сборка (~${sizeMb} МБ) скачивается в папку лаунчера при первом запуске `
      + `(кэш: ${getContentCacheDir()}). ${portableContentHint()}`;
    const msg = e?.message || String(e);
    if (/HTTP 404|не удалось скачать/i.test(msg)) {
      throw new Error(
        `${msg} Загрузите content.7z в GitHub Release «${config.github?.releaseTag || 'modpack-latest'}» `
          + `(${config.github?.owner}/${config.github?.repo}) или ${portableContentHint()}`
      );
    }
    throw new Error(`${msg}. ${hint}`);
  }
}

function installMarkerPath(gameDir) {
  return path.join(gameDir, '.gw-content-installed.json');
}

async function writeInstallMarker(gameDir, meta) {
  const sidecar = readCacheMeta();
  await fsp.writeFile(
    installMarkerPath(gameDir),
    JSON.stringify({
      contentSha256: meta.sha256,
      contentSize: meta.size,
      cacheSha256: sidecar?.sha256 ?? meta.sha256,
      installedAt: new Date().toISOString()
    }, null, 2),
    'utf8'
  );
}

function isModpackInstalled(gameDir, meta) {
  if (!meta?.sha256) return false;
  try {
    const marker = JSON.parse(fs.readFileSync(installMarkerPath(gameDir), 'utf8'));
    if (marker.contentSha256 !== meta.sha256) return false;
  } catch {
    return false;
  }
  const modsDir = path.join(gameDir, 'mods');
  try {
    return fs.readdirSync(modsDir).some((n) => n.toLowerCase().endsWith('.jar'));
  } catch {
    return false;
  }
}

async function extractContentToGame(gameDir, log, status) {
  const meta = resolveContentMeta();
  const { archive } = await ensureContentArchive(log, status);
  const tmp = path.join(os.tmpdir(), `gw-content-${crypto.randomBytes(8).toString('hex')}`);
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.mkdir(tmp, { recursive: true });

  status('Распаковка сборки…', 0);
  const extractOpts = await extract7z(archive, tmp);
  log?.(
    `Распаковка: лимит CPU ~${extractOpts.maxCpuPercent}% (${extractOpts.threads === 'on' ? 'все ядра' : `${extractOpts.threads} поток(ов)`} 7-Zip).`
  );

  const modsDir = path.join(gameDir, 'mods');
  await fsp.rm(modsDir, { recursive: true, force: true });
  await fsp.mkdir(modsDir, { recursive: true });

  const entries = await fsp.readdir(tmp, { withFileTypes: true });
  const unpackModpackDat = async (datPath) => {
    const AdmZip = require('adm-zip');
    new AdmZip(datPath).extractAllTo(modsDir, true);
  };

  for (const entry of entries) {
    const src = path.join(tmp, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'tacz_default_gun') {
        await copyDir(src, path.join(gameDir, 'tacz', 'tacz_default_gun'));
      }
      continue;
    }
    if (entry.name === 'modpack.dat') {
      await unpackModpackDat(src);
      continue;
    }
    const lower = entry.name.toLowerCase();
    if (lower.endsWith('.jar')) {
      await fsp.copyFile(src, path.join(modsDir, entry.name));
      continue;
    }
    if (lower.endsWith('.zip') && isShaderPackZip(entry.name)) {
      const shadersDir = path.join(gameDir, 'shaderpacks');
      await fsp.mkdir(shadersDir, { recursive: true });
      await fsp.copyFile(src, path.join(shadersDir, entry.name));
      continue;
    }
    if (lower.endsWith('.zip') || lower.endsWith('.toml') || lower.endsWith('.json')) {
      await fsp.mkdir(path.join(gameDir, 'tacz'), { recursive: true });
      await fsp.copyFile(src, path.join(gameDir, 'tacz', entry.name));
    }
  }

  const jarNames = (await fsp.readdir(modsDir)).filter((n) => n.toLowerCase().endsWith('.jar'));
  if (jarNames.length < 10) {
    throw new Error(
      `В mods/ только ${jarNames.length} файлов — распаковка неполная. Удалите папку client и нажмите ИГРАТЬ снова.`
    );
  }
  if (!jarNames.some((n) => /geckolib/i.test(n))) {
    throw new Error(
      'Не найден geckolib. Перекачайте сборку (ИГРАТЬ) или добавьте geckolib-forge-1.20.1-4.8.3.jar в mods/.'
    );
  }

  await fsp.rm(tmp, { recursive: true, force: true });
  if (meta) await writeInstallMarker(gameDir, meta);
  log(`Сборка распакована (${jarNames.length} модов).`);
}

function isShaderPackZip(name) {
  const lower = name.toLowerCase();
  return (
    lower.startsWith('photon_')
    || lower.includes('complementary')
    || lower.includes('bsl')
    || lower.includes('solas')
    || lower.includes('bliss')
  );
}

async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  for (const name of await fsp.readdir(src)) {
    const s = path.join(src, name);
    const d = path.join(dest, name);
    if ((await fsp.stat(s)).isDirectory()) {
      await copyDir(s, d);
    } else {
      await fsp.copyFile(s, d);
    }
  }
}

module.exports = {
  extractContentToGame,
  ensureContentArchive,
  contentCachePath,
  resolveContentMeta,
  isModpackInstalled,
  isCacheValidForMeta
};
