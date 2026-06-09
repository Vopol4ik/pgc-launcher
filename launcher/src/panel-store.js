'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('./config');
const { getGameDir } = require('./paths');

const PANEL_DIR_NAME = 'panel-data';
const SESSIONS_FILE = 'sessions.json';
const BANS_FILE = 'bans.json';
const ACTIVITY_FILE = 'activity.json';
const JOURNAL_FILE = 'launcher-journal.json';
const MAX_JOURNAL_LINES = 600;

const GAME_ACTIVITY_RE = /\[CHAT\]|joined the game|left the game|was banned|was kicked|Connecting to|Connection reset|Internal Exception|Logged in with entity/i;

function getPanelDir() {
  return path.join(getGameDir(), PANEL_DIR_NAME);
}

function bundledSeedPath(name) {
  const candidates = [
    path.join(process.resourcesPath || '', 'panel', name),
    path.join(__dirname, '..', 'resources', 'panel', name)
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  return null;
}

async function readJson(file, fallback) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

async function ensurePanelData() {
  const dir = getPanelDir();
  await fsp.mkdir(dir, { recursive: true });

  const bansPath = path.join(dir, BANS_FILE);
  if (!fs.existsSync(bansPath)) {
    const seed = bundledSeedPath(BANS_FILE);
    if (seed) {
      await fsp.copyFile(seed, bansPath);
    } else {
      await writeJson(bansPath, { bans: [], updatedAt: new Date().toISOString() });
    }
  }

  for (const file of [SESSIONS_FILE, ACTIVITY_FILE, JOURNAL_FILE]) {
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) {
      const empty = file === SESSIONS_FILE
        ? { sessions: [] }
        : file === JOURNAL_FILE
          ? { lines: [] }
          : { entries: [] };
      await writeJson(full, empty);
    }
  }
}

function readLauncherJournalFile(limit = 200) {
  try {
    const file = path.join(getPanelDir(), JOURNAL_FILE);
    if (!fs.existsSync(file)) return [];
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const lines = Array.isArray(data.lines) ? data.lines : [];
    return lines.slice(-limit);
  } catch {
    return [];
  }
}

async function appendLauncherJournalLine(line) {
  await ensurePanelData();
  const file = path.join(getPanelDir(), JOURNAL_FILE);
  const data = await readJson(file, { lines: [] });
  const lines = Array.isArray(data.lines) ? data.lines : [];
  lines.push(String(line));
  while (lines.length > MAX_JOURNAL_LINES) lines.shift();
  await writeJson(file, { lines, updatedAt: new Date().toISOString() });
}

function readTail(file, maxBytes = 80_000) {
  try {
    if (!fs.existsSync(file)) return '';
    const stat = fs.statSync(file);
    const size = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, stat.size - size);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function parseGameActivity(tail) {
  const entries = [];
  for (const line of tail.split(/\r?\n/)) {
    if (!line.trim() || !GAME_ACTIVITY_RE.test(line)) continue;
    const timeMatch = line.match(/^\[(\d{2}[^\]]+)\]/);
    entries.push({
      at: timeMatch ? timeMatch[1] : '',
      line: line.slice(0, 280)
    });
  }
  return entries.slice(-80).reverse();
}

async function readBans() {
  await ensurePanelData();
  const data = await readJson(path.join(getPanelDir(), BANS_FILE), { bans: [] });
  const bans = Array.isArray(data.bans) ? data.bans : [];
  return bans.map((b) => ({
    player: String(b.player || '').toLowerCase(),
    reason: String(b.reason || '—'),
    by: String(b.by || 'Система'),
    until: b.until || null,
    permanent: Boolean(b.permanent),
    active: b.active !== false,
    createdAt: b.createdAt || null
  }));
}

async function saveBans(bans) {
  await ensurePanelData();
  const file = path.join(getPanelDir(), BANS_FILE);
  await writeJson(file, { bans, updatedAt: new Date().toISOString() });
}

async function readSessions(limit = 40) {
  await ensurePanelData();
  const data = await readJson(path.join(getPanelDir(), SESSIONS_FILE), { sessions: [] });
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  return sessions.slice(-limit).reverse();
}

async function appendSessionRecord(record) {
  await ensurePanelData();
  const file = path.join(getPanelDir(), SESSIONS_FILE);
  const data = await readJson(file, { sessions: [] });
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  sessions.push(record);
  while (sessions.length > 200) sessions.shift();
  await writeJson(file, { sessions });
}

async function readStoredActivity(limit = 60) {
  await ensurePanelData();
  const data = await readJson(path.join(getPanelDir(), ACTIVITY_FILE), { entries: [] });
  const entries = Array.isArray(data.entries) ? data.entries : [];
  return entries.slice(-limit).reverse();
}

async function appendActivity(entry) {
  await ensurePanelData();
  const file = path.join(getPanelDir(), ACTIVITY_FILE);
  const data = await readJson(file, { entries: [] });
  const entries = Array.isArray(data.entries) ? data.entries : [];
  entries.push({ ...entry, at: entry.at || new Date().toISOString() });
  while (entries.length > 500) entries.shift();
  await writeJson(file, { entries });
}

function readGameLogs() {
  const gameDir = getGameDir();
  return {
    latest: readTail(path.join(gameDir, 'logs', 'latest.log'), 120_000),
    debug: readTail(path.join(gameDir, 'logs', 'debug.log'), 60_000)
  };
}

function collectPlayers(sessions, settingsUsername, liveSessionEvents) {
  const map = new Map();

  if (settingsUsername) {
    map.set(settingsUsername.toLowerCase(), {
      name: settingsUsername.toLowerCase(),
      lastSeen: new Date().toISOString(),
      source: 'launcher',
      launches: 1
    });
  }

  for (const session of sessions) {
    const name = String(session.username || '').toLowerCase();
    if (!name) continue;
    const prev = map.get(name) || { name, launches: 0, lastSeen: session.endedAt || session.startedAt };
    prev.launches = (prev.launches || 0) + 1;
    prev.lastSeen = session.endedAt || session.startedAt || prev.lastSeen;
    prev.lastEvent = session.lastEvent || prev.lastEvent;
    map.set(name, prev);
  }

  return [...map.values()].sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
}

async function buildPanelSnapshot(live = {}) {
  await ensurePanelData();
  const gameDir = getGameDir();
  const settings = live.settings || {};
  const sessions = await readSessions(50);
  const bans = await readBans();
  const activity = await readStoredActivity(40);
  const logs = readGameLogs();
  const gameActivity = parseGameActivity(logs.latest);

  return {
    brand: config.brand,
    appVersion: config.appVersion,
    minecraft: config.minecraft,
    server: config.brand?.server || 'localhost',
    panelUrl: live.panelUrl || null,
    currentUser: settings.username || null,
    liveSession: {
      startedAt: live.sessionStartedAt || null,
      events: live.sessionEvents || []
    },
    launcherLog: (live.launcherJournal?.length
      ? live.launcherJournal
      : readLauncherJournalFile(200)).slice(-200),
    gameLogs: logs,
    gameActivity,
    storedActivity: activity,
    sessions,
    players: collectPlayers(sessions, settings.username, live.sessionEvents),
    bans: {
      active: bans.filter((b) => b.active),
      all: bans,
      count: bans.filter((b) => b.active).length
    },
    paths: {
      gameDir,
      panelDir: getPanelDir()
    }
  };
}

module.exports = {
  getPanelDir,
  ensurePanelData,
  readBans,
  saveBans,
  readSessions,
  appendSessionRecord,
  appendActivity,
  readStoredActivity,
  readLauncherJournalFile,
  appendLauncherJournalLine,
  readGameLogs,
  buildPanelSnapshot
};
