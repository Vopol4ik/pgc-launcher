'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');
const config = require('./config');
const { fetchJson } = require('./download');
const { isGithubConfigured, rawFileUrl } = require('./github-updates');

function fetchGithubNews(github) {
  const branch = github.branch || 'main';
  const url = `https://api.github.com/repos/${github.owner}/${github.repo}/contents/news.json?ref=${encodeURIComponent(branch)}`;
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'PGC-Launcher/1.0',
        Accept: 'application/vnd.github.raw+json'
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`GitHub API HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(new Error('Некорректный news.json на GitHub'));
        }
      });
    }).on('error', reject).setTimeout(60000, () => {
      reject(new Error('Таймаут загрузки news.json'));
    });
  });
}

async function fetchRemoteNews(github) {
  try {
    return await fetchGithubNews(github);
  } catch {
    return fetchJson(`${rawFileUrl(github, 'news.json')}?t=${Date.now()}`);
  }
}

function resolveBundledNews() {
  const candidates = [
    path.join(process.resourcesPath || '', 'news.json'),
    path.join(__dirname, '..', 'resources', 'news.json')
  ];
  for (const file of candidates) {
    if (!file || !fs.existsSync(file)) continue;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // пробуем следующий источник
    }
  }
  return { items: [] };
}

function mergeNewsItems(...lists) {
  const seen = new Set();
  const items = [];
  for (const list of lists) {
    for (const item of list || []) {
      if (!item?.title) continue;
      const key = `${item.date || ''}|${item.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }
  return items;
}

async function fetchNews() {
  const bundled = resolveBundledNews();
  let remote = null;
  let remoteError = null;

  if (isGithubConfigured(config.github)) {
    try {
      remote = await fetchRemoteNews(config.github);
    } catch (err) {
      remote = null;
      remoteError = err?.message || 'GitHub недоступен';
    }
  }

  if (Array.isArray(remote?.items) && remote.items.length > 0) {
    return {
      source: 'remote',
      updatedAt: remote.updatedAt || bundled?.updatedAt || null,
      items: remote.items
    };
  }

  if (Array.isArray(bundled?.items) && bundled.items.length > 0) {
    return {
      source: 'bundled',
      updatedAt: bundled.updatedAt || null,
      items: bundled.items,
      remoteError
    };
  }

  return {
    source: 'none',
    updatedAt: bundled?.updatedAt || null,
    items: [],
    remoteError
  };
}

module.exports = { fetchNews, resolveBundledNews, mergeNewsItems };
