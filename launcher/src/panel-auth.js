'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { getPanelDir, ensurePanelData } = require('./panel-store');

const ADMIN_FILE = 'admin.json';
const sessions = new Map();

function adminPath() {
  return path.join(getPanelDir(), ADMIN_FILE);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

async function readAdminConfig() {
  await ensurePanelData();
  try {
    return JSON.parse(await fsp.readFile(adminPath(), 'utf8'));
  } catch {
    return null;
  }
}

async function isAdminConfigured() {
  const cfg = await readAdminConfig();
  return Boolean(cfg?.passwordHash && cfg?.salt);
}

async function setupAdminPassword(password) {
  if (await isAdminConfigured()) {
    throw new Error('Пароль администратора уже задан');
  }
  if (!password || String(password).length < 8) {
    throw new Error('Пароль минимум 8 символов');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);
  await fsp.writeFile(
    adminPath(),
    JSON.stringify({ passwordHash, salt, createdAt: new Date().toISOString() }, null, 2),
    'utf8'
  );
  return createSession();
}

async function loginAdmin(password) {
  const cfg = await readAdminConfig();
  if (!cfg?.passwordHash || !cfg?.salt) {
    throw new Error('Сначала задайте пароль администратора');
  }
  const hash = hashPassword(password, cfg.salt);
  if (hash !== cfg.passwordHash) {
    throw new Error('Неверный пароль');
  }
  return createSession();
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + 12 * 60 * 60 * 1000;
  sessions.set(token, { expires });
  return { token, expires };
}

function parseBearer(req) {
  const raw = req.headers.authorization || req.headers.Authorization || '';
  const m = String(raw).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function parseCookie(req, name) {
  const header = req.headers.cookie || '';
  const m = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : '';
}

function isSessionValid(token) {
  if (!token) return false;
  const item = sessions.get(token);
  if (!item) return false;
  if (item.expires < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function isAdminRequest(req) {
  const token = parseBearer(req) || parseCookie(req, 'pgc_admin');
  return isSessionValid(token);
}

function authCookieHeader(token) {
  return `pgc_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${12 * 60 * 60}`;
}

module.exports = {
  isAdminConfigured,
  setupAdminPassword,
  loginAdmin,
  isAdminRequest,
  authCookieHeader,
  createSession
};
