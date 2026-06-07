'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const versionFile = path.join(root, 'version.json');
const meta = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
const { version, productName, installerName, clientModId, clientModVersion } = meta;
const setupName = installerName || productName;

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('version.json: нужен semver X.Y.Z');
  process.exit(1);
}

function setJson(file, mutator) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutator(data);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

setJson(path.join(root, 'launcher', 'package.json'), (pkg) => {
  pkg.version = version;
  pkg.build.productName = productName;
  pkg.build.nsis.shortcutName = productName;
  pkg.build.nsis.uninstallDisplayName = productName;
  if (!pkg.build.win) pkg.build.win = {};
  pkg.build.win.artifactName = `${setupName} \${version}.\${ext}`;
});

const gradleProps = path.join(root, 'mod', 'gradle.properties');
if (fs.existsSync(gradleProps)) {
  let gradle = fs.readFileSync(gradleProps, 'utf8');
  if (/^mod_version=.*/m.test(gradle)) {
    gradle = gradle.replace(/^mod_version=.*/m, `mod_version=${version}`);
  } else {
    gradle += `\nmod_version=${version}\n`;
  }
  if (clientModId && /^mod_id=.*/m.test(gradle)) {
    gradle = gradle.replace(/^mod_id=.*/m, `mod_id=${clientModId}`);
  }
  fs.writeFileSync(gradleProps, gradle, 'utf8');
}

console.log(`Версия ${version} (client mod ${clientModVersion || version}) → package.json, gradle.properties, artifactName`);
