#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = process.argv[2];
if (!target || !path.isAbsolute(target)) throw new Error('An absolute env-file path is required');
const changes = {
  FIGURINE_STORAGE_DRIVER: 's3',
  FIGURINE_PRIVATE_S3_ENDPOINT: process.env.FIGURINE_PRIVATE_S3_ENDPOINT,
  FIGURINE_PRIVATE_S3_INTERNAL_ENDPOINT: process.env.FIGURINE_PRIVATE_S3_INTERNAL_ENDPOINT,
  FIGURINE_PRIVATE_S3_BUCKET: process.env.FIGURINE_PRIVATE_S3_BUCKET,
  FIGURINE_PRIVATE_S3_REGION: process.env.FIGURINE_PRIVATE_S3_REGION,
  FIGURINE_PRIVATE_S3_ACCESS_KEY_ID: process.env.FIGURINE_PRIVATE_S3_ACCESS_KEY_ID,
  FIGURINE_PRIVATE_S3_SECRET_ACCESS_KEY: process.env.FIGURINE_PRIVATE_S3_SECRET_ACCESS_KEY,
  FIGURINE_MAX_FILE_BYTES: '10485760',
  FIGURINE_MAX_FILES: '10',
  FIGURINE_MAX_TOTAL_BYTES: '52428800',
  FIGURINE_MAX_PIXELS: '40000000',
  FIGURINE_REQUESTS_ENABLED: 'false',
  FIGURINE_PAYMENTS_ENABLED: 'false',
  CUSTOMER_SCHEMA_SETUP: 'false',
};
for (const [key, value] of Object.entries(changes)) {
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Missing or invalid setting: ${key}`);
}
const serialize = value => `'${value.replaceAll("'", "\\'")}'`;
const source = fs.readFileSync(target, 'utf8');
const seen = new Set();
const lines = source.split(/(?<=\n)/).map(line => {
  const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
  if (!match || !(match[1] in changes)) return line;
  seen.add(match[1]);
  return `${match[1]}=${serialize(changes[match[1]])}\n`;
});
for (const [key, value] of Object.entries(changes)) if (!seen.has(key)) lines.push(`${key}=${serialize(value)}\n`);
const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
const descriptor = fs.openSync(temporary, 'wx', 0o600);
try { fs.writeFileSync(descriptor, lines.join('')); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
fs.renameSync(temporary, target);
fs.chmodSync(target, 0o600);
console.log('Private figurine storage settings saved; figurine submission, payment, and schema setup remain disabled.');
