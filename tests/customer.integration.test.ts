import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { XMLParser } from 'fast-xml-parser';
import { csrfTicket, validCsrf, validOrigin, safeReturn } from '../../toptan3dcim-frontend/lib/server/account-security';
import { seal, open, digest } from '../src/customer/security';
import { commerceTests } from './commerce.integration.test';

async function main() {
  console.log('Initializing isolated customer integration environment');
  const runId = crypto.randomBytes(6).toString('hex');
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_CLIENT: 'sqlite', DATABASE_URL: '', DATABASE_FILENAME: `.tmp/customer-test-${runId}.db`,
    HOST: '127.0.0.1', PORT: '0', APP_KEYS: crypto.randomBytes(32).toString('hex'), JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    ADMIN_JWT_SECRET: crypto.randomBytes(32).toString('hex'), API_TOKEN_SALT: crypto.randomBytes(32).toString('hex'), TRANSFER_TOKEN_SALT: crypto.randomBytes(32).toString('hex'), ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    CUSTOMER_ACCOUNTS_ENABLED: 'true', CUSTOMER_SCHEMA_SETUP: 'true', FIGURINE_REQUESTS_ENABLED: 'true', FIGURINE_STORAGE_DRIVER: 'local', FIGURINE_MAIL_MODE: 'file', FIGURINE_ADMIN_ROLE_NAMES: 'Super Admin', FIGURINE_REVIEW_ROLE_NAMES: 'Super Admin', FIGURINE_QUOTE_ROLE_NAMES: 'Super Admin', FIGURINE_OPERATIONS_ROLE_NAMES: 'Super Admin', FIGURINE_PHOTO_ROLE_NAMES: 'Super Admin', CUSTOMER_BFF_SECRET: crypto.randomBytes(32).toString('hex'),
    CUSTOMER_TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), CUSTOMER_PUBLIC_ORIGIN: 'http://localhost:3210', CUSTOMER_MAIL_MODE: 'file', STRAPI_TELEMETRY_DISABLED: 'true' });
  if (process.argv.includes('--postgres')) {
    const connection = new URL(process.env.CUSTOMER_TEST_POSTGRES_URL || '');
    if (!['127.0.0.1','localhost','[::1]'].includes(connection.hostname) || !/^\/customer_test_[a-z0-9_]+$/.test(connection.pathname)) throw new Error('PostgreSQL tests require a dedicated localhost customer_test_* database');
    process.env.DATABASE_CLIENT = 'postgres'; process.env.DATABASE_URL = connection.href;
  }
  console.log(`Test database: ${process.env.DATABASE_CLIENT === 'postgres' ? 'dedicated localhost PostgreSQL customer_test_* database' : process.env.DATABASE_FILENAME}`);
  const { compileStrapi, createStrapi } = require('@strapi/strapi');
  console.log('Compiling local Strapi sources');
  const app = createStrapi(await compileStrapi());
  let passed = 0;
  async function test(name: string, fn: () => Promise<void> | void) { await fn(); passed++; console.log(`PASS ${passed}: ${name}`); }
  try {
    console.log('Loading local Strapi with isolated database');
    try { await app.load(); } catch (error) { console.error('Strapi load failed:', error instanceof Error ? error.stack : error); throw error; }
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${app.server.httpServer.address().port}`;
    process.env.BACKEND_URL = origin;
    const query = (name: string) => app.db.query(`api::customer-${name}.customer-${name}`);
    const users = () => app.db.query('plugin::users-permissions.user');
    const service = app.service('api::customer.customer');
    const originalDispatch = service.dispatch;
    service.dispatch = async (...args: any[]) => {
      try { return await originalDispatch(...args); }
      catch (e: any) {
        if (e.constructor.name !== 'CustomerError') console.error('Test diagnostic:', e.constructor.name, e.code || '', e.message?.split(' - ').at(-1), e.stack?.split('\n').slice(1).join('\n'));
        throw e;
      }
    };
    let counter = 0;
    let figurineRequestId = '';
    async function request(operation: string, data: any = {}, session = '', client = `test-${++counter}`) {
      const response = await fetch(`${origin}/api/customer/dispatch`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-customer-bff-key': process.env.CUSTOMER_BFF_SECRET!, 'x-customer-session': session, 'x-customer-client': client }, body: JSON.stringify({ operation, data }) });
      return { status: response.status, body: await response.json() as any };
    }
    async function link(address: string, purpose: string) {
      const jobs = await query('mail').findMany({ where: { recipient: address }, orderBy: { id: 'desc' } });
      const mail = JSON.parse(await fs.readFile(path.join(process.cwd(), '.tmp/customer-mail', `${jobs[0].id}.json`), 'utf8'));
      const found = mail.text.match(/http[^\s]+/)[0];
      assert.equal(new URL(found).pathname, purpose === 'reset' ? '/hesap/sifre-sifirla' : '/hesap/dogrula');
      return new URLSearchParams(new URL(found).hash.slice(1)).get('token')!;
    }
    const alice = `alice-${runId}@example.test`, bob = `bob-${runId}@example.test`, pass = 'Local test password 123!';
    let aToken = '', bToken = '', aliceUser: any, bobUser: any, addressId = '', orderId = '';
    await test('Registration, confirmation required, one-use verification, login, encrypted persisted session', async () => {
      assert.equal((await request('register', { email: alice, password: pass, fullName: 'Alice Test' })).status, 200);
      assert.equal((await request('login', { email: alice, password: pass })).status, 403);
      const token = await link(alice, 'verify');
      assert.equal((await request('verify', { token })).status, 200);
      assert.equal((await request('verify', { token })).status, 400);
      const login = await request('login', { email: alice, password: pass }); assert.equal(login.status, 200); aToken = login.body.sessionToken;
      aliceUser = await users().findOne({ where: { email: alice } });
      const s = await query('session').findOne({ where: { tokenHash: digest(aToken) } });
      assert.ok(!s.encryptedTokens.includes('eyJ')); assert.ok(!s.encryptedTokens.includes(aToken)); assert.equal(open(s.encryptedTokens).refresh.split('.').length, 3);
      assert.deepEqual(Object.keys((await request('me', {}, aToken)).body.user).sort(), ['email', 'fullName', 'phone']);
    });
    await test('Second account and expiring verification/resend', async () => {
      assert.equal((await request('register', { email: bob, password: pass, fullName: 'Bob Test' })).status, 200);
      const expired = await link(bob, 'verify');
      await query('action').update({ where: { tokenHash: digest(expired) }, data: { expiresAt: new Date(Date.now() - 1000).toISOString() } });
      assert.equal((await request('verify', { token: expired })).status, 400);
      assert.equal((await request('resend', { email: bob })).status, 200);
      assert.equal((await request('verify', { token: await link(bob, 'verify') })).status, 200);
      bToken = (await request('login', { email: bob, password: pass })).body.sessionToken;
      bobUser = await users().findOne({ where: { email: bob } });
    });
    const address = { label: 'Ev', fullName: 'Alice Test', phone: '', city: 'İstanbul', district: 'Kadıköy', addressLine: 'Test adresi 1', postalCode: '', defaultShipping: true, defaultBilling: false };
    await test('Address CRUD, separate defaults, owner and protected field manipulation', async () => {
      const saved = await request('address-save', { address }, aToken); assert.equal(saved.status, 200); addressId = saved.body.address.documentId; assert.ok(addressId);
      const second = await request('address-save', { address: { ...address, label: 'İş', defaultBilling: true } }, aToken); assert.equal(second.status, 200);
      const list = (await request('addresses', {}, aToken)).body.addresses;
      assert.equal(list.filter(a => a.defaultShipping).length, 1); assert.equal(list.filter(a => a.defaultBilling).length, 1);
      assert.equal((await request('address-delete', { id: second.body.address.documentId }, aToken)).status, 200);
      assert.equal((await request('address-delete', { id: second.body.address.documentId }, aToken)).status, 404);
      assert.equal((await request('addresses', {}, bToken)).body.addresses.length, 0);
      assert.equal((await request('address-save', { id: addressId, address }, bToken)).status, 404);
      assert.equal((await request('address-delete', { id: addressId }, bToken)).status, 404);
      assert.equal((await request('address-save', { address: { ...address, owner: bobUser.id } }, aToken)).status, 400);
      assert.equal((await request('profile', { fullName: 'Alice', phone: '', role: 1, confirmed: true, userId: bobUser.id }, aToken)).status, 400);
      assert.equal((await request('profile', { fullName: 'Alice Updated', phone: '+90 555 123 4567' }, aToken)).status, 200);
    });
    await test('Read-only owned orders, guest isolation, field allowlist and immutable snapshots', async () => {
      const data = { orderNumber: `TEST-${runId}`, status: 'paid', user: aliceUser.id, items: [{ isim: 'Test ürün', adet: 2, birimFiyat: 1000, satirToplami: 2000, internalCost: 9 }], subtotal: 2000, grandTotal: 2000, buyerName: 'Original name', buyerEmail: alice, buyerPhone: '5551234567', shippingAddress: { city: 'İstanbul', district: 'Kadıköy', addressLine: 'Original address', secret: 'private' }, contractAccepted: true, bankResponseRaw: { secret: 'private' }, authCode: 'secret' };
      const order = await app.documents('api::order.order').create({ data }); orderId = order.documentId;
      await app.documents('api::order.order').create({ data: { ...data, orderNumber: `GUEST-${runId}`, user: null } });
      assert.equal((await request('orders', {}, aToken)).body.orders.length, 1);
      assert.equal((await request('order', { id: orderId }, bToken)).status, 404);
      assert.equal((await request('orders', { userId: aliceUser.id }, bToken)).status, 400);
      const detail = (await request('order', { id: orderId }, aToken)).body.order;
      assert.ok(!JSON.stringify(detail).includes('private')); assert.ok(!('authCode' in detail)); assert.ok(!('internalCost' in detail.items[0]));
      await request('address-save', { id: addressId, address: { ...address, addressLine: 'Changed profile address' } }, aToken);
      assert.equal((await request('order', { id: orderId }, aToken)).body.order.shippingAddress.addressLine, 'Original address');
      assert.equal((await request('order-update', { id: orderId, status: 'paid' }, aToken)).status, 404);
    });
    await test('Parallel refresh uses one DB lock and a single new refresh token', async () => {
      const s = await query('session').findOne({ where: { tokenHash: digest(aToken) } });
      const before = open(s.encryptedTokens).refresh;
      await query('session').update({ where: { id: s.id }, data: { accessExpiresAt: new Date(Date.now() - 1000).toISOString() } });
      const results = await Promise.all(Array.from({ length: 5 }, () => request('me', {}, aToken)));
      assert.deepEqual(results.map(r => r.status), [200, 200, 200, 200, 200]);
      const after = open((await query('session').findOne({ where: { id: s.id } })).encryptedTokens).refresh;
      assert.notEqual(after, before);
      const old = await app.sessionManager('users-permissions').validateRefreshToken(before); assert.equal(old.isValid, false);
    });
    await commerceTests({ app, request, test, aliceUser, bobUser, aToken, bToken, addressId });
    await test('Forgot-password generic response; reset invalid/expired/reuse; old sessions revoked', async () => {
      const unknown = await request('forgot', { email: `unknown-${runId}@example.test` });
      const known = await request('forgot', { email: alice }); assert.deepEqual(known, unknown);
      const expired = await link(alice, 'reset');
      await query('action').update({ where: { tokenHash: digest(expired) }, data: { expiresAt: new Date(Date.now() - 1000).toISOString() } });
      assert.equal((await request('reset', { token: expired, password: pass })).status, 400);
      assert.equal((await request('reset', { token: 'invalid', password: pass })).status, 400);
      await request('forgot', { email: alice }); const token = await link(alice, 'reset');
      const nextPass = 'New local password 456!'; assert.equal((await request('reset', { token, password: nextPass })).status, 200);
      assert.equal((await request('reset', { token, password: nextPass })).status, 400);
      assert.equal((await request('me', {}, aToken)).status, 401);
      assert.equal((await request('login', { email: alice, password: pass })).status, 401);
      aToken = (await request('login', { email: alice, password: nextPass })).body.sessionToken;
    });
    await test('Email change requires password, keeps old email until confirmation and revokes sessions', async () => {
      const next = `new-${runId}@example.test`;
      assert.equal((await request('email-change', { email: next, password: 'wrong' }, aToken)).status, 400);
      assert.equal((await request('email-change', { email: next, password: 'New local password 456!' }, aToken)).status, 200);
      assert.equal((await request('me', {}, aToken)).body.user.email, alice);
      const token = await link(next, 'verify'); assert.equal((await request('verify', { token })).status, 200);
      assert.equal((await request('me', {}, aToken)).status, 401);
      assert.equal((await request('verify', { token })).status, 400);
      aToken = (await request('login', { email: next, password: 'New local password 456!' })).body.sessionToken;
    });
    await test('Expired sessions, blocked account invalidation, logout', async () => {
      await users().update({ where: { id: bobUser.id }, data: { blocked: true } });
      assert.equal(await query('session').count({ where: { tokenHash: digest(bToken) } }), 0, 'block proactively revokes sessions');
      assert.equal((await request('me', {}, bToken)).status, 401);
      await users().update({ where: { id: bobUser.id }, data: { blocked: false } });
      assert.equal((await request('me', {}, bToken)).status, 401);
      bToken = (await request('login', { email: bob, password: pass })).body.sessionToken;
      await query('session').update({ where: { tokenHash: digest(bToken) }, data: { idleExpiresAt: new Date(Date.now() - 1).toISOString() } });
      assert.equal((await request('me', {}, bToken)).status, 401);
      bToken = (await request('login', { email: bob, password: pass })).body.sessionToken;
      await query('session').update({ where: { tokenHash: digest(bToken) }, data: { expiresAt: new Date(Date.now() - 1).toISOString() } });
      assert.equal((await request('me', {}, bToken)).status, 401);
      assert.equal((await request('logout', {}, aToken)).status, 200);
      assert.equal((await request('me', {}, aToken)).status, 401);
    });
    await test('Generic CRUD/auth boundary cannot be bypassed by permissions or a BFF key', async () => {
      const publicRole = await app.db.query('plugin::users-permissions.role').findOne({ where: { type: 'public' } });
      for (const action of ['api::order.order.find', 'api::order.order.update', 'plugin::users-permissions.user.find']) {
        await app.db.query('plugin::users-permissions.permission').create({ data: { role: publicRole.id, action } });
      }
      for (const endpoint of ['/api/orders', `/api/orders/${orderId}`, '/api/users', '/api/auth/local', '/api/customer-addresses', '/api/customer-sessions', '/api/figurine-packages', '/api/figurine-requests', '/api/figurine-private-assets', '/api/figurine-upload-sessions']) {
        const r = await fetch(origin + endpoint, { headers: { 'x-customer-bff-key': process.env.CUSTOMER_BFF_SECRET! } }); assert.equal(r.status, 404, endpoint);
      }
      const noKey = await fetch(origin + '/api/customer/dispatch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'me', data: {} }) }); assert.equal(noKey.status, 404);
    });
    await test('Shared DB rate limit and idempotent setup preserve existing orders', async () => {
      const results = [];
      for (let i = 0; i < 10; i++) results.push(await request('verify', { token: 'invalid' }, '', 'rate-test'));
      assert.equal(results[8].status, 429);
      const before = await app.db.query('api::order.order').findOne({ where: { documentId: orderId } });
      await service.setup(); await service.setup();
      await app.db.schema.sync(); await service.setup();
      const after = await app.db.query('api::order.order').findOne({ where: { documentId: orderId } }); assert.deepEqual(after, before);
    });
    await test('CSRF origin, signature, expiry, session binding and restricted redirects', () => {
      const secret = process.env.CUSTOMER_BFF_SECRET!;
      const ticket = csrfTicket(secret, 'session', 1000);
      assert.ok(validCsrf(ticket, ticket, secret, 'session', 1001));
      assert.ok(!validCsrf(ticket, '', secret, 'session', 1001)); assert.ok(!validCsrf(ticket, ticket, secret, 'other', 1001));
      assert.ok(!validCsrf(ticket, ticket, secret, 'session', 3601001)); assert.ok(!validCsrf(ticket + 'x', ticket + 'x', secret, 'session', 1001));
      assert.ok(!validOrigin('https://evil.test', 'http://localhost:3210', 'same-origin'));
      assert.ok(!validOrigin('http://localhost:3210', 'http://localhost:3210', 'cross-site'));
      for (const target of ['https://evil.test', '//evil.test', '/\\evil.test', '/hesap/../evil', '/hesap?next=https://evil.test']) assert.equal(safeReturn(target), '/hesap');
      assert.equal(safeReturn('/hesap/adresler'), '/hesap/adresler');
      const sealed = seal({ token: 'secret' }); assert.deepEqual(open(sealed), { token: 'secret' }); assert.throws(() => open(sealed.slice(0, -3) + 'xxx'));
    });
    await test('Missing SMTP is not treated as success', async () => {
      process.env.CUSTOMER_MAIL_MODE = 'smtp';
      assert.equal((await request('forgot', { email: bob })).status, 503);
      assert.equal((await request('forgot', { email: 'unknown@example.test' })).status, 503);
      process.env.CUSTOMER_MAIL_MODE = 'file';
    });
    await test('Registration flags and role injection cannot create privileged customers', async () => {
      const malicious = `malicious-${runId}@example.test`;
      assert.equal((await request('register', { email: malicious, password: pass, fullName: 'Test', role: 1, confirmed: true })).status, 400);
      assert.equal(await users().findOne({ where: { email: malicious } }), null);
      const store = app.store({ type: 'plugin', name: 'users-permissions', key: 'advanced' });
      const original = await store.get(); await store.set({ value: { ...original, allow_register: false } });
      assert.equal((await request('register', { email: malicious, password: pass, fullName: 'Test' })).status, 403);
      await store.set({ value: original });
    });
    await test('Mail retry keeps a durable encrypted payload and purges expired security records', async () => {
      const job = await query('mail').create({ data: { recipient: 'retry@example.test', encryptedPayload: seal({ subject: 'Local retry test', text: 'Controlled local test mail' }), status: 'failed', attempts: 1, expiresAt: new Date(Date.now() + 60000).toISOString() } });
      await service.flushMail();
      const delivered = await query('mail').findOne({ where: { id: job.id } });
      assert.equal(delivered.status, 'sent'); assert.equal(delivered.encryptedPayload, null); assert.equal(delivered.attempts, 2);
      await query('mail').update({ where: { id: job.id }, data: { expiresAt: new Date(Date.now() - 1000).toISOString() } });
      await service.cleanup(); assert.equal(await query('mail').findOne({ where: { id: job.id } }), null);
    });
    await test('Private figurine request upload, ownership, validation, idempotency and durable outbox', async () => {
      process.env.FIGURINE_STORAGE_DRIVER = 'local'; process.env.BACKEND_URL = origin;
      aliceUser = await users().findOne({ where: { id: aliceUser.id } });
      aToken = (await request('login', { email: aliceUser.email, password: 'New local password 456!' })).body.sessionToken;
      bToken = (await request('login', { email: bob, password: pass })).body.sessionToken;
      const settingsUid = 'api::figurine-settings.figurine-settings';
      const existingSettings = await app.documents(settingsUid).findFirst();
      if (existingSettings) await app.documents(settingsUid).update({ documentId: existingSettings.documentId, data: { privacyNotice: 'Local test privacy notice.', privacyVersion: `test-${runId}`, priceScopeNote: 'Başlangıç fiyatı.', customerContactNote: 'Talep sonrası netleştirilir.' } });
      else await app.documents(settingsUid).create({ data: { privacyNotice: 'Local test privacy notice.', privacyVersion: `test-${runId}`, priceScopeNote: 'Başlangıç fiyatı.', customerContactNote: 'Talep sonrası netleştirilir.' } });
      await service.setupFigurinePackages();
      const packages = await request('figurine-packages');
      assert.equal(packages.status, 200); assert.equal(packages.body.packages.find((p: any) => p.key === 'color-one-character').startingPrice, 2000);
      assert.equal(packages.body.submissionEnabled, true, 'test fixture has active requests, private local storage and versioned test notice');
      process.env.FIGURINE_STORAGE_DRIVER = 'unconfigured-test-driver';
      assert.equal((await request('figurine-packages')).body.submissionEnabled, false, 'unknown storage driver fails closed');
      process.env.FIGURINE_STORAGE_DRIVER = 'local';
      assert.equal(packages.body.packages.find((p: any) => p.key === 'monochrome-one-character').startingPrice, null);
      const selected = packages.body.packages.find((p: any) => p.key === 'color-one-character');
      const bytes = await require('sharp')({ create: { width: 8, height: 8, channels: 3, background: '#cc3366' } }).png().toBuffer();
      const fileKey = crypto.randomUUID();
      const payload = { style: 'color', people: [{ id: 'person-one', kind: 'person', description: 'test', outfit: 'blue', pose: 'standing', hair: 'short', accessories: '', fileKeys: [fileKey] }], base: '', plinthText: '', note: 'local request', contactPreference: 'email', phone: '', fullName: 'Alice Test', consent: true, privacyVersion: `test-${runId}`, declaredFileKeys: [fileKey] };
      assert.equal((await request('figurine-draft', { packageId: selected.id, payload }, aToken)).status, 200);
      assert.equal((await request('figurine-upload-sign', { fileKey, name: 'portrait.png', mime: 'image/png', size: bytes.length }, bToken)).status, 409);
      const signed = await request('figurine-upload-sign', { fileKey, name: 'portrait.png', mime: 'image/png', size: bytes.length }, aToken);
      assert.equal(signed.status, 200);
      let put: Response;
      try { put = await fetch(signed.body.uploadUrl, { method: 'PUT', body: bytes, headers: signed.body.headers }); }
      catch (error: any) { console.error('Local private upload transport failed:', new URL(signed.body.uploadUrl).origin, error.cause?.code || error.cause?.message || error.message); throw error; }
      assert.equal(put.status, 200);
      assert.equal((await request('figurine-upload-complete', { uploadSessionId: signed.body.uploadSessionId }, bToken)).status, 404);
      const completed = await request('figurine-upload-complete', { uploadSessionId: signed.body.uploadSessionId }, aToken); assert.equal(completed.status, 200, JSON.stringify(completed.body));
      assert.equal((await request('figurine-upload-complete', { uploadSessionId: signed.body.uploadSessionId }, aToken)).status, 200, 'complete retry is idempotent');
      assert.equal((await request('figurine-submit', { requestKey: 'not-a-valid-request-key', packageId: selected.id, payload }, aToken)).status, 400);
      assert.equal((await request('figurine-submit', { requestKey: crypto.randomBytes(20).toString('base64url'), packageId: selected.id, payload: { ...payload, userId: bobUser.id } }, bToken)).status, 409);
      const requestKey = crypto.randomBytes(24).toString('base64url');
      const submitted = await request('figurine-submit', { requestKey, packageId: selected.id, payload }, aToken);
      figurineRequestId = submitted.body.requestId;
      assert.equal(submitted.status, 200, JSON.stringify(submitted.body)); assert.equal(submitted.body.status, 'Talep alındı');
      const repeated = await request('figurine-submit', { requestKey, packageId: selected.id, payload }, aToken);
      assert.equal(repeated.status, 200); assert.equal(repeated.body.requestId, submitted.body.requestId);
      assert.equal((await request('figurine-requests', {}, bToken)).body.requests.length, 0);
      assert.equal((await request('figurine-request', { id: submitted.body.requestId }, bToken)).status, 404);
      const detail = await request('figurine-request', { id: submitted.body.requestId }, aToken); assert.equal(detail.status, 200); assert.equal(detail.body.photos.length, 1);
      const photoUrl = `${origin}/api/customer/figurine-photo/${submitted.body.requestId}/${detail.body.photos[0].id}`;
      const photo = await fetch(photoUrl, { headers: { 'x-customer-bff-key': process.env.CUSTOMER_BFF_SECRET!, 'x-customer-session': aToken } }); assert.equal(photo.status, 200); assert.match(photo.headers.get('content-type') || '', /image\/webp/);
      const otherPhoto = await fetch(photoUrl, { headers: { 'x-customer-bff-key': process.env.CUSTOMER_BFF_SECRET!, 'x-customer-session': bToken } }); assert.equal(otherPhoto.status, 404);
      const guessedPublicPath = await fetch(`${origin}/uploads/${encodeURIComponent(fileKey)}`); assert.notEqual(guessedPublicPath.status, 200);
      const requestRows = await app.db.query('api::figurine-request.figurine-request').findMany({ where: { requestKey } }); assert.equal(requestRows.length, 1);
      const outboxQuery = app.db.query('api::figurine-outbox.figurine-outbox');
      const outbox = await outboxQuery.findOne({ where: { request: { id: requestRows[0].id } } }); assert.ok(outbox); assert.notEqual(outbox.encryptedPayload, '');
      process.env.FIGURINE_MAIL_MODE = 'smtp'; process.env.CUSTOMER_SMTP_HOST = '127.0.0.1'; process.env.CUSTOMER_SMTP_PORT = '1'; process.env.CUSTOMER_SMTP_USER = ''; process.env.CUSTOMER_SMTP_PASS = '';
      await service.figurineOutbox();
      const failed = await outboxQuery.findOne({ where: { id: outbox.id } }); assert.equal(failed.status, 'failed'); assert.ok(failed.attempts > 0); assert.ok(failed.encryptedPayload);
      process.env.FIGURINE_MAIL_MODE = 'file'; await outboxQuery.update({ where: { id: outbox.id }, data: { nextAttemptAt: new Date(Date.now() - 1000).toISOString() } });
      await service.figurineOutbox(); const delivered = await outboxQuery.findOne({ where: { id: outbox.id } }); assert.equal(delivered.status, 'sent'); assert.equal(delivered.encryptedPayload, '');
      const expired = await app.db.query('api::figurine-upload-session.figurine-upload-session').findOne({ where: { documentId: signed.body.uploadSessionId } }); assert.equal(expired.completedAt != null, true);
      assert.ok(expired.quarantineRemovedAt, 'completed quarantine object has a cleanup receipt');
      const badKey = crypto.randomUUID(), badPayload = { ...payload, declaredFileKeys: [badKey], people: [{ ...payload.people[0], fileKeys: [badKey] }] };
      await request('figurine-draft', { packageId: selected.id, payload: badPayload }, aToken);
      assert.equal((await request('figurine-upload-sign', { fileKey: crypto.randomUUID(), name: 'large.png', mime: 'image/png', size: 10 * 1024 * 1024 + 1 }, aToken)).status, 413);
      const badSigned = await request('figurine-upload-sign', { fileKey: badKey, name: 'fake.png', mime: 'image/png', size: 12 }, aToken);
      const fakePut = await fetch(badSigned.body.uploadUrl, { method: 'PUT', body: Buffer.from('not an image'), headers: badSigned.body.headers }); assert.equal(fakePut.status, 200);
      const fakeSession = await app.db.query('api::figurine-upload-session.figurine-upload-session').findOne({ where: { documentId: badSigned.body.uploadSessionId } });
      const rejected = await request('figurine-upload-complete', { uploadSessionId: badSigned.body.uploadSessionId }, aToken); assert.ok([400, 415].includes(rejected.status));
      await app.db.query('api::figurine-upload-session.figurine-upload-session').update({ where: { id: fakeSession.id }, data: { expiresAt: new Date(Date.now() - 1000).toISOString() } });
      assert.equal((await fetch(badSigned.body.uploadUrl, { method: 'PUT', body: Buffer.from('not an image'), headers: badSigned.body.headers })).status, 404);
      await service.figurineCleanup();
      assert.equal(await app.db.query('api::figurine-upload-session.figurine-upload-session').findOne({ where: { id: fakeSession.id } }), null);
    });
    await test('Figurine offer authorization, versions, expiry, customer approval, supersession and request idempotency', async () => {
      assert.ok(figurineRequestId);
      const role = await app.db.query('admin::role').findOne({ where: { code: 'strapi-super-admin' } });
      const admin = await app.db.query('admin::user').create({ data: { firstname: 'Workflow', lastname: 'Test', email: `workflow-${runId}@example.test`, password: 'unused-test-only', isActive: true, roles: [role.id] } });
      const workflow = app.service('api::customer.customer');
      const requestUid = 'api::figurine-request.figurine-request', offerUid = 'api::figurine-offer.figurine-offer';
      const requestRow = await app.db.query(requestUid).findOne({ where: { documentId: figurineRequestId }, populate: ['owner'] });
      const makeOffer = (designDescription: string) => ({ scope: { characters: 1, pets: 0, colorChoice: 'color', designDescription,
        includedParts: ['Bir özel figür'], sizeDescription: '', standIncluded: null, boxIncluded: null, productionDeliveryNote: '' },
        amountMinor: 123456, taxMinor: 1200, shippingMinor: 600, totalMinor: 125256, currency: 'TRY',
        taxShippingDisclosure: 'Vergi ve kargo tutarları bu teklifte ayrı gösterilmiştir.', customerNote: 'Müşteriye görünen not.', internalNote: 'STAFF_ONLY_COST_987',
        validUntil: new Date(Date.now() + 86400000).toISOString() });
      const invalid = makeOffer('Arithmetik test'); invalid.totalMinor += 1;
      await assert.rejects(() => workflow.figurineAdminSaveOffer(admin, figurineRequestId, invalid, false));
      const draft1 = await workflow.figurineAdminSaveOffer(admin, figurineRequestId, makeOffer('Sürüm bir'), false);
      assert.equal(draft1.state, 'draft');
      const preOfferDetail = await request('figurine-request', { id: figurineRequestId }, aToken);
      assert.equal(preOfferDetail.status, 200); assert.equal(preOfferDetail.body.offers.length, 0, 'draft/internal notes must not be public');
      assert.equal((await request('figurine-request', { id: figurineRequestId }, bToken)).status, 404);
      const forged = await request('figurine-offer-accept', { requestId: figurineRequestId, offerId: draft1.id, totalMinor: 1 }, aToken); assert.equal(forged.status, 400);
      const noAccessRole = await app.db.query('admin::role').create({ data: { name: 'No workflow access', code: `no-workflow-${runId}`, description: 'test only' } });
      const noAccessStaff = await app.db.query('admin::user').create({ data: { firstname: 'No', lastname: 'Access', email: `no-access-${runId}@example.test`, password: 'unused-test-only', isActive: true, roles: [noAccessRole.id] } });
      await assert.rejects(() => workflow.figurineAdminSaveOffer(noAccessStaff, figurineRequestId, makeOffer('Unauthorized'), false));
      const previousQuoteRoles = process.env.FIGURINE_QUOTE_ROLE_NAMES;
      const previousGlobalRoles = process.env.FIGURINE_ADMIN_ROLE_NAMES;
      process.env.FIGURINE_QUOTE_ROLE_NAMES = '';
      process.env.FIGURINE_ADMIN_ROLE_NAMES = '';
      await assert.rejects(() => workflow.figurineAdminSaveOffer(admin, figurineRequestId, makeOffer('Missing role configuration'), false));
      process.env.FIGURINE_QUOTE_ROLE_NAMES = previousQuoteRoles;
      process.env.FIGURINE_ADMIN_ROLE_NAMES = previousGlobalRoles;
      process.env.FIGURINE_QUOTE_ROLE_NAMES = 'No such role';
      await assert.rejects(() => workflow.figurineAdminSaveOffer(admin, figurineRequestId, makeOffer('Wrong role'), false));
      process.env.FIGURINE_QUOTE_ROLE_NAMES = 'Super Admin';
      await workflow.figurineAdminSaveOffer(admin, figurineRequestId, { ...makeOffer('Sürüm bir'), offerId: draft1.id }, true);
      const presented1 = await app.db.query(offerUid).findOne({ where: { documentId: draft1.id, request: { id: requestRow.id } } });
      assert.equal(presented1.state, 'offered');
      const customerView = await request('figurine-request', { id: figurineRequestId }, aToken);
      assert.equal(customerView.body.offers.length, 1); assert.ok(!JSON.stringify(customerView.body).includes('STAFF_ONLY_COST_987'));
      assert.equal((await request('figurine-offer-accept', { requestId: figurineRequestId, offerId: draft1.id }, bToken)).status, 404);
      const draft2 = await workflow.figurineAdminSaveOffer(admin, figurineRequestId, makeOffer('Sürüm iki'), false);
      const race = await Promise.allSettled([
        request('figurine-offer-accept', { requestId: figurineRequestId, offerId: draft1.id }, aToken),
        workflow.figurineAdminSaveOffer(admin, figurineRequestId, { ...makeOffer('Sürüm iki'), offerId: draft2.id }, true),
      ]);
      const second = await app.db.query(offerUid).findOne({ where: { documentId: draft2.id, request: { id: requestRow.id } } });
      if (second.state === 'draft') await workflow.figurineAdminSaveOffer(admin, figurineRequestId, { ...makeOffer('Sürüm iki'), offerId: draft2.id }, true);
      const old = await app.db.query(offerUid).findOne({ where: { documentId: draft1.id } });
      assert.equal(old.state, 'superseded');
      if (old.acceptedAt) assert.ok(old.approvalInvalidatedAt, 'previous approval remains in history but is invalidated');
      assert.equal((await request('figurine-offer-accept', { requestId: figurineRequestId, offerId: draft1.id }, aToken)).status, 409);
      const active2 = await app.db.query(offerUid).findOne({ where: { documentId: draft2.id } });
      await app.db.query(offerUid).update({ where: { id: active2.id }, data: { validUntil: new Date(Date.now() - 1000).toISOString() } });
      assert.equal((await request('figurine-offer-accept', { requestId: figurineRequestId, offerId: draft2.id }, aToken)).status, 409);
      const draft3 = await workflow.figurineAdminSaveOffer(admin, figurineRequestId, makeOffer('Sürüm üç'), false);
      await workflow.figurineAdminSaveOffer(admin, figurineRequestId, { ...makeOffer('Sürüm üç'), offerId: draft3.id }, true);
      const accepted = await request('figurine-offer-accept', { requestId: figurineRequestId, offerId: draft3.id }, aToken);
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body)); assert.equal(accepted.body.state, 'accepted');
      assert.equal((await request('figurine-offer-accept', { requestId: figurineRequestId, offerId: draft3.id }, aToken)).body.repeated, true);
      const requestRows = await app.db.query(requestUid).findMany({ where: { documentId: figurineRequestId } }); assert.equal(requestRows.length, 1);
      const responseRows = await app.db.query('api::figurine-response.figurine-response').findMany({ where: { request: { id: requestRow.id }, kind: 'accepted' } }); assert.equal(responseRows.length, 1);
      assert.ok(race.length === 2);
    });
    await test('Figurine order conversion is quote-backed, address-snapshotted, idempotent, gate-controlled and uses existing mocked Posnet attempts', async () => {
      const workflow = app.service('api::customer.customer'), offers = app.db.query('api::figurine-offer.figurine-offer'), orders = app.db.query('api::order.order');
      const reqRow = await app.db.query('api::figurine-request.figurine-request').findOne({ where: { documentId: figurineRequestId } });
      const accepted = await offers.findOne({ where: { request: { id: reqRow.id }, state: 'accepted' } });
      assert.ok(accepted);
      const input = { requestId: figurineRequestId, offerId: accepted.documentId, shippingAddressId: addressId, billingAddressId: addressId, contractAccepted: true };
      assert.equal((await request('figurine-convert-order', { ...input, grandTotal: 1 }, aToken)).status, 400);
      const [first, parallel] = await Promise.all([request('figurine-convert-order', input, aToken), request('figurine-convert-order', input, aToken)]);
      assert.ok([200, 503].includes(parallel.status) || parallel.status === 200, JSON.stringify(parallel.body));
      assert.equal(first.status, 200, JSON.stringify(first.body));
      const converted = first.body;
      const order = await orders.findOne({ where: { figurineOfferKey: String(accepted.id) }, populate: ['user', 'figurineRequest', 'figurineOffer'] });
      assert.ok(order); assert.equal(order.user.id, aliceUser.id); assert.equal(order.figurineRequest.id, reqRow.id); assert.equal(order.figurineOffer.id, accepted.id);
      assert.equal(order.grandTotal, accepted.totalMinor); assert.equal(order.vatTotal, accepted.taxMinor); assert.equal(order.shippingCost, accepted.shippingMinor);
      assert.equal(order.grandTotal, order.subtotal + order.vatTotal + order.shippingCost, 'quoted total is used directly; catalog tax/shipping is not added');
      assert.deepEqual(order.shippingAddress, order.billingAddress);
      const [again1, again2] = await Promise.all([request('figurine-convert-order', input, aToken), request('figurine-convert-order', input, aToken)]);
      assert.equal(again1.status, 200); assert.equal(again2.status, 200);
      assert.equal(await orders.count({ where: { figurineOfferKey: String(accepted.id) } }), 1);
      assert.equal((await request('order', { id: converted.orderId }, bToken)).status, 404);
      assert.equal((await request('payment-result', { orderNumber: converted.orderNumber }, bToken)).status, 404);
      assert.equal((await request('figurine-start-payment', { orderId: converted.orderId }, aToken)).status, 503, 'bank gate defaults off');
      const attemptQuery = app.db.query('api::payment-attempt.payment-attempt');
      const uncertain = await attemptQuery.create({ data: { order: order.id, xid: `U${crypto.randomBytes(9).toString('hex').toUpperCase()}`, amount: order.grandTotal, currency: 'TL', state: 'unknown' } });
      const admin = await app.db.query('admin::user').findOne({ where: { email: `workflow-${runId}@example.test` } });
      await assert.rejects(() => workflow.figurineAdminSaveOffer(admin, figurineRequestId,
        { scope: accepted.scope, amountMinor: accepted.amountMinor, taxMinor: accepted.taxMinor, shippingMinor: accepted.shippingMinor, totalMinor: accepted.totalMinor, currency: 'TRY', taxShippingDisclosure: accepted.taxShippingDisclosure, customerNote: '', internalNote: '', validUntil: null }, false));
      await attemptQuery.delete({ where: { id: uncertain.id } });
      const posnet = require(path.resolve('dist/src/api/payment/services/posnet.js')).default;
      const originalPost = posnet.postXml;
      Object.assign(process.env, { FIGURINE_PAYMENTS_ENABLED: 'true', POSNET_BANK_VERIFIED: 'true', POSNET_MERCHANT_ID: '0000000001', POSNET_TERMINAL_ID: '00000001', POSNET_ID: '1', POSNET_ENCKEY: 'mock-stage4-only', POSNET_XML_URL: 'https://bank.invalid/xml', POSNET_OOS_URL: 'https://bank.invalid/oos', BACKEND_URL: 'http://localhost:1337' });
      const parser = new XMLParser({ parseTagValue: false }), config = posnet.getConfig(); let bankInitiations = 0, mockCharges = 0;
      posnet.postXml = async (_config: any, xml: string, xid: string) => {
        const body = parser.parse(xml).posnetRequest;
        if (body.oosRequestData) { bankInitiations++; return { approved: '1', oosRequestDataResponse: { data1: 'mock-only', data2: '', sign: 'mock-sign' } }; }
        const paymentAttempt = await attemptQuery.findOne({ where: { xid } });
        const base = { xid, amount: paymentAttempt.amount, currency: paymentAttempt.currency, merchantId: config.merchantId, terminalId: config.terminalId, encKey: config.encKey };
        if (body.oosResolveMerchantData) return { approved: '1', oosResolveMerchantDataResponse: { xid, amount: String(paymentAttempt.amount), mdStatus: '1', mac: posnet.buildResolveResponseMac({ ...base, mdStatus: '1' }) } };
        if (body.oosTranData) { mockCharges++; return { approved: '1', hostlogkey: 'stage4-mock-reference', authCode: 'stage4-mock-auth', mac: posnet.buildTranResponseMac({ ...base, hostlogkey: 'stage4-mock-reference' }) }; }
        throw new Error('Unexpected mock Posnet operation');
      };
      try {
        const initiated = await request('figurine-start-payment', { orderId: converted.orderId }, aToken); assert.equal(initiated.status, 200, JSON.stringify(initiated.body));
        assert.equal(initiated.body.formFields.posnetData, 'mock-only'); assert.equal(bankInitiations, 1);
        const replay = await request('figurine-start-payment', { orderId: converted.orderId }, aToken); assert.equal(replay.status, 200); assert.equal(bankInitiations, 1);
        const readyAttempt = await attemptQuery.findOne({ where: { order: { id: order.id } } }); assert.equal(readyAttempt.amount, order.grandTotal); assert.equal(readyAttempt.currency, 'TL');
        await assert.rejects(() => workflow.figurineAdminSaveOffer(admin, figurineRequestId,
          { scope: accepted.scope, amountMinor: accepted.amountMinor, taxMinor: accepted.taxMinor, shippingMinor: accepted.shippingMinor, totalMinor: accepted.totalMinor, currency: 'TRY', taxShippingDisclosure: accepted.taxShippingDisclosure, customerNote: '', internalNote: '', validUntil: null }, false));
        const payment = app.service('api::payment.payment');
        const callback = await payment.handleCallback({ Xid: readyAttempt.xid, BankPacket: 'mock-bank-packet', MerchantPacket: 'mock-merchant-packet', Sign: 'mock-sign' });
        assert.equal(callback.success, true); assert.equal(mockCharges, 1);
        assert.equal((await payment.handleCallback({ Xid: readyAttempt.xid, BankPacket: 'mock-bank-packet', MerchantPacket: 'mock-merchant-packet', Sign: 'mock-sign' })).success, true); assert.equal(mockCharges, 1);
        const paid = await orders.findOne({ where: { id: order.id } }); assert.equal(paid.paymentState, 'paid'); assert.deepEqual(paid.figurineSnapshot.scope, accepted.scope);
        await assert.rejects(() => workflow.figurineAdminSaveOffer(admin, figurineRequestId,
          { scope: accepted.scope, amountMinor: accepted.amountMinor, taxMinor: accepted.taxMinor, shippingMinor: accepted.shippingMinor, totalMinor: accepted.totalMinor, currency: 'TRY', taxShippingDisclosure: accepted.taxShippingDisclosure, customerNote: '', internalNote: '', validUntil: null }, false));
      } finally { posnet.postXml = originalPost; process.env.FIGURINE_PAYMENTS_ENABLED = 'false'; process.env.POSNET_BANK_VERIFIED = 'false'; }
    });
    await test('Figurine operations, audit, customer return request, staff decision, notification failure/retry and direct Content Manager denial', async () => {
      const workflow = app.service('api::customer.customer'), admin = await app.db.query('admin::user').findOne({ where: { email: `workflow-${runId}@example.test` } });
      const order = await app.db.query('api::order.order').findOne({ where: { figurineRequest: { documentId: figurineRequestId } } });
      assert.ok(order);
      assert.equal((await workflow.figurineAdminOperation(admin, order.documentId, { fulfillmentState: 'preparing', customerNote: 'Hazırlık başlatıldı.', internalNote: 'STAFF_INTERNAL', shippingCarrier: '', trackingNumber: '', trackingUrl: '' })).fulfillmentState, 'preparing');
      await assert.rejects(() => workflow.figurineAdminOperation(admin, order.documentId, { fulfillmentState: 'delivered', customerNote: '', internalNote: '', shippingCarrier: '', trackingNumber: '', trackingUrl: '' }));
      const memberDetail = await request('figurine-request', { id: figurineRequestId }, aToken);
      assert.equal(memberDetail.body.order.customerNote, 'Hazırlık başlatıldı.'); assert.ok(!JSON.stringify(memberDetail.body).includes('STAFF_INTERNAL'));
      const key = crypto.randomBytes(20).toString('base64url'), returnInput = { orderId: order.documentId, reason: 'Sipariş başvuru testi', idempotencyKey: key };
      const firstReturn = await request('figurine-return-submit', returnInput, aToken); assert.equal(firstReturn.status, 200);
      const repeatedReturn = await request('figurine-return-submit', returnInput, aToken); assert.equal(repeatedReturn.body.id, firstReturn.body.id); assert.equal(repeatedReturn.body.repeated, true);
      assert.equal((await app.db.query('api::order.order').findOne({ where: { id: order.id } })).paymentState, 'paid', 'application must not refund or alter payment');
      const decision = await workflow.figurineAdminReturnDecision(admin, firstReturn.body.id, { state: 'accepted', customerNote: 'Başvurunuz incelendi.', staffNote: 'Internal decision note.' });
      assert.equal(decision.state, 'accepted'); assert.equal((await app.db.query('api::order.order').findOne({ where: { id: order.id } })).paymentState, 'paid');
      const events = await app.db.query('api::operation-event.operation-event').findMany({ where: { figurineRequest: { documentId: figurineRequestId } } }); assert.ok(events.length >= 4);
      const contentManager = await fetch(`${origin}/content-manager/collection-types/api::order.order`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { status: 'cancelled' } }) }); assert.equal(contentManager.status, 404);
      const mail = await app.db.query('api::figurine-outbox.figurine-outbox').create({ data: { eventKey: `stage4-retry-${runId}`, recipient: aliceUser.email, encryptedPayload: seal({ subject: 'Stage 4 test', text: 'Controlled outbox retry' }), status: 'pending', attempts: 0, nextAttemptAt: new Date(Date.now() - 1000).toISOString(), request: (await app.db.query('api::figurine-request.figurine-request').findOne({ where: { documentId: figurineRequestId } })).id } });
      process.env.FIGURINE_MAIL_MODE = 'smtp'; process.env.CUSTOMER_SMTP_HOST = '127.0.0.1'; process.env.CUSTOMER_SMTP_PORT = '1'; process.env.CUSTOMER_SMTP_USER = ''; process.env.CUSTOMER_SMTP_PASS = '';
      await workflow.figurineOutbox(); assert.equal((await app.db.query('api::figurine-outbox.figurine-outbox').findOne({ where: { id: mail.id } })).status, 'failed');
      await workflow.figurineAdminRetryOutbox(admin, mail.documentId); process.env.FIGURINE_MAIL_MODE = 'file'; await workflow.figurineOutbox();
      assert.equal((await app.db.query('api::figurine-outbox.figurine-outbox').findOne({ where: { id: mail.id } })).status, 'sent');
      process.env.FIGURINE_PHOTO_ROLE_NAMES = 'No such role';
      await assert.rejects(() => workflow.figurineAdminPhoto(admin, figurineRequestId, 'not-a-photo'));
      process.env.FIGURINE_PHOTO_ROLE_NAMES = 'Super Admin';
    });
    await test('Stage 5 marketing consent defaults closed; guest-order claim verifies the order-record email and account deletion revokes sessions without deleting records', async () => {
      const prefs = await request('communication-preferences', {}, aToken); assert.equal(prefs.status, 200); assert.equal(prefs.body.enabled, false); assert.deepEqual(prefs.body.preferences, { email: false, whatsapp: false });
      assert.equal((await request('communication-preferences-save', { email: true, whatsapp: true }, aToken)).status, 503);
      process.env.CUSTOMER_DATA_ADMIN_ROLE_NAMES = '';
      await assert.rejects(() => service.accountDeletionAdminList({ id: 1 }), /yetkisi gerekli/i);
      await assert.rejects(() => service.figurineRetentionPreview({ id: 1 }), /yetkisi gerekli/i);
      Object.assign(process.env, { MARKETING_CONSENT_ENABLED: 'true', MARKETING_CONSENT_TEXT_VERSION: `synthetic-${runId}`, MARKETING_CONSENT_APPROVED_TEXT: 'Synthetic approved notice for test only.' });
      assert.equal((await request('communication-preferences-save', { email: true, whatsapp: false }, aToken)).status, 200);
      const consentRows = await app.db.query('api::customer-consent.customer-consent').findMany({ where: { owner: { id: aliceUser.id } }, orderBy: { createdAt: 'desc' } });
      assert.equal(consentRows.length, 2); assert.ok(consentRows.every((row: any) => row.textVersion === `synthetic-${runId}` && row.textSnapshot === 'Synthetic approved notice for test only.' && row.source === 'account-settings'));
      process.env.MARKETING_CONSENT_ENABLED = 'false'; process.env.MARKETING_CONSENT_TEXT_VERSION = ''; process.env.MARKETING_CONSENT_APPROVED_TEXT = '';
      const guestOrder = await app.documents('api::order.order').create({ data: { orderNumber: `CLAIM-${runId}`, items: [], subtotal: 0, grandTotal: 0, buyerName: 'Alice Test', buyerEmail: alice, buyerPhone: '', contractAccepted: true } });
      assert.equal((await request('claim-guest-order', { orderNumber: guestOrder.orderNumber }, bToken)).body.message.length > 0, true);
      const claimMail = await query('mail').findMany({ where: { recipient: alice }, orderBy: { id: 'desc' } });
      const savedMail = JSON.parse(await fs.readFile(path.join(process.cwd(), '.tmp/customer-mail', `${claimMail[0].id}.json`), 'utf8'));
      const claimToken = new URLSearchParams(new URL(savedMail.text.match(/http[^\s]+/)[0]).hash.slice(1)).get('token')!;
      assert.equal((await request('claim-order-verify', { token: claimToken }, aToken)).status, 400, 'verification is bound to the claimant account');
      assert.equal((await request('claim-order-verify', { token: claimToken }, bToken)).status, 200);
      assert.equal((await app.db.query('api::order.order').findOne({ where: { id: guestOrder.id }, populate: ['user'] })).user.id, bobUser.id);
      assert.equal((await request('claim-order-verify', { token: claimToken }, bToken)).status, 400);
      const deletion = await request('account-delete-request', { password: 'New local password 456!', reason: 'synthetic test only' }, aToken);
      assert.equal(deletion.status, 200); assert.equal((await request('me', {}, aToken)).status, 401);
      const deletionRows = await app.db.query('api::account-deletion-request.account-deletion-request').findMany({ where: { ownerKey: digest(String(aliceUser.id)) } }); assert.equal(deletionRows[0].status, 'pending-review');
      assert.ok(await app.db.query('api::order.order').findOne({ where: { id: guestOrder.id } }), 'account request must not cascade-delete orders');
    });
    console.log(`Completed ${passed} integration/security groups on isolated ${process.env.DATABASE_CLIENT} database.`);
    if (process.argv.includes('--e2e')) {
      const orderCustomer = await users().findOne({ where: { id: aliceUser.id } });
      await new Promise<void>((resolve, reject) => {
        const frontend = path.resolve(process.cwd(), '../toptan3dcim-frontend');
        const childEnv = { ...process.env, CUSTOMER_STRAPI_INTERNAL_URL: origin, CUSTOMER_TEST_ORDER_EMAIL: orderCustomer.email,
          CUSTOMER_TEST_ORDER_PASSWORD: 'New local password 456!', CUSTOMER_TEST_ORDER_NUMBER: `TEST-${runId}` };
        const useContainer = process.env.CUSTOMER_E2E_BROWSER_CONTAINER === 'true';
        const command = useContainer ? 'docker' : process.execPath;
        const args = useContainer ? [
          'run', '--rm', '--network', 'host', '--ipc', 'host', '--user', `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`,
          '-e', 'HOME=/tmp', ...Object.keys(childEnv).filter(key => /^(CUSTOMER_|FIGURINE_|NEXT_|BACKEND_|NODE_ENV$)/.test(key)).flatMap(key => ['-e', key]),
          '-v', `${frontend}:/work/frontend`, '-v', `${process.cwd()}:/work/toptan3dcim-backend:ro`, '-w', '/work/frontend',
          'mcr.microsoft.com/playwright:v1.63.0-noble', 'node', 'tests/account.e2e.cjs',
        ] : ['tests/account.e2e.cjs'];
        const child = spawn(command, args, { cwd: frontend, windowsHide: true, env: childEnv, stdio: 'inherit' });
        child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('Local account E2E failed')));
      });
    }
    if (process.argv.includes('--build')) {
      // Temporary fixture permissions only: production CMS is never contacted.
      const publicRole = await app.db.query('plugin::users-permissions.role').findOne({ where: { type: 'public' } });
      for (const name of ['product', 'category-product', 'banners1', 'blog-post']) {
        for (const operation of ['find', 'findOne']) {
          await app.db.query('plugin::users-permissions.permission').create({ data: { role: publicRole.id, action: `api::${name}.${name}.${operation}` } });
        }
      }
      await new Promise<void>((resolve, reject) => {
        const frontend = path.resolve(process.cwd(), '../toptan3dcim-frontend');
        const child = spawn(process.execPath, [path.join(frontend, 'node_modules/next/dist/bin/next'), 'build'], { cwd: frontend, windowsHide: true,
          env: { ...process.env, NODE_ENV: 'production', CUSTOMER_PUBLIC_ORIGIN: 'https://local-build.example.test', NEXT_PUBLIC_STRAPI_URL: origin, CUSTOMER_STRAPI_INTERNAL_URL: origin, BACKEND_PROXY_URL: origin, NEXT_TELEMETRY_DISABLED: '1' }, stdio: 'inherit' });
        child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('Local frontend build failed')));
      });
    }
  } finally { await app.destroy(); }
}
main().catch(err => { console.error(err instanceof Error ? err.stack : 'Test failed'); process.exitCode = 1; });
