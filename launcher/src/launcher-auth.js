'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('./config');
const { fetchJson } = require('./download');
const { isGithubConfigured, rawFileUrl } = require('./github-updates');

const SESSION_DAYS = 7;
const AUTH_CACHE_MS = 60000;
const MIN_PASSWORD_LEN = 4;
const NICK_RE = /^[A-Za-z0-9_]{3,16}$/;

let authConfigCache = null;
let authConfigExpires = 0;

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function normalizeLogin(login) {
  return String(login || '').trim().toLowerCase();
}

function registrationsPath(gameDir) {
  return path.join(gameDir, 'launcher-registrations.json');
}

function resolveBundledAuth() {
  const candidates = [
    path.join(process.resourcesPath || '', 'launcher-auth.json'),
    path.join(__dirname, '..', 'resources', 'launcher-auth.json')
  ];
  const file = candidates.find((p) => fs.existsSync(p));
  if (!file) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function fetchAuthConfig(force = false) {
  const now = Date.now();
  if (!force && authConfigCache && now < authConfigExpires) return authConfigCache;

  let remote = null;
  if (isGithubConfigured(config.github)) {
    try {
      remote = await fetchJson(rawFileUrl(config.github, 'launcher-auth.json'));
    } catch {
      remote = null;
    }
  }

  authConfigCache = remote || resolveBundledAuth() || { users: [] };
  authConfigExpires = now + AUTH_CACHE_MS;
  return authConfigCache;
}

function readLocalRegistrations(gameDir) {
  try {
    return JSON.parse(fs.readFileSync(registrationsPath(gameDir), 'utf8'));
  } catch {
    return { users: [] };
  }
}

async function writeLocalRegistrations(gameDir, data) {
  await fsp.mkdir(gameDir, { recursive: true });
  await fsp.writeFile(
    registrationsPath(gameDir),
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        users: data.users || []
      },
      null,
      2
    ),
    'utf8'
  );
}

function findUserInList(users, login) {
  const normalized = normalizeLogin(login);
  return (users || []).find((user) => normalizeLogin(user.login) === normalized) || null;
}

async function findUserRecord(gameDir, login) {
  const authConfig = await fetchAuthConfig();
  const remoteUser = findUserInList(authConfig?.users, login);
  if (remoteUser) return { source: 'remote', user: remoteUser };

  const local = readLocalRegistrations(gameDir);
  const localUser = findUserInList(local.users, login);
  if (localUser) return { source: 'local', user: localUser };

  return null;
}

function buildSession(login, passSha256) {
  const normalized = normalizeLogin(login);
  return {
    login: normalized,
    token: sha256(`${normalized}:${passSha256}:pgc-session`),
    expiresAt: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000
  };
}

function hashPassword(login, password) {
  return sha256(`${normalizeLogin(login)}:${password}`);
}

async function checkLoginExists(gameDir, login) {
  if (!NICK_RE.test(String(login || '').trim())) {
    return { ok: true, exists: false };
  }
  const record = await findUserRecord(gameDir, login);
  return { ok: true, exists: Boolean(record) };
}

async function registerAccount(gameDir, login, password, confirmPassword) {
  const normalized = normalizeLogin(login);
  if (!NICK_RE.test(normalized)) {
    return { ok: false, error: 'Ник: 3–16 символов, латиница, цифры и _.' };
  }
  if (!password || password.length < MIN_PASSWORD_LEN) {
    return { ok: false, error: `Пароль минимум ${MIN_PASSWORD_LEN} символа.` };
  }
  if (password !== confirmPassword) {
    return { ok: false, error: 'Пароли не совпадают.' };
  }

  const existing = await findUserRecord(gameDir, normalized);
  if (existing) {
    return { ok: false, error: 'Этот ник уже занят. Введите пароль и нажмите «Играть».' };
  }

  const local = readLocalRegistrations(gameDir);
  const entry = {
    login: normalized,
    passSha256: hashPassword(normalized, password),
    registeredAt: new Date().toISOString()
  };
  local.users = [...(local.users || []).filter((u) => normalizeLogin(u.login) !== normalized), entry];
  await writeLocalRegistrations(gameDir, local);

  return {
    ok: true,
    login: normalized,
    session: buildSession(normalized, entry.passSha256)
  };
}

async function login(gameDir, loginName, password) {
  const normalized = normalizeLogin(loginName);
  if (!normalized || !password) {
    return { ok: false, error: 'Введите ник и пароль.' };
  }

  const record = await findUserRecord(gameDir, normalized);
  if (!record?.user?.passSha256) {
    return { ok: false, error: 'Аккаунт не найден. Нажмите «Регистрация».' };
  }

  if (hashPassword(normalized, password) !== record.user.passSha256) {
    return { ok: false, error: 'Неверный пароль.' };
  }

  return {
    ok: true,
    login: normalized,
    session: buildSession(normalized, record.user.passSha256)
  };
}

function isSessionFresh(session) {
  return Boolean(session?.login && session?.token && Number(session.expiresAt) > Date.now());
}

async function validateSession(gameDir, session) {
  if (!isSessionFresh(session)) {
    return { ok: false, reason: 'expired' };
  }

  const record = await findUserRecord(gameDir, session.login);
  if (!record?.user?.passSha256) {
    return { ok: false, reason: 'revoked' };
  }

  const expected = sha256(`${session.login}:${record.user.passSha256}:pgc-session`);
  if (expected !== session.token) {
    return { ok: false, reason: 'invalid' };
  }

  return { ok: true, login: session.login };
}

module.exports = {
  login,
  registerAccount,
  checkLoginExists,
  validateSession,
  isSessionFresh,
  fetchAuthConfig
};
