'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const config = require('./config');
const {
  ensurePanelData,
  readBans,
  saveBans,
  buildPanelSnapshot,
  upsertClientHeartbeat,
  readClients,
  listOnlineClients,
  enqueueCommand,
  pullCommandsForHwid,
  findActiveBan
} = require('./panel-store');
const { fetchServerStatus } = require('./server-status');
const {
  isAdminConfigured,
  setupAdminPassword,
  loginAdmin,
  isAdminRequest,
  authCookieHeader
} = require('./panel-auth');

const PANEL_ROOT = path.join(__dirname, 'panel');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png'
};

let server = null;
let liveProvider = () => ({});

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function clientIp(req) {
  return req.socket?.remoteAddress || null;
}

function isClientAuthorized(req) {
  const secret = req.headers['x-pgc-client'] || req.headers['X-PGC-Client'];
  return String(secret || '') === String(config.panel?.clientSecret || 'PGC-Panel-Client-2026');
}

async function serveStatic(urlPath, res) {
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(PANEL_ROOT, safe === '/' || safe === '\\' ? 'index.html' : safe);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  if (!filePath.startsWith(PANEL_ROOT) || !fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

async function handleClientApi(req, res, url) {
  if (!isClientAuthorized(req)) {
    return json(res, 403, { ok: false, error: 'Клиент не авторизован' });
  }

  if (req.method === 'POST' && url.pathname === '/api/client/heartbeat') {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return json(res, 400, { ok: false, error: 'Некорректный JSON' });
    }
    body.ip = clientIp(req);
    await upsertClientHeartbeat(body);
    const ban = await findActiveBan({ player: body.username, hwid: body.hwid });
    const commands = await pullCommandsForHwid(body.hwid);
    return json(res, 200, {
      ok: true,
      banned: Boolean(ban),
      reason: ban?.reason || null,
      commands
    });
  }

  res.writeHead(404);
  res.end('Not found');
}

async function handleAdminApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/auth/status') {
    return json(res, 200, {
      ok: true,
      configured: await isAdminConfigured(),
      authed: isAdminRequest(req)
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/setup') {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return json(res, 400, { ok: false, error: 'Некорректный JSON' });
    }
    try {
      const session = await setupAdminPassword(body.password);
      return json(res, 200, { ok: true }, {
        'Set-Cookie': authCookieHeader(session.token)
      });
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return json(res, 400, { ok: false, error: 'Некорректный JSON' });
    }
    try {
      const session = await loginAdmin(body.password);
      return json(res, 200, { ok: true }, {
        'Set-Cookie': authCookieHeader(session.token)
      });
    } catch (err) {
      return json(res, 401, { ok: false, error: err.message });
    }
  }

  if (!isAdminRequest(req)) {
    return json(res, 401, { ok: false, error: 'Требуется вход администратора' });
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard') {
    const live = liveProvider();
    const snapshot = await buildPanelSnapshot(live);
    let serverStatus = null;
    try {
      serverStatus = await fetchServerStatus();
    } catch (err) {
      serverStatus = { ok: false, error: err.message };
    }
    return json(res, 200, {
      ok: true,
      ...snapshot,
      serverStatus,
      generatedAt: new Date().toISOString()
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/clients') {
    const clients = await readClients();
    return json(res, 200, { ok: true, clients: listOnlineClients(clients) });
  }

  if (req.method === 'POST' && url.pathname === '/api/clients/command') {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return json(res, 400, { ok: false, error: 'Некорректный JSON' });
    }
    const hwid = String(body.hwid || '').toLowerCase();
    const type = String(body.type || '').trim();
    if (!hwid || !type) {
      return json(res, 400, { ok: false, error: 'hwid и type обязательны' });
    }
    const allowed = ['close-launcher', 'stop-game', 'message', 'block-play'];
    if (!allowed.includes(type)) {
      return json(res, 400, { ok: false, error: 'Неизвестная команда' });
    }
    const id = await enqueueCommand({ hwid, type, payload: body.payload || {} });
    if (type === 'block-play' && body.payload?.reason) {
      await enqueueCommand({
        hwid,
        type: 'message',
        payload: { text: body.payload.reason }
      });
    }
    return json(res, 200, { ok: true, id });
  }

  if (req.method === 'GET' && url.pathname === '/api/bans') {
    return json(res, 200, { ok: true, bans: await readBans() });
  }

  if (req.method === 'POST' && url.pathname === '/api/bans') {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return json(res, 400, { ok: false, error: 'Некорректный JSON' });
    }
    const player = String(body.player || '').trim().toLowerCase() || null;
    const hwid = String(body.hwid || '').trim().toLowerCase() || null;
    if (!player && !hwid) {
      return json(res, 400, { ok: false, error: 'Укажите ник или HWID' });
    }
    if (player && !/^[a-z0-9_]{3,16}$/.test(player)) {
      return json(res, 400, { ok: false, error: 'Ник: 3–16 символов' });
    }
    const bans = await readBans();
    const entry = {
      player,
      hwid,
      reason: String(body.reason || 'Нарушение правил').slice(0, 200),
      by: String(body.by || 'Админ').slice(0, 64),
      until: body.permanent ? null : (body.until || null),
      permanent: Boolean(body.permanent),
      active: body.active !== false,
      createdAt: new Date().toISOString()
    };
    const key = hwid || player;
    const idx = bans.findIndex((b) => (hwid && b.hwid === hwid) || (player && b.player === player));
    if (idx >= 0) bans[idx] = { ...bans[idx], ...entry };
    else bans.unshift(entry);
    await saveBans(bans);
    if (hwid) {
      await enqueueCommand({
        hwid,
        type: 'close-launcher',
        payload: { reason: entry.reason }
      });
    }
    return json(res, 200, { ok: true, ban: entry });
  }

  if (req.method === 'POST' && url.pathname === '/api/bans/toggle') {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return json(res, 400, { ok: false, error: 'Некорректный JSON' });
    }
    const bans = await readBans();
    const item = bans.find((b) =>
      (body.hwid && b.hwid === String(body.hwid).toLowerCase())
      || (body.player && b.player === String(body.player).toLowerCase())
    );
    if (!item) return json(res, 404, { ok: false, error: 'Бан не найден' });
    item.active = Boolean(body.active);
    await saveBans(bans);
    return json(res, 200, { ok: true, ban: item });
  }

  if (req.method === 'GET' && url.pathname === '/api/logs') {
    const live = liveProvider();
    const snapshot = await buildPanelSnapshot(live);
    return json(res, 200, {
      ok: true,
      launcher: snapshot.launcherLog,
      game: snapshot.gameLogs.latest,
      debug: snapshot.gameLogs.debug,
      sessionEvents: snapshot.liveSession.events
    });
  }

  res.writeHead(404);
  res.end('API not found');
}

async function handleApi(req, res, url) {
  if (url.pathname.startsWith('/api/client/')) {
    return handleClientApi(req, res, url);
  }
  return handleAdminApi(req, res, url);
}

function createRequestHandler(port) {
  return async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith('/api/')) {
      try {
        await handleApi(req, res, url);
      } catch (err) {
        json(res, 500, { ok: false, error: err.message || 'Ошибка API' });
      }
      return;
    }
    const staticPath = url.pathname === '/' ? '/index.html' : url.pathname;
    await serveStatic(staticPath, res);
  };
}

async function startPanelServer(provider, options = {}) {
  if (server) return getPanelServerInfo();

  liveProvider = typeof provider === 'function' ? provider : () => ({});
  await ensurePanelData();

  const port = Number(options.port || config.panel?.port) || 17890;
  const host = options.host || config.panel?.bindHost || config.panel?.host || '127.0.0.1';

  server = http.createServer(createRequestHandler(port));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  return getPanelServerInfo();
}

function getPanelServerInfo() {
  const port = Number(config.panel?.port) || 17890;
  const host = config.panel?.bindHost || config.panel?.host || '127.0.0.1';
  return {
    running: Boolean(server),
    host,
    port,
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`
  };
}

function stopPanelServer() {
  if (!server) return;
  server.close();
  server = null;
}

module.exports = {
  startPanelServer,
  stopPanelServer,
  getPanelServerInfo
};
