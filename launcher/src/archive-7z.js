'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { path7za } = require('7zip-bin');

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

function extract7z(archivePath, destDir) {
  const bin = resolveSevenZipBin();
  const result = spawnSync(
    bin,
    ['x', archivePath, `-o${destDir}`, '-y', '-bso0', '-bsp1'],
    {
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    }
  );

  if (result.error) {
    throw new Error(`7za: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const err = `${result.stderr || ''}${result.stdout || ''}`.trim();
    throw new Error(err || `7za завершился с кодом ${result.status}`);
  }
}

module.exports = { extract7z, resolveSevenZipBin };
