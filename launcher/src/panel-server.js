'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { URL } = require('url');
const config = require('./config');
const {
  ensurePanelData,
  readBans,
  saveBans,
  buildPanelSnapshot
} = require('./panel-store');
const { fetchServerStatus } = require('./server-status');

const PANEL_ROOT = path.join(__dirname, 'panel');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

let server = null;
let liveProvider = () => ({});

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
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

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { ok: true, local: true });
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

  if (req.method === 'GET' && url.pathname === '/api/bans') {
    const bans = await readBans();
    return json(res, 200, { ok: true, bans });
  }

  if (req.method === 'POST' && url.pathname === '/api/bans') {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return json(res, 400, { ok: false, error: 'Некорректный JSON' });
    }
    const player = String(body.player || '').trim().toLowerCase();
    if (!/^[a-z0-9_]{3,16}$/.test(player)) {
      return json(res, 400, { ok: false, error: 'Ник: 3–16 символов, латиница, цифры, _' });
    }
    const bans = await readBans();
    const entry = {
      player,
      reason: String(body.reason || 'Нарушение правил').slice(0, 200),
      by: String(body.by || 'Локальная панель').slice(0, 64),
      until: body.permanent ? null : (body.until || null),
      permanent: Boolean(body.permanent),
      active: body.active !== false,
      createdAt: new Date().toISOString()
    };
    const idx = bans.findIndex((b) => b.player === player);
    if (idx >= 0) bans[idx] = { ...bans[idx], ...entry };
    else bans.unshift(entry);
    await saveBans(bans);
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
    const player = String(body.player || '').trim().toLowerCase();
    const bans = await readBans();
    const item = bans.find((b) => b.player === player);
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

async function startPanelServer(provider) {
  if (server) return getPanelServerInfo();

  liveProvider = typeof provider === 'function' ? provider : () => ({});
  await ensurePanelData();

  const port = Number(config.panel?.port) || 17890;
  const host = config.panel?.host || '127.0.0.1';

  server = http.createServer(createRequestHandler(port));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  return getPanelServerInfo();
}

function getPanelServerInfo() {
  const port = Number(config.panel?.port) || 17890;
  const host = config.panel?.host || '127.0.0.1';
  return {
    running: Boolean(server),
    host,
    port,
    url: `http://${host}:${port}`
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
