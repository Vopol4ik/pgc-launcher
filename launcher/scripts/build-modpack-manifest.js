'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, '..', 'github-updates', 'modpack-manifest.json');
const dest = path.join(root, 'resources', 'modpack-manifest.json');

if (!fs.existsSync(src)) {
  console.log('github-updates/modpack-manifest.json не найден — пропуск');
  process.exit(0);
}

fs.copyFileSync(src, dest);
const manifest = JSON.parse(fs.readFileSync(dest, 'utf8'));
console.log(`modpack-manifest.json: rev ${manifest.revision} (из github-updates)`);
