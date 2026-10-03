#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const required = name => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required setting: ${name}`);
  return value;
};
const bucket = required('FIGURINE_PRIVATE_S3_BUCKET');
const region = required('FIGURINE_PRIVATE_S3_REGION');
const publicEndpoint = required('FIGURINE_PRIVATE_S3_ENDPOINT');
const internalEndpoint = required('FIGURINE_PRIVATE_S3_INTERNAL_ENDPOINT');
const origin = required('CUSTOMER_PUBLIC_ORIGIN');
const credentials = { accessKeyId: required('FIGURINE_PRIVATE_S3_ACCESS_KEY_ID'), secretAccessKey: required('FIGURINE_PRIVATE_S3_SECRET_ACCESS_KEY') };
const internal = new S3Client({ endpoint: internalEndpoint, region, forcePathStyle: true, credentials });
const external = new S3Client({ endpoint: publicEndpoint, region, forcePathStyle: true, credentials });
function originBound(command) {
  command.middlewareStack.add(next => async args => { args.request.headers.origin = origin; return next(args); },
    { step: 'build', name: `bindOrigin${crypto.randomUUID()}` });
  return command;
}

async function denied(action, label) {
  try { await action(); } catch (error) { if ([401, 403].includes(error?.$metadata?.httpStatusCode)) return; throw error; }
  throw new Error(`${label} unexpectedly succeeded`);
}

async function main() {
  const key = `quarantine/live-${crypto.randomUUID()}`;
  const body = Buffer.from('synthetic-live-object-storage-test');
  const metadata = { 'upload-token': crypto.randomBytes(24).toString('base64url') };
  const command = new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentLength: body.length,
    ContentType: 'application/octet-stream', Metadata: metadata });
  const url = await getSignedUrl(external, originBound(command), { expiresIn: 300,
    unhoistableHeaders: new Set(['x-amz-meta-upload-token']) });
  const signedHeaders = new URL(url).searchParams.get('X-Amz-SignedHeaders') || '';
  if (!signedHeaders.split(';').includes('x-amz-meta-upload-token')) throw new Error('Upload metadata header was not covered by the signature');
  const preflight = await fetch(url, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT',
    'Access-Control-Request-Headers': 'content-type,x-amz-meta-upload-token' } });
  if (!preflight.ok || preflight.headers.get('access-control-allow-origin') !== origin) throw new Error(`Exact-origin CORS failed: HTTP ${preflight.status}`);
  const evilPreflight = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'https://invalid.example', 'Access-Control-Request-Method': 'PUT',
    'Access-Control-Request-Headers': 'content-type,x-amz-meta-upload-token' } });
  if (evilPreflight.headers.get('access-control-allow-origin')) throw new Error('Unexpected CORS grant for foreign origin');
  const upload = await fetch(url, { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/octet-stream',
    'x-amz-meta-upload-token': metadata['upload-token'] }, body });
  if (!upload.ok || upload.headers.get('access-control-allow-origin') !== origin) {
    const detail = (await upload.text()).replace(/[A-Za-z0-9_+\/-]{32,}/g, '[redacted]').slice(0, 500);
    throw new Error(`Signed public upload failed: HTTP ${upload.status} ${detail}`);
  }
  const head = await internal.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  if (Number(head.ContentLength) !== body.length || head.Metadata?.['upload-token'] !== metadata['upload-token']) throw new Error('Internal metadata verification failed');
  const read = await internal.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!Buffer.from(await read.Body.transformToByteArray()).equals(body)) throw new Error('Internal readback failed');
  await denied(() => internal.send(new ListObjectsV2Command({ Bucket: bucket })), 'Bucket listing');
  await denied(() => internal.send(new PutObjectCommand({ Bucket: bucket, Key: `forbidden/${crypto.randomUUID()}`, Body: body })), 'Out-of-prefix write');
  const expired = await getSignedUrl(external, originBound(new PutObjectCommand({ Bucket: bucket, Key: `quarantine/expired-${crypto.randomUUID()}`,
    Body: body, ContentLength: body.length, ContentType: 'application/octet-stream', Metadata: metadata })), { expiresIn: 1,
      unhoistableHeaders: new Set(['x-amz-meta-upload-token']) });
  await new Promise(resolve => setTimeout(resolve, 2100));
  const late = await fetch(expired, { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/octet-stream', 'x-amz-meta-upload-token': metadata['upload-token'] }, body });
  if (late.status !== 403) throw new Error(`Expired signature was not rejected: HTTP ${late.status}`);
  await internal.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  console.log('PASS: public HTTPS signed PUT, exact-origin CORS, private readback, scoped IAM, expired signature, and cleanup.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
