'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function resolveGithubUpdatesDir() {
  const candidates = [
    path.join(__dirname, '..', '..', 'github-updates'),
    path.join(process.cwd(), 'github-updates')
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
  }
  return null;
}

function appendRegistrationEntry(entry) {
  const repoDir = resolveGithubUpdatesDir();
  if (!repoDir) return { ok: false, skipped: true, reason: 'github-updates не найден' };

  const file = path.join(repoDir, 'registrations.json');
  let data = { updatedAt: null, entries: [] };
  if (fs.existsSync(file)) {
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      data = { updatedAt: null, entries: [] };
    }
  }
  if (!Array.isArray(data.entries)) data.entries = [];

  const key = `${entry.username}|${entry.hwid}`;
  const exists = data.entries.some((e) => `${e.username}|${e.hwid}` === key);
  if (exists) return { ok: true, duplicate: true };

  data.entries.unshift({
    username: entry.username,
    hwid: entry.hwid,
    createdAt: entry.createdAt || new Date().toISOString()
  });
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');

  try {
    execSync('git add registrations.json', { cwd: repoDir, stdio: 'ignore' });
    execSync(`git commit -m "Registration: ${entry.username}"`, { cwd: repoDir, stdio: 'ignore' });
    execSync('git push origin main', { cwd: repoDir, stdio: 'ignore', timeout: 60000 });
    return { ok: true, pushed: true };
  } catch (err) {
    return { ok: false, error: err.message || 'git push failed', saved: true };
  }
}

module.exports = {
  resolveGithubUpdatesDir,
  appendRegistrationEntry
};
