#!/usr/bin/env node
'use strict';

const {
  S3Client, CreateBucketCommand, HeadBucketCommand, PutBucketCorsCommand,
  PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const { SignatureV4 } = require('@smithy/signature-v4');
const { HttpRequest } = require('@smithy/protocol-http');
const { Sha256 } = require('@aws-crypto/sha256-js');

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required setting: ${name}`);
  return value;
}

const endpoint = new URL(required('RUSTFS_ADMIN_ENDPOINT'));
const region = required('FIGURINE_PRIVATE_S3_REGION');
const bucket = required('FIGURINE_PRIVATE_S3_BUCKET');
const admin = { accessKeyId: required('RUSTFS_ACCESS_KEY'), secretAccessKey: required('RUSTFS_SECRET_KEY') };
const service = { accessKeyId: required('FIGURINE_PRIVATE_S3_ACCESS_KEY_ID'), secretAccessKey: required('FIGURINE_PRIVATE_S3_SECRET_ACCESS_KEY') };
const customerOrigin = required('CUSTOMER_PUBLIC_ORIGIN');
if (!/^https:\/\/[^/]+$/.test(customerOrigin)) throw new Error('CUSTOMER_PUBLIC_ORIGIN must be an HTTPS origin');
if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('Invalid bucket name');

const signer = new SignatureV4({ service: 's3', region, credentials: admin, sha256: Sha256 });

async function adminRequest(method, pathname, body) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const requestUrl = new URL(pathname, endpoint);
  const query = {};
  for (const [key, value] of requestUrl.searchParams) (query[key] ||= []).push(value);
  const request = new HttpRequest({ protocol: endpoint.protocol, hostname: endpoint.hostname,
    port: endpoint.port ? Number(endpoint.port) : undefined, method, path: requestUrl.pathname, query,
    headers: { host: endpoint.host, ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}) }, body: payload });
  const signed = await signer.sign(request);
  const target = new URL(signed.path, endpoint);
  for (const [key, values] of Object.entries(signed.query || {})) for (const value of values) target.searchParams.append(key, value);
  const response = await fetch(target, { method, headers: signed.headers, body: payload });
  if (!response.ok) throw new Error(`Object-storage admin request failed: ${method} ${pathname.split('?')[0]} HTTP ${response.status}`);
}

async function ensureBucket(client) {
  try { await client.send(new HeadBucketCommand({ Bucket: bucket })); }
  catch (error) {
    if (error?.$metadata?.httpStatusCode !== 404 && error?.name !== 'NotFound' && error?.name !== 'NoSuchBucket') throw error;
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  await client.send(new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: { CORSRules: [{
    AllowedOrigins: [customerOrigin], AllowedMethods: ['PUT'],
    AllowedHeaders: ['content-type', 'x-amz-meta-upload-token'], ExposeHeaders: ['etag'], MaxAgeSeconds: 300,
  }] } }));
}

async function main() {
  const rootClient = new S3Client({ endpoint: endpoint.href, region, forcePathStyle: true, credentials: admin });
  await ensureBucket(rootClient);
  const policyName = 'toptan3dcim-figurine-private-objects';
  const policy = { Version: '2012-10-17', Statement: [
    { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: [
      `arn:aws:s3:::${bucket}/quarantine/*`, `arn:aws:s3:::${bucket}/assets/*`,
    ] },
  ] };
  await adminRequest('PUT', `/rustfs/admin/v3/add-canned-policy?name=${encodeURIComponent(policyName)}`, policy);
  await adminRequest('PUT', `/rustfs/admin/v3/add-user?accessKey=${encodeURIComponent(service.accessKeyId)}`,
    { secretKey: service.secretAccessKey, status: 'enabled' });
  await adminRequest('POST', '/rustfs/admin/v3/idp/builtin/policy/attach', { policies: [policyName], user: service.accessKeyId });

  const limited = new S3Client({ endpoint: endpoint.href, region, forcePathStyle: true, credentials: service });
  const key = `quarantine/setup-${Date.now()}`;
  await limited.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.from('synthetic-storage-check'), ContentType: 'application/octet-stream' }));
  const read = await limited.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (Buffer.from(await read.Body.transformToByteArray()).toString() !== 'synthetic-storage-check') throw new Error('Limited storage readback failed');
  await limited.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  console.log('Private object bucket, exact-origin CORS, and bucket-scoped service access verified.');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
