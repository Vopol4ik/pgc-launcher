'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const config = require('./config');
const { getMachineHwid } = require('./hwid');
const {
  readPendingRegistration,
  clearPendingRegistration
} = require('./registration-store');

function panelBaseUrl() {
  const remote = String(config.panel?.remoteUrl || '').trim();
  if (remote) return remote.replace(/\/$/, '');
  const port = Number(config.panel?.port) || 17890;
  const host = config.panel?.remoteHost || '127.0.0.1';
  return `http://${host}:${port}`;
}

function clientSecret() {
  return String(config.panel?.clientSecret || 'PGC-Panel-Client-2026');
}

function requestJson(pathname, { method = 'GET', body } = {}) {
  const url = new URL(pathname, `${panelBaseUrl()}/`);
  const payload = body ? JSON.stringify(body) : null;
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-PGC-Client': clientSecret()
        },
        timeout: 12000
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
          } catch {
            reject(new Error('Некорректный ответ панели'));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Таймаут панели')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function syncPendingRegistration() {
  const pending = await readPendingRegistration();
  if (!pending) return { ok: true, skipped: true };
  try {
    const res = await requestJson('/api/client/register', {
      method: 'POST',
      body: pending
    });
    if (res?.synced) {
      await clearPendingRegistration();
      return { ok: true, synced: true };
    }
    return { ok: false, offline: false };
  } catch {
    return { ok: false, offline: true };
  }
}

async function syncClientState(state) {
  try {
    return await requestJson('/api/client/heartbeat', {
      method: 'POST',
      body: {
        hwid: getMachineHwid(),
        username: state.username || null,
        launcherVersion: config.appVersion,
        pid: process.pid,
        gameRunning: Boolean(state.gameRunning)
      }
    });
  } catch {
    return { ok: false, offline: true };
  }
}

function startPanelClientLoop(handlers) {
  const interval = Number(config.panel?.pollIntervalMs) || 5000;
  let stopped = false;

  async function tick() {
    if (stopped) return;
    const state = {
      username: handlers.getUsername?.() || null,
      gameRunning: handlers.isGameRunning?.() || false
    };
    const res = await syncClientState(state);
    await syncPendingRegistration();
    if (res?.banned) {
      handlers.onBanned?.(res.reason || 'Доступ заблокирован');
      return;
    }
    if (Array.isArray(res?.commands)) {
      for (const cmd of res.commands) {
        handlers.onCommand?.(cmd);
      }
    }
  }

  tick();
  const timer = setInterval(tick, interval);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

module.exports = {
  panelBaseUrl,
  getMachineHwid,
  syncClientState,
  syncPendingRegistration,
  startPanelClientLoop
};
