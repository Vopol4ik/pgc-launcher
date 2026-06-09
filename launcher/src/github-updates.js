'use strict';

/** Имя файла в GitHub Release (без подпапок). Как при gh release upload: пробелы и (1) → точки. */
function releaseAssetName(relPath) {
  return String(relPath)
    .replace(/\\/g, '/')
    .replace(/\//g, '__')
    .replace(/ /g, '.')
    .replace(/\((\d+)\)/g, '.$1');
}

function isGithubConfigured(github) {
  return Boolean(
    github?.owner
    && github?.repo
    && !String(github.owner).startsWith('YOUR_')
  );
}

function rawFileUrl(github, relativePath) {
  const branch = github.branch || 'main';
  const rel = String(relativePath).replace(/\\/g, '/').replace(/^\//, '');
  return `https://raw.githubusercontent.com/${github.owner}/${github.repo}/${branch}/${rel}`;
}

function releaseDownloadUrl(github, relPath) {
  const tag = github.releaseTag || 'modpack-latest';
  const asset = relPath.includes('/')
    ? releaseAssetName(relPath)
    : String(relPath).replace(/\\/g, '/');
  return `https://github.com/${github.owner}/${github.repo}/releases/download/${tag}/${asset}`;
}

/** Полный modpack content.7z в GitHub Release (лаунчер ~70 МБ, сборка качается при первом запуске). */
function releaseContent7zUrl(github) {
  if (!isGithubConfigured(github)) return null;
  return releaseDownloadUrl(github, 'content.7z');
}

function resolveContentUrls(github, legacy) {
  if (!isGithubConfigured(github)) {
    return {
      manifestUrl: legacy?.manifestUrl || null,
      filesBaseUrl: legacy?.filesBaseUrl || null,
      useGithubReleases: false
    };
  }

  return {
    manifestUrl: rawFileUrl(github, 'modpack-manifest.json'),
    filesBaseUrl: null,
    useGithubReleases: true,
    releaseTag: github.releaseTag || 'modpack-latest'
  };
}

module.exports = {
  isGithubConfigured,
  rawFileUrl,
  releaseDownloadUrl,
  releaseContent7zUrl,
  resolveContentUrls
};
