'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const { version, productName, installerName } = JSON.parse(
  fs.readFileSync(path.join(root, 'version.json'), 'utf8')
);
const setupBase = installerName || `${productName} Setup`;
const releaseDir = path.join(root, 'launcher', 'release');
const releaseAlt = path.join(root, 'launcher', 'release-build');
const desktop = path.join(process.env.USERPROFILE || '', 'Desktop');
const expected = `${setupBase} ${version}.exe`;
const src = path.join(releaseDir, expected);

function copyInstaller(destName) {
  const name = destName || expected;
  for (const dir of [releaseDir, releaseAlt]) {
    const from = path.join(dir, name);
    if (!fs.existsSync(from)) continue;
    const dest = path.join(desktop, name);
    fs.copyFileSync(from, dest);
    console.log(dest);
    return true;
  }
  return false;
}

if (!copyInstaller()) {
  for (const dir of [releaseDir, releaseAlt]) {
    if (!fs.existsSync(dir)) continue;
    const found = fs.readdirSync(dir).find((n) => n.endsWith('.exe') && n.includes('Setup'));
    if (found && copyInstaller(found)) break;
  }
}
if (!fs.existsSync(path.join(desktop, expected))) {
  const found = [releaseDir, releaseAlt]
    .filter((d) => fs.existsSync(d))
    .flatMap((d) => fs.readdirSync(d))
    .find((n) => n.endsWith('.exe') && n.includes('Setup'));
  if (!found) {
    console.error('Установщик не найден. Сначала: cd launcher && npm run dist:desktop');
    process.exit(1);
  }
  copyInstaller(found);
}

const metaPath = path.join(root, 'launcher', 'resources', 'content-meta.json');
let sizeHint = '~1.7 ГБ';
try {
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  if (meta.size) sizeHint = `~${(meta.size / (1024 * 1024)).toFixed(0)} МБ`;
} catch {
  // ignore
}
console.log(`Лёгкий установщик (~70 МБ). Сборка (${sizeHint}) скачается при первом запуске.`);
