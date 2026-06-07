'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, '..', 'github-updates', 'modpack-manifest.json');
const newsSrc = path.join(root, '..', 'github-updates', 'news.json');
const dest = path.join(root, 'resources', 'modpack-manifest.json');
const newsDest = path.join(root, 'resources', 'news.json');

if (!fs.existsSync(src)) {
  console.log('github-updates/modpack-manifest.json не найден — пропуск');
  process.exit(0);
}

fs.copyFileSync(src, dest);
const manifest = JSON.parse(fs.readFileSync(dest, 'utf8'));
console.log(`modpack-manifest.json: rev ${manifest.revision} (из github-updates)`);

if (fs.existsSync(newsSrc)) {
  fs.copyFileSync(newsSrc, newsDest);
  console.log('news.json скопирован из github-updates');
}

const authSrc = path.join(root, '..', 'github-updates', 'launcher-auth.json');
const authDest = path.join(root, 'resources', 'launcher-auth.json');
if (fs.existsSync(authSrc)) {
  fs.copyFileSync(authSrc, authDest);
  console.log('launcher-auth.json скопирован из github-updates');
}
