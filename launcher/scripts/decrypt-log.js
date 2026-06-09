'use strict';

const fs = require('fs');
const path = require('path');
const { decryptPayload } = require('../src/pgc-crypto');

const [,, fileArg, passphrase, outArg] = process.argv;

if (!fileArg || !passphrase) {
  console.error('Usage: node launcher/scripts/decrypt-log.js <file.pgcenc.json> <passphrase> [output.log]');
  process.exit(1);
}

const file = path.resolve(fileArg);
const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
const plain = decryptPayload(envelope, passphrase);
const out = outArg
  ? path.resolve(outArg)
  : file.replace(/\.(pgcenc\.)?json$/i, '.decrypted.log');

fs.writeFileSync(out, plain, 'utf8');
console.log(`Decrypted ${plain.length} chars -> ${out}`);
