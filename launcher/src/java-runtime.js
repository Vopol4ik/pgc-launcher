'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');
const { download, fetchJson } = require('./download');
const { formatLaunchError } = require('./errors');

/** Прямая ссылка Adoptium — zip JRE 17 для Windows x64 (без fetch API). */
const TEMURIN_JRE_ZIP_URL =
  'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jre/hotspot/normal/eclipse?project=jdk';

const ADOPTIUM_API =
  'https://api.adoptium.net/v3/assets/latest/17/hotspot?os=windows&architecture=x64&image_type=jre';

function javaMajorVersion(javaExe) {
  try {
    const res = spawnSync(javaExe, ['-version'], { encoding: 'utf8' });
    const out = `${res.stderr || ''}${res.stdout || ''}`;
    const m = out.match(/version "(\d+)(?:\.(\d+))?/);
    if (!m) return null;
    let major = parseInt(m[1], 10);
    if (major === 1 && m[2]) major = parseInt(m[2], 10);
    return major;
  } catch {
    return null;
  }
}

async function findJavaExeInDir(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return null;
  }

  const direct = path.join(rootDir, 'bin', 'java.exe');
  if (fs.existsSync(direct)) return direct;

  const entries = await fsp.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = path.join(rootDir, entry.name, 'bin', 'java.exe');
    if (fs.existsSync(nested)) return nested;
  }
  return null;
}

async function resolveDownloadUrl() {
  try {
    const assets = await fetchJson(ADOPTIUM_API);
    if (Array.isArray(assets) && assets.length > 0) {
      const zipAsset = assets.find((a) => a.binary_type === 'zip') || assets[0];
      if (zipAsset?.binary_link) {
        return zipAsset.binary_link;
      }
    }
  } catch {
    // резервная прямая ссылка ниже
  }
  return TEMURIN_JRE_ZIP_URL;
}

async function extractJreZip(zipPath, destDir) {
  await fsp.rm(destDir, { recursive: true, force: true });
  await fsp.mkdir(destDir, { recursive: true });
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(destDir, true);
  const javaExe = await findJavaExeInDir(destDir);
  if (!javaExe) throw new Error('В архиве Java не найден bin/java.exe');
  return javaExe;
}

async function downloadBundledJava17(runtimeDir, onProgress, onLog) {
  const jreRoot = path.join(runtimeDir, 'jre-17');
  const tmpZip = path.join(runtimeDir, 'java-17-download.zip');

  onLog?.('Скачивание Java 17 (Eclipse Temurin)…');
  const url = await resolveDownloadUrl();
  onLog?.(`Источник: ${url.split('?')[0]}`);

  await download(url, tmpZip, (p) => onProgress?.(p));
  onLog?.('Распаковка Java 17…');
  const bundled = await extractJreZip(tmpZip, jreRoot);
  await fsp.writeFile(path.join(jreRoot, '.java-ready'), bundled, 'utf8');
  await fsp.rm(tmpZip, { force: true });

  if (javaMajorVersion(bundled) !== 17) {
    throw new Error('Скачанная Java не версии 17');
  }
  onLog?.(`Java 17 готова: ${bundled}`);
  return bundled;
}

function findSystemJava17() {
  const candidates = [];
  if (process.env.JAVA_HOME) {
    candidates.push(path.join(process.env.JAVA_HOME, 'bin', 'java.exe'));
  }
  const programFiles = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['ProgramW6432']
  ].filter(Boolean);
  const vendors = ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'AdoptOpenJDK', 'Amazon Corretto', 'BellSoft'];
  for (const pf of programFiles) {
    for (const vendor of vendors) {
      const dir = path.join(pf, vendor);
      try {
        for (const entry of fs.readdirSync(dir)) {
          if (!/17/i.test(entry)) continue;
          candidates.push(path.join(dir, entry, 'bin', 'java.exe'));
        }
      } catch {
        // каталога нет
      }
    }
  }

  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    if (javaMajorVersion(c) === 17) return c;
  }
  return null;
}

/**
 * Java 17: локальная в runtime → системная → скачивание Temurin.
 */
async function ensureJava17(runtimeDir, onProgress, onLog) {
  await fsp.mkdir(runtimeDir, { recursive: true });

  const jreRoot = path.join(runtimeDir, 'jre-17');
  const marker = path.join(jreRoot, '.java-ready');

  let bundled = await findJavaExeInDir(jreRoot);
  if (bundled && javaMajorVersion(bundled) === 17) {
    if (!fs.existsSync(marker)) {
      await fsp.writeFile(marker, bundled, 'utf8');
    }
    onLog?.(`Java 17: ${bundled}`);
    return bundled;
  }

  const system = findSystemJava17();
  if (system) {
    onLog?.(`Java 17 (системная): ${system}`);
    return system;
  }

  return downloadBundledJava17(runtimeDir, onProgress, onLog);
}

async function ensureJava17WithFallback(runtimeDir, onProgress, onLog) {
  try {
    return await ensureJava17(runtimeDir, onProgress, onLog);
  } catch (err) {
    throw new Error(formatLaunchError(err));
  }
}

module.exports = { ensureJava17: ensureJava17WithFallback, javaMajorVersion, findSystemJava17 };
