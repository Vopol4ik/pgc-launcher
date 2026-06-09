'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { getGameDir } = require('./paths');

const PENDING_FILE = 'registration-pending.json';

function pendingPath() {
  return path.join(getGameDir(), PENDING_FILE);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function encryptPasswordForSettings(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);
  return { passwordSalt: salt, passwordHash };
}

function isRegistered(settings) {
  return Boolean(settings?.registered && settings?.username);
}

async function writePendingRegistration({ username, passwordHash, hwid }) {
  const entry = {
    username: String(username).toLowerCase(),
    hwid,
    passwordHash,
    createdAt: new Date().toISOString()
  };
  await fsp.mkdir(getGameDir(), { recursive: true });
  await fsp.writeFile(pendingPath(), JSON.stringify(entry, null, 2), 'utf8');
  return entry;
}

async function readPendingRegistration() {
  try {
    const raw = await fsp.readFile(pendingPath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function clearPendingRegistration() {
  try {
    await fsp.rm(pendingPath(), { force: true });
    return true;
  } catch {
    return false;
  }
}

async function hasPendingRegistration() {
  return fs.existsSync(pendingPath());
}

module.exports = {
  isRegistered,
  encryptPasswordForSettings,
  writePendingRegistration,
  readPendingRegistration,
  clearPendingRegistration,
  hasPendingRegistration,
  pendingPath
};
