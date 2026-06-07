'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { path7za } = require('7zip-bin');
const config = require('./config');
const { applyLauncherCpuLimit } = require('./cpu-limit');

/** Пути внутри app.asar видны fs.existsSync, но .exe оттуда не запускается. */
function isInsidePackedAsar(filePath) {
  return /app\.asar[\\/]/i.test(filePath) && !/app\.asar\.unpacked/i.test(filePath);
}

function resolveSevenZipBin() {
  const arch = process.arch === 'x64' ? 'x64' : 'ia32';
  const candidates = [];

  if (path7za.includes('app.asar')) {
    candidates.push(path7za.replace(/app\.asar([\\/])/i, 'app.asar.unpacked$1'));
  }

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, '7za', '7za.exe'));
  }

  candidates.push(
    path.join(__dirname, '..', 'node_modules', '7zip-bin', 'win', arch, '7za.exe')
  );

  for (const bin of candidates) {
    if (!bin || isInsidePackedAsar(bin)) continue;
    if (fs.existsSync(bin)) return bin;
  }

  throw new Error('7za.exe не найден. Переустановите лаунчер.');
}

function resolveExtractCpuPercent(options = {}) {
  const pct = Number(options.maxCpuPercent ?? config.extractCpuPercent ?? 85);
  return Math.min(100, Math.max(50, pct));
}

function extractThreadArg(maxPercent) {
  const configured = Number(config.extractThreads);
  if (Number.isFinite(configured) && configured > 0) {
    return String(Math.max(1, Math.floor(configured)));
  }
  if (configured === 0) {
    return 'on';
  }
  const logical = os.cpus().length;
  return String(Math.max(1, Math.floor((logical * maxPercent) / 100)));
}

function extract7z(archivePath, destDir, options = {}) {
  const maxCpuPercent = resolveExtractCpuPercent(options);
  const threads = extractThreadArg(maxCpuPercent);
  const bin = resolveSevenZipBin();

  return new Promise((resolve, reject) => {
    const child = spawn(
      bin,
      ['x', archivePath, `-o${destDir}`, '-y', '-bso0', '-bsp1', `-mmt=${threads}`],
      { windowsHide: true }
    );

    const onSpawn = () => {
      applyLauncherCpuLimit(maxCpuPercent, child.pid);
    };
    if (child.pid) onSpawn();
    else child.once('spawn', onSpawn);

    let out = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { out += chunk; });
    child.stderr?.on('data', (chunk) => { out += chunk; });

    child.on('error', (err) => reject(new Error(`7za: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ maxCpuPercent, threads });
        return;
      }
      const err = out.trim();
      reject(new Error(err || `7za завершился с кодом ${code}`));
    });
  });
}

module.exports = {
  extract7z,
  resolveSevenZipBin,
  resolveExtractCpuPercent,
  extractThreadArg
};
