'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('./config');
const { download, fetchJson } = require('./download');
const { formatLaunchError } = require('./errors');
const { isGithubConfigured, releaseDownloadUrl } = require('./github-updates');

function statePath(gameDir) {
  return path.join(gameDir, '.gw-modpack-state.json');
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function resolveBundledManifest() {
  const candidates = [
    path.join(process.resourcesPath || '', 'modpack-manifest.json'),
    path.join(__dirname, '..', 'resources', 'modpack-manifest.json')
  ];
  const file = candidates.find((p) => fs.existsSync(p));
  if (!file) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function fetchRemoteManifest() {
  const url = config.content?.manifestUrl;
  if (!url) return null;
  const bust = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
  return fetchJson(bust);
}

function resolveClientModEntry(manifest) {
  if (!manifest?.files?.length) return null;
  const preferred = config.clientModRel.replace(/\\/g, '/');
  const exact = manifest.files.find((f) => f.path.replace(/\\/g, '/') === preferred);
  if (exact) return exact;
  return manifest.files.find((f) => /^mods\/pgcclient-.+\.jar$/i.test(f.path.replace(/\\/g, '/'))) || null;
}

function allowedClientModNames(manifest) {
  const names = new Set([config.clientModJarName.toLowerCase()]);
  const entry = resolveClientModEntry(manifest);
  if (entry) names.add(path.basename(entry.path).toLowerCase());
  return names;
}

function fileUrl(manifest, entry) {
  if (entry.url) return entry.url;
  if (config.content?.useGithubReleases && isGithubConfigured(config.github)) {
    return releaseDownloadUrl(config.github, entry.path);
  }
  const base = manifest.baseUrl || config.content?.filesBaseUrl;
  if (!base) return null;
  const normalized = entry.path.replace(/\\/g, '/');
  return `${base.replace(/\/$/, '')}/${normalized.split('/').map(encodeURIComponent).join('/')}`;
}

function downloadUrlsForEntry(manifest, entry) {
  const urls = [];
  const primary = fileUrl(manifest, entry);
  if (primary) urls.push(primary);

  const rel = entry.path.replace(/\\/g, '/');
  const clientEntry = resolveClientModEntry(manifest);
  const clientRel = clientEntry?.path.replace(/\\/g, '/') || config.clientModRel;
  if (rel === clientRel && config.content?.useGithubReleases && isGithubConfigured(config.github)) {
    // На GitHub часто лежит только mods__pgcclient-2.0.0.jar (тот же sha256).
    urls.push(releaseDownloadUrl(config.github, `mods/${config.clientModId}-2.0.0.jar`));
  }
  return [...new Set(urls)];
}

async function downloadEntryFile(urls, dest, onProgress) {
  let lastErr = null;
  for (const url of urls) {
    try {
      await fsp.rm(dest, { force: true });
      await download(url, dest, onProgress);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Не удалось загрузить файл');
}

async function runWithConcurrency(items, limit, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(Math.max(1, limit), queue.length || 1) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item === undefined) break;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

async function downloadModpackEntry(manifest, entry, gameDir, log, onProgress) {
  const urls = downloadUrlsForEntry(manifest, entry);
  if (urls.length === 0) {
    throw new Error(`Нет URL для ${entry.path}. Проверьте filesBaseUrl на сервере.`);
  }

  const dest = path.join(gameDir, entry.path);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.download`;

  log?.(`Загрузка: ${entry.path} (${((entry.size || 0) / (1024 * 1024)).toFixed(1)} МБ)…`);
  await downloadEntryFile(urls, tmp, onProgress);

  const hash = sha256File(tmp);
  if (hash !== entry.sha256) {
    await fsp.rm(tmp, { force: true });
    throw new Error(`Файл повреждён после загрузки: ${entry.path}`);
  }

  await fsp.rm(dest, { force: true });
  await fsp.rename(tmp, dest);
  log?.(`Установлен: ${entry.path}`);
}

function readLocalState(gameDir) {
  try {
    return JSON.parse(fs.readFileSync(statePath(gameDir), 'utf8'));
  } catch {
    return { revision: 0, files: {} };
  }
}

async function writeLocalState(gameDir, manifest) {
  const files = {};
  for (const entry of manifest.files || []) {
    const local = path.join(gameDir, entry.path);
    if (fs.existsSync(local)) {
      files[entry.path] = sha256File(local);
    }
  }
  await fsp.mkdir(gameDir, { recursive: true });
  await fsp.writeFile(
    statePath(gameDir),
    JSON.stringify(
      {
        revision: manifest.revision ?? 0,
        files,
        updatedAt: new Date().toISOString()
      },
      null,
      2
    ),
    'utf8'
  );
}

async function finalizeLocalState(gameDir, manifest, { downloaded = [], removed = [] } = {}) {
  const localState = readLocalState(gameDir);
  const files = { ...(localState.files || {}) };
  for (const rel of removed) {
    delete files[rel];
  }
  for (const entry of downloaded) {
    files[entry.path] = entry.sha256;
  }
  await fsp.mkdir(gameDir, { recursive: true });
  await fsp.writeFile(
    statePath(gameDir),
    JSON.stringify(
      {
        revision: manifest.revision ?? 0,
        files,
        updatedAt: new Date().toISOString()
      },
      null,
      2
    ),
    'utf8'
  );
}

function isQuickUpToDate(gameDir, manifest) {
  const localState = readLocalState(gameDir);
  if ((manifest.revision ?? 0) > (localState.revision ?? 0)) return false;
  if (!localState.files || Object.keys(localState.files).length === 0) return false;

  const removePending = (manifest.remove || []).some((rel) => fs.existsSync(path.join(gameDir, rel)));
  if (removePending) return false;

  for (const entry of manifest.files || []) {
    if (!fs.existsSync(path.join(gameDir, entry.path))) return false;
  }

  const clientEntry = resolveClientModEntry(manifest);
  if (clientEntry && localFileHash(gameDir, clientEntry.path) !== clientEntry.sha256) return false;

  return true;
}

function filterEntriesNeedingDownload(gameDir, entries) {
  const stillNeed = [];
  for (const entry of entries) {
    if (localFileHash(gameDir, entry.path) !== entry.sha256) {
      stillNeed.push(entry);
    }
  }
  return stillNeed;
}

async function refreshStateFromDisk(gameDir, manifest) {
  if (!manifest) return;
  await writeLocalState(gameDir, manifest);
}

function localFileHash(gameDir, relPath) {
  const local = path.join(gameDir, relPath);
  if (!fs.existsSync(local)) return null;
  try {
    return sha256File(local);
  } catch {
    return null;
  }
}

function planSync(gameDir, manifest, { verifyDisk = false } = {}) {
  const toDownload = [];
  const toRemove = [...(manifest.remove || [])];
  const removeSet = new Set((manifest.remove || []).map((rel) => rel.replace(/\\/g, '/')));
  let totalBytes = 0;
  const localState = readLocalState(gameDir);
  const stateFiles = localState.files || {};

  for (const entry of manifest.files || []) {
    const rel = entry.path.replace(/\\/g, '/');
    if (removeSet.has(rel)) continue;
    const local = path.join(gameDir, entry.path);
    if (!fs.existsSync(local)) {
      toDownload.push(entry);
      totalBytes += entry.size || 0;
      continue;
    }
    let hash = stateFiles[entry.path] ?? null;
    if (hash === null || verifyDisk) {
      hash = localFileHash(gameDir, entry.path);
    }
    if (hash !== entry.sha256) {
      toDownload.push(entry);
      totalBytes += entry.size || 0;
    }
  }

  const available =
    toDownload.length > 0
    || toRemove.some((rel) => fs.existsSync(path.join(gameDir, rel)))
    || (manifest.revision ?? 0) > (localState.revision ?? 0);

  return {
    available,
    revision: manifest.revision ?? 0,
    localRevision: localState.revision ?? 0,
    toDownload,
    toRemove,
    totalBytes,
    fileCount: toDownload.length
  };
}

async function checkForUpdates(gameDir) {
  const resolved = await resolveManifest();
  const manifest = resolved.manifest;
  const source = resolved.source;

  if (!manifest) {
    return {
      ok: true,
      source: 'none',
      available: false,
      error: null
    };
  }

  const localState = readLocalState(gameDir);
  if ((!localState.files || Object.keys(localState.files).length === 0)
    && fs.existsSync(path.join(gameDir, 'mods'))) {
    const bundled = resolveBundledManifest();
    if (bundled) await refreshStateFromDisk(gameDir, bundled);
  }

  if (isQuickUpToDate(gameDir, manifest)) {
    const state = readLocalState(gameDir);
    return {
      ok: true,
      source,
      available: false,
      revision: manifest.revision ?? 0,
      localRevision: state.revision ?? 0,
      fileCount: 0,
      totalBytes: 0,
      error: null
    };
  }

  const plan = planSync(gameDir, manifest);
  return {
    ok: true,
    source,
    available: plan.available,
    revision: plan.revision,
    localRevision: plan.localRevision,
    fileCount: plan.fileCount,
    totalBytes: plan.totalBytes,
    error: null
  };
}

async function resolveManifest() {
  try {
    const remote = await fetchRemoteManifest();
    if (remote) return { manifest: remote, source: 'remote' };
  } catch {
    // пробуем встроенный манифест
  }
  const bundled = resolveBundledManifest();
  if (bundled) return { manifest: bundled, source: 'bundled' };
  return { manifest: null, source: 'none' };
}

async function applyManifestRemovals(gameDir, log) {
  const { manifest } = await resolveManifest();
  if (!manifest?.remove?.length) return 0;
  let removed = 0;
  for (const rel of manifest.remove) {
    const target = path.join(gameDir, rel);
    if (!fs.existsSync(target)) continue;
    await fsp.rm(target, { force: true });
    removed += 1;
    log?.(`Удалён (обновление): ${rel}`);
  }
  return removed;
}

async function applyUpdates(gameDir, log, status) {
  let manifest = null;
  let source = 'remote';
  try {
    const resolved = await resolveManifest();
    manifest = resolved.manifest;
    source = resolved.source;
  } catch (e) {
    throw new Error(`Не удалось получить список обновлений: ${formatLaunchError(e)}`);
  }

  if (!manifest) {
    throw new Error('URL обновлений не настроен (content.manifestUrl).');
  }
  if (source === 'bundled') {
    log?.('Манифест с GitHub недоступен — используется встроенная копия.');
  }

  const plan = planSync(gameDir, manifest, { verifyDisk: false });
  if (!plan.available) {
    log?.('Сборка уже актуальна.');
    return { updated: false, fileCount: 0 };
  }

  const toRemove = plan.toRemove.filter((rel) => fs.existsSync(path.join(gameDir, rel)));
  let toDownload = filterEntriesNeedingDownload(gameDir, plan.toDownload);

  if (toDownload.length === 0 && toRemove.length === 0) {
    await finalizeLocalState(gameDir, manifest);
    log?.('Сборка уже актуальна.');
    return { updated: false, fileCount: 0 };
  }

  const total = toDownload.length + toRemove.length;
  let step = 0;

  for (const rel of toRemove) {
    step += 1;
    status?.(`Удаление устаревших файлов… (${step}/${total})`, step / total);
    const target = path.join(gameDir, rel);
    await fsp.rm(target, { force: true });
    log?.(`Удалён: ${rel}`);
  }

  const concurrency = Math.max(1, Number(config.downloadConcurrency) || 6);
  let completedDownloads = 0;
  const progressByPath = new Map();

  if (toDownload.length > 0) {
    log?.(`Параллельная загрузка: ${concurrency} поток(ов).`);
  }

  await runWithConcurrency(toDownload, concurrency, async (entry) => {
    progressByPath.set(entry.path, 0);
    status?.(
      `Загрузка (${completedDownloads}/${toDownload.length}, ${concurrency} поток.)…`,
      (step + completedDownloads) / total
    );

    await downloadModpackEntry(manifest, entry, gameDir, log, (p) => {
      progressByPath.set(entry.path, p);
      const active = [...progressByPath.values()];
      const partial = active.length
        ? active.reduce((sum, value) => sum + value, 0) / active.length
        : 0;
      status?.(
        `Загрузка (${completedDownloads}/${toDownload.length}, ${concurrency} поток.)…`,
        (step + completedDownloads + partial) / total
      );
    });

    progressByPath.delete(entry.path);
    completedDownloads += 1;
    status?.(
      `Загрузка (${completedDownloads}/${toDownload.length})…`,
      (step + completedDownloads) / total
    );
  });

  await finalizeLocalState(gameDir, manifest, { downloaded: toDownload, removed: toRemove });
  log?.(`Обновление завершено (ревизия ${manifest.revision}).`);
  status?.('Сборка обновлена', 1);
  return { updated: true, fileCount: toDownload.length + toRemove.length };
}

function findManifestMod(manifest, pattern) {
  return (manifest.files || []).find((f) => pattern.test(f.path.replace(/\\/g, '/')));
}

function modJarMatchesManifest(gameDir, entry) {
  if (!entry) return true;
  return localFileHash(gameDir, entry.path) === entry.sha256;
}

const CRITICAL_MOD_PATTERNS = [
  /\/superbwarfare-.*\.jar$/i,
  /\/Zero ordinary vehicles-.*\.jar$/i,
  /\/C\.M\.A_Transport_Pack.*\.jar$/i,
  /\/IAV-.*\.jar$/i,
  /\/VEB-.*\.jar$/i,
  /\/S\.L\.O\.P\. Vehicle Pack.*\.jar$/i,
  /\/Immersive Vehicles-.*\.jar$/i,
  /\/MTS Official Pack-.*\.jar$/i
];

function resolveBundledModpackDat() {
  const candidates = [
    path.join(process.resourcesPath || '', 'modpack.dat'),
    path.join(__dirname, '..', 'resources', 'modpack.dat')
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/** Докачивает ключевые jar из встроенного modpack.dat, если манифест/обновление их пропустили. */
async function ensureModpackDatVehicleMods(gameDir, log) {
  const datPath = resolveBundledModpackDat();
  if (!datPath) return { repaired: 0 };

  const AdmZip = require('adm-zip');
  const zip = new AdmZip(datPath);
  const modsDir = path.join(gameDir, 'mods');
  await fsp.mkdir(modsDir, { recursive: true });

  let repaired = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || !entry.entryName.toLowerCase().endsWith('.jar')) continue;
    const name = path.basename(entry.entryName);
    const must =
      /^C\.M\.A_Transport_Pack/i.test(name)
      || /^IAV-/i.test(name)
      || /^VEB-/i.test(name)
      || /^S\.L\.O\.P\./i.test(name)
      || /^Zero ordinary vehicles/i.test(name)
      || /^superbwarfare-/i.test(name);
    if (!must) continue;

    const dest = path.join(modsDir, name);
    const need = !fs.existsSync(dest) || fs.statSync(dest).size !== entry.header.size;
    if (!need) continue;

    await fsp.writeFile(dest, entry.getData());
    repaired += 1;
    log?.(`Установлен из сборки: ${name}`);
  }
  return { repaired };
}

/** pgcclient + MTS/суперб — без них Forge и сервер ломаются. */
async function ensureCriticalModJars(gameDir, log) {
  const fromDat = await ensureModpackDatVehicleMods(gameDir, log);

  let manifest = null;
  try {
    manifest = await fetchRemoteManifest();
  } catch {
    manifest = null;
  }
  if (!manifest) manifest = resolveBundledManifest();
  if (!manifest) return { updated: fromDat.repaired > 0 };

  const clientRel = config.clientModRel;
  const clientEntry = resolveClientModEntry(manifest);
  const checks = [clientEntry, ...CRITICAL_MOD_PATTERNS.map((re) => findManifestMod(manifest, re))].filter(Boolean);

  const allOk = checks.every((entry) => modJarMatchesManifest(gameDir, entry));
  if (allOk) return { updated: fromDat.repaired > 0 };

  for (const entry of checks) {
    if (!modJarMatchesManifest(gameDir, entry)) {
      log?.(`Обновление: ${path.basename(entry.path)}…`);
    }
  }

  const result = await applyUpdates(gameDir, log, () => {});
  return { updated: result.updated || fromDat.repaired > 0 };
}

/** Принудительно сверяет pgcclient на диске с манифестом (часто остаётся старый jar с сетевым каналом). */
async function ensureClientModJar(gameDir, log) {
  let manifest = null;
  try {
    manifest = await fetchRemoteManifest();
  } catch {
    manifest = null;
  }
  if (!manifest) manifest = resolveBundledManifest();
  if (!manifest) return { updated: false };

  const entry = resolveClientModEntry(manifest);
  if (!entry) return { updated: false };

  const rel = entry.path.replace(/\\/g, '/');
  const dest = path.join(gameDir, rel);
  const diskHash = fs.existsSync(dest) ? sha256File(dest) : null;
  if (diskHash === entry.sha256) return { updated: false };

  log?.(`Клиентский мод устарел — обновление ${path.basename(dest)}…`);
  const result = await applyUpdates(gameDir, log, () => {});
  return { updated: result.updated };
}

module.exports = {
  checkForUpdates,
  applyUpdates,
  applyManifestRemovals,
  resolveManifest,
  refreshStateFromDisk,
  resolveBundledManifest,
  resolveClientModEntry,
  allowedClientModNames,
  planSync,
  readLocalState,
  ensureClientModJar,
  ensureCriticalModJars,
  ensureModpackDatVehicleMods,
  sha256File
};
