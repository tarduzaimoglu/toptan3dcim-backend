import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const privateRoot = path.resolve(process.cwd(), '.tmp/private-figurines');
const driver = () => process.env.FIGURINE_STORAGE_DRIVER || 's3';
function client(publicRequest = false) {
  const { FIGURINE_PRIVATE_S3_ENDPOINT: endpoint, FIGURINE_PRIVATE_S3_BUCKET: bucket,
    FIGURINE_PRIVATE_S3_INTERNAL_ENDPOINT: internalEndpoint,
    FIGURINE_PRIVATE_S3_REGION: region, FIGURINE_PRIVATE_S3_ACCESS_KEY_ID: accessKeyId,
    FIGURINE_PRIVATE_S3_SECRET_ACCESS_KEY: secretAccessKey } = process.env;
  if (!endpoint || !bucket || !region || !accessKeyId || !secretAccessKey) throw new Error('Private figurine object storage is not configured');
  return { bucket, client: new S3Client({ endpoint: publicRequest ? endpoint : internalEndpoint || endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } }) };
}
const localPath = (key: string) => {
  if (!/^[a-z0-9/_.-]{1,180}$/.test(key) || key.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid private object key');
  const result = path.resolve(privateRoot, key);
  if (!result.startsWith(privateRoot + path.sep)) throw new Error('Invalid private object key');
  return result;
}
export default {
  isLocal() { return driver() === 'local'; },
  isReady() {
    if (driver() === 'local') return process.env.NODE_ENV !== 'production';
    if (driver() !== 's3') return false;
    return ['FIGURINE_PRIVATE_S3_ENDPOINT', 'FIGURINE_PRIVATE_S3_BUCKET', 'FIGURINE_PRIVATE_S3_REGION', 'FIGURINE_PRIVATE_S3_ACCESS_KEY_ID', 'FIGURINE_PRIVATE_S3_SECRET_ACCESS_KEY']
      .every(name => Boolean(process.env[name]?.trim()));
  },
  limits() {
    const fileBytes = Number(process.env.FIGURINE_MAX_FILE_BYTES || 10 * 1024 * 1024);
    const files = Number(process.env.FIGURINE_MAX_FILES || 10);
    const totalBytes = Number(process.env.FIGURINE_MAX_TOTAL_BYTES || 50 * 1024 * 1024);
    const maxPixels = Number(process.env.FIGURINE_MAX_PIXELS || 40000000);
    if (![fileBytes, files, totalBytes, maxPixels].every(Number.isSafeInteger) || fileBytes < 1024 || fileBytes > 50 * 1024 * 1024 || files < 1 || files > 20 || totalBytes < fileBytes || totalBytes > 200 * 1024 * 1024 || maxPixels < 1 || maxPixels > 100000000) throw new Error('Invalid private image limits');
    return { fileBytes, files, totalBytes, maxPixels };
  },
  async signPut(key: string, contentType: string, size: number, token: string) {
    if (this.isLocal()) {
      if (process.env.NODE_ENV === 'production') throw new Error('Local private storage is forbidden in production');
      await fs.mkdir(path.dirname(localPath(key)), { recursive: true, mode: 0o700 });
      return { url: `/api/figurine/private-upload`, method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'x-local-upload-token': token }, expiresIn: 300, local: true };
    }
    // The hostname is part of the SigV4 signature. Sign with the public HTTPS
    // endpoint customers can reach, while server-side reads can stay private.
    const { bucket, client: s3 } = client(true);
    const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: 'application/octet-stream', ContentLength: size, Metadata: { 'upload-token': token } }), { expiresIn: 300 });
    return { url, method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'x-amz-meta-upload-token': token }, expiresIn: 300, local: false };
  },
  async verifyLocalPut(keyEncoded: string, token: string, signature: string, bytes: Buffer) {
    if (!this.isLocal() || process.env.NODE_ENV === 'production') throw new Error('Local upload is disabled');
    const key = Buffer.from(keyEncoded, 'base64url').toString();
    const expected = crypto.createHmac('sha256', process.env.CUSTOMER_BFF_SECRET || '').update(`put:${keyEncoded}:${token}`).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) throw new Error('Invalid local upload signature');
    await fs.writeFile(localPath(key), bytes, { mode: 0o600 });
    return key;
  },
  async read(key: string) {
    if (this.isLocal()) return fs.readFile(localPath(key));
    const { bucket, client: s3 } = client();
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!response.Body) throw new Error('Private object is empty');
    return Buffer.from(await response.Body.transformToByteArray());
  },
  async put(key: string, body: Buffer) {
    if (this.isLocal()) { await fs.mkdir(path.dirname(localPath(key)), { recursive: true, mode: 0o700 }); await fs.writeFile(localPath(key), body, { mode: 0o600 }); return; }
    const { bucket, client: s3 } = client();
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentLength: body.length, ContentType: 'image/webp', CacheControl: 'private, no-store' }));
  },
  async head(key: string) {
    if (this.isLocal()) return { size: (await fs.stat(localPath(key))).size };
    const { bucket, client: s3 } = client();
    const result = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { size: Number(result.ContentLength || 0), metadata: result.Metadata || {} };
  },
  async delete(key: string) {
    try {
      if (this.isLocal()) await fs.unlink(localPath(key));
      else { const { bucket, client: s3 } = client(); await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); }
    } catch (e: any) { if (e?.code !== 'ENOENT' && e?.name !== 'NoSuchKey' && e?.$metadata?.httpStatusCode !== 404) throw e; }
  },
};
