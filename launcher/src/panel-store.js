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
const CLIENTS_FILE = 'clients.json';
const COMMANDS_FILE = 'commands.json';
const MAX_JOURNAL_LINES = 600;
const CLIENT_ONLINE_MS = 45000;

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

  for (const file of [SESSIONS_FILE, ACTIVITY_FILE, JOURNAL_FILE, CLIENTS_FILE, COMMANDS_FILE]) {
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) {
      const empty = file === SESSIONS_FILE
        ? { sessions: [] }
        : file === JOURNAL_FILE
          ? { lines: [] }
          : file === CLIENTS_FILE
            ? { clients: [] }
            : file === COMMANDS_FILE
              ? { pending: [] }
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
    player: String(b.player || '').toLowerCase() || null,
    hwid: String(b.hwid || '').toLowerCase() || null,
    reason: String(b.reason || '—'),
    by: String(b.by || 'Система'),
    until: b.until || null,
    permanent: Boolean(b.permanent),
    active: b.active !== false,
    createdAt: b.createdAt || null
  }));
}

function isBanActive(ban) {
  if (!ban?.active) return false;
  if (ban.permanent || !ban.until) return true;
  return new Date(ban.until).getTime() > Date.now();
}

async function findActiveBan({ player, hwid }) {
  const bans = await readBans();
  const nick = player ? String(player).toLowerCase() : '';
  const id = hwid ? String(hwid).toLowerCase() : '';
  return bans.find((b) => {
    if (!isBanActive(b)) return false;
    if (id && b.hwid && b.hwid === id) return true;
    if (nick && b.player && b.player === nick) return true;
    return false;
  }) || null;
}

async function readClients() {
  await ensurePanelData();
  const data = await readJson(path.join(getPanelDir(), CLIENTS_FILE), { clients: [] });
  return Array.isArray(data.clients) ? data.clients : [];
}

async function saveClients(clients) {
  await writeJson(path.join(getPanelDir(), CLIENTS_FILE), {
    clients,
    updatedAt: new Date().toISOString()
  });
}

async function upsertClientHeartbeat(payload) {
  const hwid = String(payload.hwid || '').toLowerCase();
  if (!hwid) throw new Error('HWID обязателен');
  const clients = await readClients();
  const now = new Date().toISOString();
  const existing = clients.find((c) => c.hwid === hwid);
  const entry = {
    hwid,
    username: String(payload.username || existing?.username || '').toLowerCase() || null,
    launcherVersion: payload.launcherVersion || existing?.launcherVersion || null,
    pid: payload.pid || existing?.pid || null,
    gameRunning: Boolean(payload.gameRunning),
    lastSeen: now,
    firstSeen: existing?.firstSeen || now,
    ip: payload.ip || existing?.ip || null
  };
  if (existing) Object.assign(existing, entry);
  else clients.unshift(entry);
  while (clients.length > 500) clients.pop();
  await saveClients(clients);
  return entry;
}

function listOnlineClients(clients, now = Date.now()) {
  return clients
    .filter((c) => now - new Date(c.lastSeen).getTime() <= CLIENT_ONLINE_MS)
    .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
}

async function readCommands() {
  await ensurePanelData();
  const data = await readJson(path.join(getPanelDir(), COMMANDS_FILE), { pending: [] });
  return Array.isArray(data.pending) ? data.pending : [];
}

async function saveCommands(pending) {
  await writeJson(path.join(getPanelDir(), COMMANDS_FILE), {
    pending,
    updatedAt: new Date().toISOString()
  });
}

async function enqueueCommand({ hwid, type, payload = {} }) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pending = await readCommands();
  pending.push({
    id,
    hwid: String(hwid || '').toLowerCase(),
    type: String(type || 'message'),
    payload,
    createdAt: new Date().toISOString()
  });
  await saveCommands(pending);
  return id;
}

async function pullCommandsForHwid(hwid) {
  const id = String(hwid || '').toLowerCase();
  const pending = await readCommands();
  const mine = pending.filter((c) => c.hwid === id);
  const rest = pending.filter((c) => c.hwid !== id);
  if (mine.length) await saveCommands(rest);
  return mine;
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
  const clients = await readClients();
  const onlineClients = listOnlineClients(clients);

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
      active: bans.filter((b) => isBanActive(b)),
      all: bans,
      count: bans.filter((b) => isBanActive(b)).length
    },
    clients: {
      online: onlineClients,
      total: clients.length
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
  findActiveBan,
  isBanActive,
  readClients,
  upsertClientHeartbeat,
  listOnlineClients,
  enqueueCommand,
  pullCommandsForHwid,
  readSessions,
  appendSessionRecord,
  appendActivity,
  readStoredActivity,
  readLauncherJournalFile,
  appendLauncherJournalLine,
  readGameLogs,
  buildPanelSnapshot
};
