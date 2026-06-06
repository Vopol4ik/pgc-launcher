'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const archive = path.join(root, 'resources', 'content.7z');
const metaFile = path.join(root, 'resources', 'content-meta.json');
const version = JSON.parse(fs.readFileSync(path.join(root, '..', 'version.json'), 'utf8')).version;

if (!fs.existsSync(archive)) {
  console.error('Нет resources/content.7z — скачайте с GitHub Release modpack-latest');
  process.exit(1);
}

const stat = fs.statSync(archive);
console.log('Проверка SHA256 content.7z (один раз)…');
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
const meta = {
  launcherVersion: version,
  sha256,
  size: stat.size,
  url: 'https://github.com/Vopol4ik/globalwar-updates/releases/download/modpack-latest/content.7z',
  urls: [
    'https://github.com/Vopol4ik/globalwar-updates/releases/download/modpack-latest/content.7z',
    'https://operativniki.minerent.io/launcher/content.7z'
  ],
  builtAt: new Date().toISOString()
};
fs.writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
console.log(`content-meta.json: ${(stat.size / (1024 * 1024)).toFixed(1)} МБ, sha ${sha256.slice(0, 12)}…`);
