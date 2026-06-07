'use strict';

const fs = require('fs');
const https = require('https');
const config = require('./config');

const downloadAgent = new https.Agent({
  keepAlive: true,
  maxSockets: Math.max(4, Number(config.maxDownloadSockets) || 8)
});

function download(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) {
      return reject(new Error('Слишком много перенаправлений при загрузке'));
    }
    const req = https.get(url, {
      agent: downloadAgent,
      headers: {
        'User-Agent': 'PGC-Launcher/1.0',
        Accept: '*/*'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(download(next, dest, onProgress, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} при загрузке ${url}`));
      }

      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      const file = fs.createWriteStream(dest);

      res.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress && total) onProgress(received / total);
      });
      res.on('error', (err) => {
        file.destroy();
        fs.rmSync(dest, { force: true });
        reject(err);
      });

      res.pipe(file);

      file.on('error', (err) => {
        fs.rmSync(dest, { force: true });
        reject(err);
      });
      file.on('finish', () => {
        file.close(() => {
          if (total && received < total) {
            fs.rmSync(dest, { force: true });
            return reject(new Error(`Загрузка оборвалась: ${received} из ${total} байт`));
          }
          resolve();
        });
      });
    });

    req.on('error', (err) => {
      fs.rmSync(dest, { force: true });
      reject(err);
    });
    req.setTimeout(120000, () => req.destroy(new Error('Таймаут загрузки')));
  });
}

function fetchJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) {
      return reject(new Error('Слишком много перенаправлений при запросе API'));
    }
    https.get(url, {
      agent: downloadAgent,
      headers: {
        'User-Agent': 'PGC-Launcher/1.0',
        Accept: 'application/json'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(fetchJson(next, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} при запросе ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(new Error('Некорректный ответ API'));
        }
      });
    }).on('error', reject).setTimeout(60000, () => {
      reject(new Error('Таймаут запроса API'));
    });
  });
}

module.exports = { download, fetchJson };
