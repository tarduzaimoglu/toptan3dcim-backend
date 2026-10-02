import crypto from 'node:crypto';

export class CustomerError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const randomToken = () => crypto.randomBytes(32).toString('base64url');
export const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export function equal(a: string, b: string) {
  const x = Buffer.from(a || ''); const y = Buffer.from(b || '');
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}
export function encryptionKey() {
  const key = Buffer.from(process.env.CUSTOMER_TOKEN_ENCRYPTION_KEY || '', 'base64');
  if (key.length !== 32) throw new Error('CUSTOMER_TOKEN_ENCRYPTION_KEY must contain 32 base64-encoded bytes');
  return key;
}
export function seal(value: unknown) {
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(x => x.toString('base64url')).join('.');
}
export function open(value: string): any {
  const [iv, tag, ciphertext] = value.split('.').map(x => Buffer.from(x, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv); decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
}
export const iso = (ms = Date.now()) => new Date(ms).toISOString();
export function fields(body: any, allowed: string[]) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k))) {
    throw new CustomerError(400, 'Gönderilen alanlar geçersiz.');
  }
}
export function text(value: unknown, max: number, required = false) {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw new CustomerError(400, 'Alanları kontrol edin.');
  return value.trim();
}
export function email(value: unknown) {
  const v = text(value, 254, true).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new CustomerError(400, 'Geçerli bir e-posta adresi girin.');
  return v;
}
export function password(value: unknown) {
  // bcrypt truncates at 72 bytes: reject, never silently truncate.
  if (typeof value !== 'string' || value.length < 12 || Buffer.byteLength(value) > 72) throw new CustomerError(400, 'Şifre en az 12 karakter, en fazla 72 bayt olmalı.');
  return value;
}
export function phone(value: unknown) {
  const v = text(value ?? '', 30);
  if (v && !/^[+0-9()\s-]{7,30}$/.test(v)) throw new CustomerError(400, 'Geçerli bir telefon numarası girin.');
  return v;
}
