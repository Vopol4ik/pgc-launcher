'use strict';

const { safeStorage } = require('electron');

function encodePassword(password) {
  const value = String(password || '');
  if (!value) return null;
  if (safeStorage.isEncryptionAvailable()) {
    return {
      v: 2,
      data: safeStorage.encryptString(value).toString('base64')
    };
  }
  return {
    v: 1,
    data: Buffer.from(value, 'utf8').toString('base64')
  };
}

function decodePassword(stored) {
  if (!stored?.data) return '';
  try {
    if (stored.v === 2 && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(stored.data, 'base64'));
    }
    return Buffer.from(stored.data, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function applyRememberPassword(settings, payload = {}) {
  const next = { ...settings };
  const remember = payload.rememberPassword ?? next.rememberPassword;

  if (remember === false) {
    delete next.savedPasswordEnc;
    next.rememberPassword = false;
    return next;
  }

  if (payload.rememberPassword === true || remember === true) {
    next.rememberPassword = true;
  }

  if (payload.savedPassword != null && String(payload.savedPassword).length > 0) {
    next.savedPasswordEnc = encodePassword(payload.savedPassword);
  }

  return next;
}

function readSavedPassword(settings) {
  if (!settings?.rememberPassword) return '';
  return decodePassword(settings.savedPasswordEnc);
}

function sanitizeSettingsForRenderer(settings) {
  const copy = { ...settings };
  delete copy.savedPasswordEnc;
  if (copy.rememberPassword) {
    copy.savedPassword = readSavedPassword(settings);
  } else {
    copy.savedPassword = '';
  }
  return copy;
}

module.exports = {
  applyRememberPassword,
  readSavedPassword,
  sanitizeSettingsForRenderer
};
