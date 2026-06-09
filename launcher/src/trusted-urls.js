'use strict';

const config = require('./config');

function githubPaths() {
  const owner = String(config.github?.owner || '').trim();
  const repo = String(config.github?.repo || '').trim();
  if (!owner || !repo || owner.startsWith('YOUR_')) return null;
  return { owner: owner.toLowerCase(), repo: repo.toLowerCase() };
}

function isGithubAssetRedirect(urlString) {
  try {
    const host = new URL(String(urlString || '')).hostname.toLowerCase();
    return host.endsWith('.githubusercontent.com');
  } catch {
    return false;
  }
}

function pathMatchesRepo(pathname, gh) {
  const prefix = `/${gh.owner}/${gh.repo}/`;
  return String(pathname || '').toLowerCase().startsWith(prefix);
}

function isTrustedUrl(urlString, { allowMcsrvstat = false, allowGithubAssets = false } = {}) {
  let url;
  try {
    url = new URL(String(urlString || ''));
  } catch {
    return false;
  }

  if (url.protocol !== 'https:') return false;

  const host = url.hostname.toLowerCase();
  if (allowMcsrvstat && host === 'api.mcsrvstat.us') return true;
  if (allowGithubAssets && isGithubAssetRedirect(urlString)) return true;

  const gh = githubPaths();
  if (!gh) return false;

  const path = url.pathname;
  if (host === 'github.com') {
    return pathMatchesRepo(path, gh);
  }
  if (host === 'raw.githubusercontent.com') {
    return pathMatchesRepo(path, gh);
  }
  if (host === 'api.github.com') {
    return path.toLowerCase().startsWith(`/repos/${gh.owner}/${gh.repo}/`);
  }
  return false;
}

function assertTrustedUrl(urlString, options = {}) {
  if (!isTrustedUrl(urlString, options)) {
    throw new Error(`Загрузка заблокирована: неразрешённый URL (${urlString})`);
  }
}

function assertDownloadUrl(urlString, { redirect = false } = {}) {
  if (isTrustedUrl(urlString)) return;
  if (redirect && isGithubAssetRedirect(urlString)) return;
  throw new Error(`Загрузка заблокирована: неразрешённый URL (${urlString})`);
}

function filterTrustedUrls(urls, options = {}) {
  return [...new Set((urls || []).filter((url) => isTrustedUrl(url, options)))];
}

module.exports = {
  isTrustedUrl,
  assertTrustedUrl,
  assertDownloadUrl,
  filterTrustedUrls
};
