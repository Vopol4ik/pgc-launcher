'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('./config');
const { download, fetchJson } = require('./download');
const { formatLaunchError } = require('./errors');

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
  return fetchJson(url);
}

function fileUrl(manifest, entry) {
  if (entry.url) return entry.url;
  const base = manifest.baseUrl || config.content?.filesBaseUrl;
  if (!base) return null;
  const normalized = entry.path.replace(/\\/g, '/');
  return `${base.replace(/\/$/, '')}/${normalized.split('/').map(encodeURIComponent).join('/')}`;
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
  let totalBytes = 0;
  const localState = readLocalState(gameDir);
  const stateFiles = localState.files || {};

  for (const entry of manifest.files || []) {
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

  const plan = planSync(gameDir, manifest, { verifyDisk: true });
  if (!plan.available) {
    log?.('Сборка уже актуальна.');
    await writeLocalState(gameDir, manifest);
    return { updated: false, fileCount: 0 };
  }

  const total = plan.toDownload.length + plan.toRemove.length;
  let step = 0;

  for (const rel of plan.toRemove) {
    step += 1;
    status?.(`Удаление устаревших файлов… (${step}/${total})`, step / total);
    const target = path.join(gameDir, rel);
    await fsp.rm(target, { force: true });
    log?.(`Удалён: ${rel}`);
  }

  for (const entry of plan.toDownload) {
    step += 1;
    const url = fileUrl(manifest, entry);
    if (!url) {
      throw new Error(`Нет URL для ${entry.path}. Проверьте filesBaseUrl на сервере.`);
    }

    const dest = path.join(gameDir, entry.path);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.download`;

    log?.(`Загрузка: ${entry.path} (${((entry.size || 0) / (1024 * 1024)).toFixed(1)} МБ)…`);
    status?.(`Загрузка: ${path.basename(entry.path)}…`, step / total);

    await fsp.rm(tmp, { force: true });
    await download(url, tmp, (p) => {
      status?.(`Загрузка: ${path.basename(entry.path)}…`, (step - 1 + p) / total);
    });

    const hash = sha256File(tmp);
    if (hash !== entry.sha256) {
      await fsp.rm(tmp, { force: true });
      throw new Error(`Файл повреждён после загрузки: ${entry.path}`);
    }

    await fsp.rm(dest, { force: true });
    await fsp.rename(tmp, dest);
    log?.(`Установлен: ${entry.path}`);
  }

  await writeLocalState(gameDir, manifest);
  log?.(`Обновление завершено (ревизия ${manifest.revision}).`);
  status?.('Сборка обновлена', 1);
  return { updated: true, fileCount: plan.toDownload.length };
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

  const clientRel = `mods/${config.clientModId}-${config.appVersion}.jar`;
  const clientEntry = (manifest.files || []).find((f) => f.path.replace(/\\/g, '/') === clientRel);
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

  const rel = `mods/${config.clientModId}-${config.appVersion}.jar`;
  const entry = (manifest.files || []).find((f) => f.path.replace(/\\/g, '/') === rel);
  if (!entry) return { updated: false };

  const dest = path.join(gameDir, rel);
  const diskHash = fs.existsSync(dest) ? sha256File(dest) : null;
  if (diskHash === entry.sha256) return { updated: false };

  log?.(`Клиентский мод устарел — обновление ${path.basename(dest)}…`);
  const plan = planSync(gameDir, manifest, { verifyDisk: true });
  if (!plan.available) {
    await fsp.rm(dest, { force: true });
  }
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
  planSync,
  readLocalState,
  ensureClientModJar,
  ensureCriticalModJars,
  ensureModpackDatVehicleMods,
  sha256File
};
