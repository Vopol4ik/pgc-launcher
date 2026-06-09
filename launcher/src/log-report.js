'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const config = require('./config');
const { ALGO_NAME, encryptPayload } = require('./pgc-crypto');

const GAME_ERROR_RE = /Connection reset|Failed to connect|Internal Exception|Disconnected from|Lost connection|Timed out|java\.net\.|java\.lang\.|ERROR|FATAL|Crash Report|Exception in thread/i;
const LAUNCHER_ERROR_LINE_RE = /Connection reset|Internal Exception|Disconnected|Failed to connect|ERROR|Exception:|java\.net\.|Timed out|Не удалось|Ошибка:/i;

function isDiscordWebhookUrl(urlString) {
  try {
    const u = new URL(String(urlString || '').trim());
    return u.protocol === 'https:'
      && (u.hostname === 'discord.com' || u.hostname === 'discordapp.com')
      && /^\/api\/webhooks\/\d+\/[\w-]+/.test(u.pathname);
  } catch {
    return false;
  }
}

function readTail(file, maxBytes) {
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
}

function redactSecrets(text) {
  return String(text)
    .replace(/accessToken[=:]\s*\S+/gi, 'accessToken=[REDACTED]')
    .replace(/--accessToken\s+\S+/gi, '--accessToken [REDACTED]')
    .replace(/("accessToken"\s*:\s*")[^"]+/gi, '$1[REDACTED]');
}

function buildSessionReportText(sessionEvents = [], gameDir, launcherLines = []) {
  const maxBytes = config.logReport?.maxLogBytes || 1_500_000;
  const perFile = Math.floor(maxBytes / 2);
  const chunks = [];

  chunks.push('===== PGC Session Report =====\n');
  chunks.push(`Generated: ${new Date().toISOString()}\n`);
  chunks.push(`Events: ${sessionEvents.length}\n\n`);

  for (const ev of sessionEvents) {
    const detail = ev.detail ? `: ${ev.detail}` : '';
    chunks.push(`[${ev.at}] ${ev.type}${detail}\n`);
  }

  chunks.push('\n===== launcher-journal =====\n');
  if (launcherLines.length) {
    chunks.push(launcherLines.slice(-600).join('\n'));
  } else {
    chunks.push('(empty)');
  }

  for (const name of ['latest.log', 'debug.log']) {
    const file = path.join(gameDir, 'logs', name);
    if (!fs.existsSync(file)) continue;
    chunks.push(`\n===== ${name} (tail) =====\n`);
    chunks.push(readTail(file, perFile));
  }

  return redactSecrets(chunks.join(''));
}

function readGameLogTail(gameDir, maxBytes = 120_000) {
  const file = path.join(gameDir, 'logs', 'latest.log');
  if (!fs.existsSync(file)) return '';
  return readTail(file, maxBytes);
}

function detectConnectFailure(gameDir) {
  const tail = readGameLogTail(gameDir);
  if (!tail) return false;
  const tried = /Connecting to operativniki\.minerent\.io/i.test(tail);
  const failed = /Connection reset|Failed to connect|Internal Exception:\s*java\.net\.SocketException/i.test(tail);
  const joined = /\[CHAT\]|joined the game|Logged in with entity/i.test(tail);
  return tried && failed && !joined;
}

function detectGameErrors(gameDir) {
  const tail = readGameLogTail(gameDir);
  return Boolean(tail && GAME_ERROR_RE.test(tail));
}

function isErrorLogLine(text) {
  const line = String(text || '').trim();
  if (!line || line.startsWith('[debug]')) return false;
  if (/\[session /.test(line)) return false;
  return LAUNCHER_ERROR_LINE_RE.test(line);
}

function buildMultipart(boundary, fields, files) {
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="${name}"\r\n\r\n`,
      `${value}\r\n`
    );
  }
  for (const file of files) {
    parts.push(
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n`,
      `Content-Type: ${file.contentType}\r\n\r\n`
    );
    parts.push(file.body);
    parts.push('\r\n');
  }
  parts.push(`--${boundary}--\r\n`);
  return Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'utf8'))));
}

function postDiscordWebhook(webhookUrl, body, contentType) {
  return new Promise((resolve, reject) => {
    const u = new URL(webhookUrl.trim());
    const req = https.request({
      hostname: u.hostname,
      path: `${u.pathname}${u.search}`,
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Length': body.length,
        'User-Agent': 'PGC-Launcher/1.0'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
          return;
        }
        const detail = Buffer.concat(chunks).toString('utf8').slice(0, 300);
        reject(new Error(`Discord HTTP ${res.statusCode}${detail ? `: ${detail}` : ''}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(90_000, () => req.destroy(new Error('Таймаут Discord webhook')));
    req.write(body);
    req.end();
  });
}

async function sendEncryptedLogReport({
  gameDir,
  webhookUrl,
  encryptPassphrase,
  username,
  launcherVersion,
  reason,
  launcherLines = [],
  sessionEvents = []
}) {
  if (!isDiscordWebhookUrl(webhookUrl)) {
    throw new Error('Укажите корректный Discord webhook (https://discord.com/api/webhooks/...)');
  }
  if (!encryptPassphrase || String(encryptPassphrase).length < 8) {
    throw new Error('Ключ шифрования должен быть не короче 8 символов');
  }

  const raw = buildSessionReportText(sessionEvents, gameDir, launcherLines);
  if (!raw.trim()) throw new Error('Логи не найдены');

  const envelope = encryptPayload(raw, encryptPassphrase);
  const fileBody = Buffer.from(JSON.stringify(envelope, null, 2), 'utf8');
  const filename = `pgc-session-${Date.now()}.pgcenc.json`;
  const eventSummary = sessionEvents.length
    ? sessionEvents.map((e) => e.type).slice(-8).join(', ')
    : reason || 'manual';

  const payload = {
    content: [
      '**PGC Launcher — session log**',
      `User: \`${username || 'unknown'}\``,
      `Launcher: \`${launcherVersion || '?'}\``,
      `Reason: \`${reason || 'session'}\``,
      `Events (${sessionEvents.length}): \`${eventSummary}\``,
      `Cipher: ${ALGO_NAME}`,
      'Decrypt: `Расшифровать лог.bat` на рабочем столе'
    ].join('\n')
  };

  const boundary = `----PGC${crypto.randomBytes(12).toString('hex')}`;
  const body = buildMultipart(boundary, {
    payload_json: JSON.stringify(payload)
  }, [{
    field: 'files[0]',
    filename,
    contentType: 'application/json',
    body: fileBody
  }]);

  await postDiscordWebhook(webhookUrl, body, `multipart/form-data; boundary=${boundary}`);
  return { filename, bytes: fileBody.length };
}

module.exports = {
  detectConnectFailure,
  detectGameErrors,
  isErrorLogLine,
  sendEncryptedLogReport
};
