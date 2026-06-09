'use strict';

const crypto = require('crypto');
const os = require('os');
const { execSync } = require('child_process');

let cached = null;

function wmic(query) {
  try {
    const out = execSync(`wmic ${query}`, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000
    });
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(1)
      .join('|');
  } catch {
    return '';
  }
}

function collectParts() {
  const parts = [
    os.hostname(),
    os.platform(),
    os.arch(),
    String(os.cpus()?.[0]?.model || ''),
    os.totalmem()
  ];
  if (process.platform === 'win32') {
    parts.push(wmic('csproduct get uuid'));
    parts.push(wmic('diskdrive get serialnumber'));
  }
  return parts.filter(Boolean).join('::');
}

function getMachineHwid() {
  if (cached) return cached;
  const digest = crypto.createHash('sha256').update(collectParts(), 'utf8').digest('hex');
  cached = digest.slice(0, 32);
  return cached;
}

module.exports = { getMachineHwid };
