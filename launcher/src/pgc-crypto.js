'use strict';

const crypto = require('crypto');
const zlib = require('zlib');

const MAGIC = 'PGCLOG';
const VERSION = 2;
const ALGO_NAME = 'pgc-shield-v2';
const LEGACY_SALT = 'pgc-launcher-log-v1';
const LEGACY_ALGO = 'aes-256-gcm';

function deriveKeys(passphrase) {
  const pass = String(passphrase || '');
  const opts = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
  const k1 = crypto.scryptSync(pass, 'pgc-shield-v2|primary|globalwar', 32, opts);
  const k2 = crypto.scryptSync(pass, 'pgc-shield-v2|mix|globalwar', 32, opts);
  const aesKey = crypto.createHmac('sha256', k1).update(k2).update('pgc-log-seal-v2').digest();
  return { aesKey, mixKey: k2 };
}

function pgcMix(data, mixKey) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i += 1) {
    const rot = ((i * 0x9E3779B9) >>> 0) & 0xFF;
    const m = mixKey[i % mixKey.length]
      ^ mixKey[(i * 7 + 13) % mixKey.length]
      ^ rot;
    out[i] = buf[i] ^ m;
  }
  return out;
}

function legacyDeriveKey(passphrase) {
  return crypto.scryptSync(String(passphrase || ''), LEGACY_SALT, 32);
}

function encryptPayload(plaintext, passphrase) {
  const { aesKey, mixKey } = deriveKeys(passphrase);
  const compressed = zlib.deflateSync(Buffer.from(String(plaintext), 'utf8'), { level: 9 });
  const mixed = pgcMix(compressed, mixKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const encrypted = Buffer.concat([cipher.update(mixed), cipher.final()]);
  return {
    magic: MAGIC,
    v: VERSION,
    alg: ALGO_NAME,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
    meta: { compressed: true, mixed: true }
  };
}

function decryptLegacy(envelope, passphrase) {
  const key = legacyDeriveKey(passphrase);
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const data = Buffer.from(envelope.data, 'base64');
  const decipher = crypto.createDecipheriv(LEGACY_ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function decryptPayload(envelope, passphrase) {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('Некорректный файл шифрования');
  }
  if (Number(envelope.v) === 1 || envelope.alg === LEGACY_ALGO) {
    return decryptLegacy(envelope, passphrase);
  }
  if (envelope.magic !== MAGIC || Number(envelope.v) !== VERSION) {
    throw new Error(`Неизвестный формат (v=${envelope.v || '?'})`);
  }

  const { aesKey, mixKey } = deriveKeys(passphrase);
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const data = Buffer.from(envelope.data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(tag);
  const mixed = Buffer.concat([decipher.update(data), decipher.final()]);
  const compressed = pgcMix(mixed, mixKey);
  return zlib.inflateSync(compressed).toString('utf8');
}

module.exports = {
  MAGIC,
  VERSION,
  ALGO_NAME,
  encryptPayload,
  decryptPayload
};
