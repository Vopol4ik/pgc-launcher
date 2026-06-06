'use strict';

const fs = require('fs');
const path = require('path');

/** Убираем тяжёлый LICENSES из установщика (не нужен игрокам). */
exports.default = async function afterPack(context) {
  const lic = path.join(context.appOutDir, 'LICENSES.chromium.html');
  if (fs.existsSync(lic)) {
    fs.unlinkSync(lic);
  }
  const locales = path.join(context.appOutDir, 'locales');
  if (fs.existsSync(locales)) {
    for (const file of fs.readdirSync(locales)) {
      if (!/^(ru|en-US)\.pak$/i.test(file)) {
        fs.unlinkSync(path.join(locales, file));
      }
    }
  }
};
