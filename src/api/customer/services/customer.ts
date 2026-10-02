import { randomToken, digest, equal, seal, open, iso, fields, text, email, password, phone, CustomerError } from '../../../customer/security';
import fs from 'node:fs/promises';
import path from 'node:path';
import checkoutFactory from '../../../commerce/checkout';
import figurineFactory from '../../../commerce/figurines';
import figurineWorkflowFactory from '../../../commerce/figurine-workflow';
import { dataAdministrator } from '../../../commerce/authorization';

const uid = (name: string) => { const apiName = ['customer-consent','account-deletion-request','guest-order-claim','retention-job'].includes(name) ? name : `customer-${name}`; return `api::${apiName}.${apiName}`; };
const DAY = 86400000;
const GENERIC = 'İsteğiniz alındı. Bu adres için işlem yapılabiliyorsa e-posta gönderimi sıraya alınır.';
const addressFields = ['label', 'fullName', 'phone', 'city', 'district', 'addressLine', 'postalCode', 'defaultShipping', 'defaultBilling'];
const invalidLink = () => new CustomerError(400, 'Bağlantı geçersiz, kullanılmış veya süresi dolmuş. Yeni bir bağlantı isteyin.');

export default ({ strapi }: any) => {
  const commerce = checkoutFactory(strapi);
  const figurines = figurineFactory({ strapi });
  const figurineWorkflow = figurineWorkflowFactory(strapi);
  const q = (name: string) => strapi.db.query(uid(name));
  const users = () => strapi.db.query('plugin::users-permissions.user');
  const up = () => strapi.plugin('users-permissions').service('user');
  const manager = () => strapi.sessionManager('users-permissions');
  const db = () => strapi.db.connection;
  const table = (name: string) => strapi.db.metadata.get(uid(name)).tableName;
  const column = (name: string, field: string) => strapi.db.metadata.get(uid(name)).attributes[field].columnName;
  const safeUser = (u: any, p: any) => ({ email: u.email, fullName: p?.fullName || '', phone: p?.phone || '' });
  const safeAddress = (a: any) => Object.fromEntries(['documentId', ...addressFields].map(k => [k, a[k]]));
  // Strapi 5 Query Engine updateMany cannot update a joined relation filter.
  // Resolve owned IDs first, then mutate only those IDs in the surrounding transaction/lock.
  async function updateOwned(name: string, owner: number, data: any, extra: any = {}) {
    const records = await q(name).findMany({ where: { owner: { id: owner }, ...extra }, select: ['id'] });
    if (records.length) await q(name).updateMany({ where: { id: { $in: records.map(r => r.id) } }, data });
  }

  async function rate(operation: string, identity: string, max: number, windowMs = 900000) {
    const window = Math.floor(Date.now() / windowMs);
    const bucketKey = digest(`${operation}:${identity}:${window}`);
    const t = table('rate'), k = column('rate', 'bucketKey'), h = column('rate', 'hits'), e = column('rate', 'expiresAt');
    const rows = await db()(t).insert({ [k]: bucketKey, [h]: 1, [e]: new Date((window + 2) * windowMs) })
      .onConflict(k).merge({ [h]: db().raw('?? + 1', [h]) }).returning(h);
    if (Number(rows[0][h]) > max) throw new CustomerError(429, 'Çok fazla deneme yapıldı. Lütfen daha sonra tekrar deneyin.');
  }

  // Database compare-and-swap lease works across instances; no process-local mutex.
  async function locked(name: string, id: number, task: (lease: Date) => Promise<any>) {
    const t = table(name), c = column(name, 'lockUntil');
    for (let attempt = 0; attempt < 60; attempt++) {
      const lease = new Date(Date.now() + 30000);
      const changed = await db()(t).where({ id }).andWhere(b => b.whereNull(c).orWhere(c, '<', new Date())).update({ [c]: lease });
      if (changed) {
        try { return await task(lease); }
        finally { await db()(t).where({ id, [c]: lease }).update({ [c]: null }); }
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new CustomerError(409, 'İşleminiz sürüyor. Lütfen tekrar deneyin.');
  }
  async function profile(userId: number) {
    let p = await q('profile').findOne({ where: { userKey: String(userId) } });
    if (!p) {
      try { p = await q('profile').create({ data: { userKey: String(userId), owner: userId } }); }
      catch { p = await q('profile').findOne({ where: { userKey: String(userId) } }); if (!p) throw new Error('profile unavailable'); }
    }
    return p;
  }
  async function revoke(userId: number, deviceId?: string) {
    const sessions = await q('session').findMany({ where: { owner: { id: userId }, ...(deviceId ? { deviceId } : {}) }, select: ['id'] });
    if (sessions.length) await q('session').deleteMany({ where: { id: { $in: sessions.map(s => s.id) } } });
    await manager().invalidateRefreshToken(String(userId), deviceId);
  }
  async function authenticate(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) throw new CustomerError(401, 'Lütfen hesabınıza giriş yapın.');
    let s = await q('session').findOne({ where: { tokenHash: digest(token) }, populate: ['owner'] });
    if (!s || Date.parse(s.expiresAt) <= Date.now() || Date.parse(s.idleExpiresAt) <= Date.now()) {
      if (s) await revoke(s.owner.id, s.deviceId);
      throw new CustomerError(401, 'Oturumunuz sona erdi. Lütfen tekrar giriş yapın.');
    }
    if (!s.owner || s.owner.blocked || !s.owner.confirmed) {
      if (s.owner) await revoke(s.owner.id);
      throw new CustomerError(401, 'Oturumunuz kullanılamıyor. Lütfen tekrar giriş yapın.');
    }
    return locked('session', s.id, async lease => {
      s = await q('session').findOne({ where: { id: s.id }, populate: ['owner'] });
      if (!s || !s.owner || s.owner.blocked || !s.owner.confirmed || Date.parse(s.expiresAt) <= Date.now() || Date.parse(s.idleExpiresAt) <= Date.now()) throw new CustomerError(401, 'Oturumunuz sona erdi.');
      let tokens = open(s.encryptedTokens);
      let accessExpiresAt = new Date(s.accessExpiresAt);
      // SessionManager.validateAccessToken only verifies the JWT. Explicitly check the DB family.
      const refresh = await manager().validateRefreshToken(tokens.refresh);
      if (!refresh.isValid) { await revoke(s.owner.id, s.deviceId); throw new CustomerError(401, 'Oturumunuz sona erdi.'); }
      if (Date.parse(s.accessExpiresAt) < Date.now() + 60000) {
        const rotated = await manager().rotateRefreshToken(tokens.refresh);
        if ('error' in rotated) throw new CustomerError(401, 'Oturumunuz sona erdi.');
        const access = await manager().generateAccessToken(rotated.token);
        if ('error' in access) throw new CustomerError(401, 'Oturumunuz sona erdi.');
        tokens = { refresh: rotated.token, access: access.token };
        accessExpiresAt = new Date(Date.now() + 600000);
      }
      const validation = await manager().validateAccessToken(tokens.access);
      if (!validation.isValid || String(validation.payload.userId) !== String(s.owner.id)) throw new CustomerError(401, 'Oturumunuz sona erdi.');
      // Fence the write with the lease: a delayed worker must never overwrite a newer rotation.
      const changed = await db()(table('session')).where({ id: s.id, [column('session', 'lockUntil')]: lease }).update({
        [column('session', 'encryptedTokens')]: seal(tokens),
        [column('session', 'accessExpiresAt')]: accessExpiresAt,
        [column('session', 'idleExpiresAt')]: new Date(Math.min(Date.parse(s.expiresAt), Date.now() + DAY)),
      });
      if (!changed) throw new CustomerError(401, 'Oturumunuz sona erdi. Lütfen tekrar giriş yapın.');
      return { user: s.owner, session: s, profile: await profile(s.owner.id) };
    });
  }

  function mailConfig() {
    const mode = process.env.CUSTOMER_MAIL_MODE;
    if (mode === 'file' && process.env.NODE_ENV !== 'production') return null;
    if (mode !== 'smtp' || !process.env.CUSTOMER_SMTP_HOST || !process.env.CUSTOMER_SMTP_USER || !process.env.CUSTOMER_SMTP_PASS || !process.env.CUSTOMER_MAIL_FROM) {
      throw new CustomerError(503, 'E-posta hizmeti yapılandırılmamış. Lütfen daha sonra tekrar deneyin.');
    }
    const nodemailer = require('nodemailer');
    const port = Number(process.env.CUSTOMER_SMTP_PORT || 465);
    return nodemailer.createTransport({ host: process.env.CUSTOMER_SMTP_HOST, port, secure: port === 465,
      auth: { user: process.env.CUSTOMER_SMTP_USER, pass: process.env.CUSTOMER_SMTP_PASS },
      requireTLS: port !== 465, connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000 });
  }
  async function sendJob(job: any) {
    const payload = open(job.encryptedPayload);
    const transport = mailConfig();
    if (transport) await transport.sendMail({ from: process.env.CUSTOMER_MAIL_FROM, to: job.recipient, ...payload });
    else {
      const directory = path.resolve(process.cwd(), '.tmp/customer-mail');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(directory, `${job.id}.json`), JSON.stringify({ to: job.recipient, ...payload }), { mode: 0o600 });
    }
    await q('mail').update({ where: { id: job.id }, data: { status: 'sent', encryptedPayload: null, attempts: (job.attempts || 0) + 1 } });
  }
  async function deliver(recipient: string, purpose: string, token: string, queueOnly = false) {
    const origin = new URL(process.env.CUSTOMER_PUBLIC_ORIGIN || '');
    const link = new URL(purpose === 'reset' ? '/hesap/sifre-sifirla' : '/hesap/dogrula', origin);
    // Fragment is never sent to HTTP servers/access logs. Client removes it immediately.
    link.hash = new URLSearchParams({ token }).toString();
    const payload = { subject: purpose === 'reset' ? 'Şifrenizi sıfırlayın' : 'E-posta adresinizi doğrulayın',
      text: `İşlemi tamamlamak için bağlantıyı açın:\n${link}\nBağlantı tek kullanımlıktır. Bu işlemi siz istemediyseniz dikkate almayın.` };
    const job = await q('mail').create({ data: { recipient, encryptedPayload: seal(payload), status: 'pending', expiresAt: iso(Date.now() + (purpose === 'reset' ? 1800000 : DAY)) } });
    // Generic reset/resend responses acknowledge a durable queue, never claim delivery.
    // SMTP health was checked before looking up either known or unknown accounts.
    if (queueOnly && process.env.CUSTOMER_MAIL_MODE === 'smtp') return;
    try {
      await locked('mail', job.id, () => sendJob(job));
    } catch {
      await q('mail').update({ where: { id: job.id }, data: { status: 'failed', attempts: 1 } });
      throw new CustomerError(503, 'E-posta gönderilemedi. Lütfen yeni bir bağlantı isteyin.');
    }
  }
  async function action(user: any, purpose: string, targetEmail = user.email, queueOnly = false) {
    const token = randomToken();
    await updateOwned('action', user.id, { usedAt: iso() }, { purpose, usedAt: null });
    await q('action').create({ data: { owner: user.id, purpose, targetEmail, tokenHash: digest(token), expiresAt: iso(Date.now() + (purpose === 'reset' ? 1800000 : DAY)) } });
    await deliver(targetEmail, purpose, token, queueOnly);
  }
  async function redeem(token: string, permitted: string[], task: (a: any) => Promise<any>) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) throw invalidLink();
    const a = await q('action').findOne({ where: { tokenHash: digest(token) }, populate: ['owner'] });
    if (!a || !a.owner || a.owner.blocked || !permitted.includes(a.purpose)) throw invalidLink();
    const p = await profile(a.owner.id);
    return locked('profile', p.id, async () => strapi.db.transaction(async ({ trx }) => {
      const t = table('action'), used = column('action', 'usedAt'), expiry = column('action', 'expiresAt');
      const claimed = await strapi.db.getConnection(t).transacting(trx).where({ id: a.id }).whereNull(used).where(expiry, '>', new Date()).update({ [used]: new Date() });
      if (!claimed) throw invalidLink();
      const user = await users().findOne({ where: { id: a.owner.id } });
      if (!user || user.blocked) throw invalidLink();
      if (a.purpose !== 'email-change' && a.targetEmail !== user.email) throw invalidLink();
      return task({ ...a, owner: user });
    }));
  }
  function normalizeAddress(body: any) {
    fields(body, addressFields);
    const out: any = {};
    for (const key of ['label', 'fullName', 'city', 'district', 'addressLine']) out[key] = text(body[key], key === 'addressLine' ? 600 : 100, true);
    out.phone = phone(body.phone); out.postalCode = text(body.postalCode ?? '', 20);
    for (const key of ['defaultShipping', 'defaultBilling']) {
      if (typeof body[key] !== 'boolean') throw new CustomerError(400, 'Varsayılan adres seçimi geçersiz.');
      out[key] = body[key];
    }
    return out;
  }
  function safeOrder(o: any, detail = false) {
    const out: any = { documentId: o.documentId, orderNumber: o.orderNumber, status: o.status, createdAt: o.createdAt, grandTotal: o.grandTotal, currency: o.currency };
    out.paymentState = o.paymentState || o.status;
    if (o.fulfillmentCustomerNote) out.fulfillmentCustomerNote = o.fulfillmentCustomerNote;
    for (const key of ['fulfillmentState', 'shippingCarrier', 'trackingNumber']) if (o[key]) out[key] = o[key];
    if (o.trackingUrl) { try { const u = new URL(o.trackingUrl); if (u.protocol === 'https:' && !u.username && !u.password) out.trackingUrl = u.href; } catch {} }
    if (detail) {
      for (const key of ['subtotal', 'discountTotal', 'vatTotal', 'shippingCost', 'buyerName', 'buyerEmail', 'buyerPhone']) out[key] = o[key];
      const a = o.shippingAddress || {};
      out.shippingAddress = Object.fromEntries(['city', 'district', 'addressLine'].filter(k => typeof a[k] === 'string').map(k => [k, a[k]]));
      if (o.billingAddress) out.billingAddress = Object.fromEntries(['fullName','phone','city','district','addressLine','postalCode'].filter(k => typeof o.billingAddress[k] === 'string').map(k => [k,o.billingAddress[k]]));
      out.items = Array.isArray(o.items) ? o.items.map(i => ({ isim: i.isim, adet: i.adet, birimFiyat: i.birimFiyat, satirToplami: i.satirToplami,
        variant: typeof i.variant?.colorName === 'string' ? { colorName: i.variant.colorName } : null })) : [];
    }
    return out;
  }

  return {
    async revokeUser(userId: number) {
      await revoke(userId);
      await updateOwned('action', userId, { usedAt: iso() }, { usedAt: null });
    },
    async dispatch(input: any, sessionToken: string, client: string) {
      fields(input, ['operation', 'data']);
      const operation = text(input.operation, 40, true), data = input.data || {};
      await rate('all', client || 'unknown', 120, 60000);
      if (operation === 'figurine-packages') {
        if (process.env.FIGURINE_REQUESTS_ENABLED !== 'true') throw new CustomerError(503, 'Figür talep hizmeti şu anda kapalı.');
        return figurines.run(operation, data, null);
      }
      if (['register', 'login', 'forgot', 'resend', 'verify', 'reset'].includes(operation)) {
        await rate(operation, client || 'unknown', operation === 'login' ? 20 : 8);
        if (data.email) await rate(`${operation}:email`, email(data.email), 5);
      }
      if (operation === 'register') {
        fields(data, ['email', 'password', 'fullName']);
        const address = email(data.email), pass = password(data.password), name = text(data.fullName, 100, true);
        mailConfig();
        const settings = await strapi.store({ type: 'plugin', name: 'users-permissions', key: 'advanced' }).get();
        if (settings?.allow_register === false) throw new CustomerError(403, 'Yeni üyelik şu anda kapalı.');
        const existing = await users().findOne({ where: { email: address } });
        if (existing) throw new CustomerError(400, 'Kayıt tamamlanamadı. Hesabınız varsa giriş yapın veya yeni doğrulama e-postası isteyin.');
        const role = await strapi.db.query('plugin::users-permissions.role').findOne({ where: { type: 'authenticated' } });
        if (!role) throw new Error('Authenticated role missing');
        let user: any;
        try {
          user = await strapi.db.transaction(async () => {
            const u = await up().add({ username: `customer_${randomToken()}`, email: address, password: pass, provider: 'local', confirmed: false, blocked: false, role: role.id });
            const p = await profile(u.id); await q('profile').update({ where: { id: p.id }, data: { fullName: name } }); return u;
          });
        } catch { throw new CustomerError(400, 'Kayıt tamamlanamadı. Hesabınız varsa giriş yapın.'); }
        await action(user, 'verify');
        return { message: 'Hesabınız oluşturuldu. Giriş yapmak için e-posta adresinizi doğrulayın.' };
      }
      if (operation === 'login') {
        fields(data, ['email', 'password']);
        const address = email(data.email);
        if (typeof data.password !== 'string' || Buffer.byteLength(data.password) > 72) throw new CustomerError(401, 'E-posta veya şifre hatalı.');
        const u = await users().findOne({ where: { email: address, provider: 'local' } });
        // Same bcrypt cost for unknown users.
        const hash = u?.password || '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
        const valid = await up().validatePassword(data.password, hash);
        if (!u || !valid || u.blocked) throw new CustomerError(401, 'E-posta veya şifre hatalı.');
        if (!u.confirmed) throw new CustomerError(403, 'Giriş yapmak için e-posta adresinizi doğrulayın.');
        const p = await profile(u.id);
        return locked('profile', p.id, async () => {
          const current = await users().findOne({ where: { id: u.id } });
          if (!current || current.blocked || !current.confirmed || current.password !== u.password) throw new CustomerError(401, 'Lütfen tekrar giriş yapın.');
          const deviceId = randomToken(), token = randomToken();
          const refresh = await manager().generateRefreshToken(String(u.id), deviceId, { type: 'refresh' });
          const access = await manager().generateAccessToken(refresh.token);
          if ('error' in access) throw new Error('Access token unavailable');
          await q('session').create({ data: { owner: u.id, tokenHash: digest(token), encryptedTokens: seal({ access: access.token, refresh: refresh.token }), deviceId,
            expiresAt: iso(Date.now() + 7 * DAY), idleExpiresAt: iso(Date.now() + DAY), accessExpiresAt: iso(Date.now() + 600000) } });
          return { sessionToken: token, user: safeUser(u, p) };
        });
      }
      if (operation === 'forgot' || operation === 'resend') {
        fields(data, ['email']); const address = email(data.email);
        const transport = mailConfig(); if (transport) { try { await transport.verify(); } catch { throw new CustomerError(503, 'E-posta hizmetine şu anda erişilemiyor.'); } }
        const u = await users().findOne({ where: { email: address, provider: 'local', blocked: false } });
        if (u && (operation === 'forgot' || !u.confirmed)) {
          const p = await profile(u.id); await locked('profile', p.id, () => action(u, operation === 'forgot' ? 'reset' : 'verify', u.email, true));
        }
        return { message: GENERIC };
      }
      if (operation === 'verify') {
        fields(data, ['token']);
        return redeem(data.token, ['verify', 'email-change'], async a => {
          if (a.purpose === 'email-change') {
            const taken = await users().findOne({ where: { email: a.targetEmail, id: { $ne: a.owner.id } } });
            if (taken) throw new CustomerError(400, 'E-posta değişikliği tamamlanamadı.');
            await up().edit(a.owner.id, { email: a.targetEmail }); await revoke(a.owner.id);
          } else await up().edit(a.owner.id, { confirmed: true });
          return { message: 'E-posta adresiniz doğrulandı. Hesabınıza giriş yapabilirsiniz.' };
        });
      }
      if (operation === 'reset') {
        fields(data, ['token', 'password']); const pass = password(data.password);
        return redeem(data.token, ['reset'], async a => {
          await up().edit(a.owner.id, { password: pass, resetPasswordToken: null });
          await revoke(a.owner.id);
          await updateOwned('action', a.owner.id, { usedAt: iso() }, { purpose: 'reset', usedAt: null });
          return { message: 'Şifreniz güncellendi. Yeni şifrenizle giriş yapın.' };
        });
      }
      if (operation === 'logout') {
        fields(data, []);
        if (sessionToken) { try { const a = await authenticate(sessionToken); await revoke(a.user.id, a.session.deviceId); } catch (e) { if (!(e instanceof CustomerError && e.status === 401)) throw e; } }
        return { message: 'Çıkış yapıldı.' };
      }
      if (['cart', 'cart-save', 'cart-merge', 'checkout-quote', 'checkout', 'payment-result'].includes(operation)) {
        const auth = sessionToken ? await authenticate(sessionToken) : null;
        if (operation === 'checkout') await rate('checkout', auth ? String(auth.user.id) : data?.guestKey ? digest(String(data.guestKey)) : client || 'unknown', 8, 60000);
        return commerce.run(operation, data, auth);
      }
      const auth = await authenticate(sessionToken), owner = auth.user.id;
      if (operation === 'communication-preferences') {
        fields(data, []);
        const enabled = process.env.MARKETING_CONSENT_ENABLED === 'true' && Boolean(process.env.MARKETING_CONSENT_TEXT_VERSION && process.env.MARKETING_CONSENT_APPROVED_TEXT);
        const rows = await q('customer-consent').findMany({ where: { owner: { id: owner } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
        return { enabled, textVersion: enabled ? process.env.MARKETING_CONSENT_TEXT_VERSION : null, notice: enabled ? process.env.MARKETING_CONSENT_APPROVED_TEXT : null,
          preferences: Object.fromEntries(['email','whatsapp'].map(channel => [channel, Boolean(rows.find((r: any) => r.channel === channel)?.enabled)])) };
      }
      if (operation === 'communication-preferences-save') {
        fields(data, ['email', 'whatsapp']);
        if (process.env.MARKETING_CONSENT_ENABLED !== 'true' || !process.env.MARKETING_CONSENT_TEXT_VERSION || !process.env.MARKETING_CONSENT_APPROVED_TEXT) throw new CustomerError(503, 'OnaylÄ± pazarlama metni yayÄ±na alÄ±nmadÄ±ÄŸÄ± iÃ§in tercih deÄŸiÅŸikliÄŸi kapalÄ±.');
        if (typeof data.email !== 'boolean' || typeof data.whatsapp !== 'boolean') throw new CustomerError(400, 'Tercihleri kontrol edin.');
        for (const channel of ['email','whatsapp']) await q('customer-consent').create({ data: { owner, channel, enabled: data[channel], source: 'account-settings', textVersion: process.env.MARKETING_CONSENT_TEXT_VERSION, textSnapshot: process.env.MARKETING_CONSENT_APPROVED_TEXT } });
        return { message: 'Tercihleriniz kaydedildi.' };
      }
      if (operation === 'account-delete-request') {
        fields(data, ['password', 'reason']);
        if (typeof data.password !== 'string' || Buffer.byteLength(data.password) > 72 || !(await up().validatePassword(data.password, auth.user.password))) throw new CustomerError(401, 'Yeniden kimlik doÄŸrulamasÄ± baÅŸarÄ±sÄ±z.');
        const existing = await q('account-deletion-request').findOne({ where: { ownerKey: digest(String(owner)), status: { $in: ['pending-review','blocked','approved'] } } });
        if (existing) return { status: existing.status, message: 'Hesap silme baÅŸvurunuz zaten incelemede.' };
        const row = await q('account-deletion-request').create({ data: { owner, ownerKey: digest(String(owner)), reason: text(data.reason || '', 2000), status: 'pending-review', requestedAt: iso() } });
        await strapi.db.query('api::operation-event.operation-event').create({ data: { actor: `customer:${owner}`, fromState: 'active', toState: 'deletion-requested', details: { request: row.documentId } } });
        await revoke(owner);
        return { status: 'pending-review', message: 'BaÅŸvurunuz kaydedildi. OturumlarÄ±nÄ±z kapatÄ±ldÄ±; silme iÅŸlemi incelemeden sonra ayrÄ±ca deÄŸerlendirilir.' };
      }
      if (operation === 'claim-order-verify') {
        fields(data, ['token']); await rate('claim-order-verify', String(owner), 10, 3600000);
        const token = text(data.token, 100, true);
        const claim = await q('guest-order-claim').findOne({ where: { tokenHash: digest(token) }, populate: ['order'] });
        if (claim && (claim.claimantKey !== digest(String(owner)) || claim.attempts >= 5)) {
          await q('guest-order-claim').update({ where: { id: claim.id }, data: { attempts: (claim.attempts || 0) + 1, ...(claim.attempts >= 4 ? { status: 'expired' } : {}) } });
          throw new CustomerError(400, 'BaÄŸlantÄ± geÃ§ersiz veya sÃ¼resi dolmuÅŸ.');
        }
        if (!claim || claim.status !== 'verification-sent' || claim.usedAt || Date.parse(claim.expiresAt) <= Date.now()) throw new CustomerError(400, 'BaÄŸlantÄ± geÃ§ersiz veya sÃ¼resi dolmuÅŸ.');
        const outcome = await strapi.db.transaction(async ({ trx }: any) => {
          const claimsTable = table('guest-order-claim');
          const won = await db()(claimsTable).transacting(trx).where({ id: claim.id, status: 'verification-sent' }).whereNull(column('guest-order-claim', 'usedAt')).where(column('guest-order-claim', 'expiresAt'), '>', new Date()).update({ [column('guest-order-claim', 'usedAt')]: new Date(), [column('guest-order-claim', 'status')]: 'claimed' });
          if (!won) return false;
          const currentOwner = await db()('orders_user_lnk').transacting(trx).where({ order_id: claim.order.id }).first();
          if (currentOwner) throw new CustomerError(409, 'SipariÅŸ baÄŸlanamadÄ±; baÅŸka bir hesap tarafÄ±ndan iÅŸlenmiÅŸ olabilir.');
          try { await db()('orders_user_lnk').transacting(trx).insert({ order_id: claim.order.id, user_id: owner }); }
          catch (e: any) { if (e?.code === 'SQLITE_CONSTRAINT_UNIQUE' || e?.code === '23505') throw new CustomerError(409, 'SipariÅŸ baÄŸlanamadÄ±; baÅŸka bir hesap tarafÄ±ndan iÅŸlenmiÅŸ olabilir.'); throw e; }
          return true;
        });
        if (!outcome) throw new CustomerError(409, 'DoÄŸrulama daha Ã¶nce kullanÄ±lmÄ±ÅŸ.');
        return { message: 'SipariÅŸ hesabÄ±nÄ±za baÄŸlandÄ±.' };
      }
      if (operation === 'claim-guest-order') {
        fields(data, ['orderNumber']); await rate('claim-order', String(owner), 5, 3600000);
        const order = await strapi.db.query('api::order.order').findOne({ where: { orderNumber: text(data.orderNumber, 80, true) } });
        if (order && !order.user) {
          const prior = await q('guest-order-claim').findOne({ where: { order: { id: order.id }, claimant: { id: owner }, status: { $in: ['verification-sent','needs-review'] } } });
          if (!prior) {
            const token = randomToken(), claimant = await users().findOne({ where: { id: owner } });
            const canEmail = Boolean(claimant?.confirmed && order.buyerEmail);
            const claim = await q('guest-order-claim').create({ data: { order: order.id, claimant: owner, claimantKey: digest(String(owner)), tokenHash: digest(token), status: canEmail ? 'verification-sent' : 'needs-review', expiresAt: canEmail ? iso(Date.now()+1800000) : null } });
            if (canEmail) {
              const link = new URL('/hesap/siparis-sahiplen', process.env.CUSTOMER_PUBLIC_ORIGIN || 'http://localhost'); link.hash = new URLSearchParams({ token }).toString();
              const mail = await q('mail').create({ data: { recipient: order.buyerEmail, encryptedPayload: seal({ subject: 'SipariÅŸ sahiplenme doÄŸrulamasÄ±', text: `SipariÅŸinizi baÄŸlamak iÃ§in ${link} adresini aÃ§Ä±n.` }), status: 'pending', expiresAt: iso(Date.now()+1800000) } });
              try { await locked('mail', mail.id, () => sendJob(mail)); } catch { await q('mail').update({ where: { id: mail.id }, data: { status: 'failed', attempts: 1 } }); }
            }
          }
        }
        return { message: 'Uygunsa sipariÅŸ kaydÄ±ndaki doÄŸrulama kanalÄ± kullanÄ±lÄ±r. Uygun olmayan kayÄ±tlar personel incelemesine alÄ±nÄ±r.' };
      }
      if (operation.startsWith('figurine-')) {
        if (process.env.FIGURINE_REQUESTS_ENABLED !== 'true') throw new CustomerError(503, 'Figür talep hizmeti şu anda kapalı.');
        if (operation === 'figurine-upload-sign') await rate('figurine-upload', String(owner), 30, 60000);
        if (operation === 'figurine-submit') await rate('figurine-submit', String(owner), 8, 60000);
        if (figurineWorkflow.handles(operation)) return figurineWorkflow.run(operation, data, auth);
        return figurines.run(operation, data, auth);
      }
      if (operation === 'me') { fields(data, []); return { user: safeUser(auth.user, auth.profile) }; }
      if (operation === 'profile') {
        fields(data, ['fullName', 'phone']);
        const p = await q('profile').update({ where: { id: auth.profile.id, owner: { id: owner } }, data: { fullName: text(data.fullName, 100, true), phone: phone(data.phone) } });
        return { user: safeUser(auth.user, p), message: 'Profiliniz güncellendi.' };
      }
      if (operation === 'email-change') {
        fields(data, ['email', 'password']); const address = email(data.email);
        await rate('email-change', String(owner), 5);
        if (typeof data.password !== 'string' || Buffer.byteLength(data.password) > 72 || !(await up().validatePassword(data.password, auth.user.password))) throw new CustomerError(400, 'Mevcut şifrenizi kontrol edin.');
        if (address === auth.user.email || await users().findOne({ where: { email: address } })) throw new CustomerError(400, 'Bu e-posta adresi kullanılamıyor.');
        mailConfig(); await locked('profile', auth.profile.id, () => action(auth.user, 'email-change', address));
        return { message: 'Yeni adresinize doğrulama bağlantısı gönderildi. Doğrulanana kadar mevcut adresiniz kullanılacak.' };
      }
      if (operation === 'addresses') { fields(data, []); return { addresses: (await q('address').findMany({ where: { owner: { id: owner } }, orderBy: { createdAt: 'asc' } })).map(safeAddress) }; }
      if (operation === 'address-save') {
        fields(data, ['id', 'address']); const normalized = normalizeAddress(data.address);
        return locked('profile', auth.profile.id, async () => strapi.db.transaction(async () => {
          let existing: any;
          if (data.id) {
            existing = await q('address').findOne({ where: { documentId: text(data.id, 100, true), owner: { id: owner } } });
            if (!existing) throw new CustomerError(404, 'Adres bulunamadı.');
          } else if (await q('address').count({ where: { owner: { id: owner } } }) >= 20) throw new CustomerError(400, 'En fazla 20 adres kaydedebilirsiniz.');
          for (const key of ['defaultShipping', 'defaultBilling']) if (normalized[key]) await updateOwned('address', owner, { [key]: false });
          const a = existing ? await q('address').update({ where: { id: existing.id, owner: { id: owner } }, data: normalized }) : await q('address').create({ data: { ...normalized, owner } });
          return { address: safeAddress(a), message: 'Adres kaydedildi.' };
        }));
      }
      if (operation === 'address-delete') {
        fields(data, ['id']);
        return locked('profile', auth.profile.id, async () => {
          const a = await q('address').delete({ where: { documentId: text(data.id, 100, true), owner: { id: owner } } });
          if (!a) throw new CustomerError(404, 'Adres bulunamadı.'); return { message: 'Adres silindi.' };
        });
      }
      if (operation === 'orders') {
        fields(data, ['page']); const page = Number(data.page || 1);
        if (!Number.isInteger(page) || page < 1 || page > 10000) throw new CustomerError(400, 'Sayfa geçersiz.');
        const query = strapi.db.query('api::order.order'), where = { user: { id: owner } };
        const orders = await query.findMany({ where, orderBy: { createdAt: 'desc' }, limit: 20, offset: (page - 1) * 20 });
        return { orders: orders.map(o => safeOrder(o)), total: await query.count({ where }), page };
      }
      if (operation === 'order') {
        fields(data, ['id']);
        const order = await strapi.db.query('api::order.order').findOne({ where: { documentId: text(data.id, 100, true), user: { id: owner } } });
        if (!order) throw new CustomerError(404, 'Sipariş bulunamadı.'); return { order: safeOrder(order, true) };
      }
      throw new CustomerError(404, 'İşlem bulunamadı.');
    },
    async setup() {
      // Fail closed if existing duplicate emails prevent a single customer identity.
      const duplicates = await db()('up_users').select(db().raw('lower(email)')).groupByRaw('lower(email)').havingRaw('count(*) > 1');
      if (duplicates.length) throw new Error('Duplicate customer email identities require manual review before setup');
      await db()('up_users').update({ email: db().raw('lower(email)') });
      await db().raw('CREATE UNIQUE INDEX IF NOT EXISTS customer_user_email_unique ON up_users (lower(email))');
      for (const [name, field] of [['rate', 'bucketKey'], ['profile', 'userKey'], ['session', 'tokenHash'], ['action', 'tokenHash']]) {
        await db().raw('CREATE UNIQUE INDEX IF NOT EXISTS ?? ON ?? (??)', [`customer_${name}_${field}_unique`, table(name), column(name, field)]);
      }
      // Strapi 5 stores relations in link tables; enforce the many-to-one side atomically for legacy guest-order claims.
      await db().raw('CREATE UNIQUE INDEX IF NOT EXISTS ?? ON ?? (??)', ['customer_order_single_owner_unique', 'orders_user_lnk', 'order_id']);
      const advanced = strapi.store({ type: 'plugin', name: 'users-permissions', key: 'advanced' });
      const settings = await advanced.get();
      await advanced.set({ value: { ...settings, email_confirmation: true } });
    },
    async cleanup() {
      await q('rate').deleteMany({ where: { expiresAt: { $lt: iso() } } });
      await q('action').deleteMany({ where: { expiresAt: { $lt: iso(Date.now() - DAY) } } });
      await q('mail').deleteMany({ where: { expiresAt: { $lt: iso() } } });
      const expired = await q('session').findMany({ where: { $or: [{ expiresAt: { $lt: iso() } }, { idleExpiresAt: { $lt: iso() } }] }, populate: ['owner'], limit: 100 });
      for (const s of expired) { if (s.owner) await revoke(s.owner.id, s.deviceId); else await q('session').delete({ where: { id: s.id } }); }
    },
    async flushMail() {
      const jobs = await q('mail').findMany({ where: { status: { $in: ['pending', 'failed'] }, attempts: { $lt: 3 }, expiresAt: { $gt: iso() } }, limit: 20 });
      for (const job of jobs) {
        try {
          await locked('mail', job.id, async () => {
            const current = await q('mail').findOne({ where: { id: job.id } });
            if (!current || current.status === 'sent' || !current.encryptedPayload || Date.parse(current.expiresAt) <= Date.now() || current.attempts >= 3) return;
            try { await sendJob(current); }
            catch { await q('mail').update({ where: { id: current.id }, data: { status: 'failed', attempts: current.attempts + 1 } }); strapi.log.error('[customer] mail delivery failed'); }
          });
        } catch { strapi.log.error('[customer] mail queue unavailable'); }
      }
    },
    async localFigurinePut(id: string, token: string, bytes: Buffer) { return figurines.localPut(id, token, bytes); },
    async figurineCustomerPhoto(sessionToken: string, requestId: string, assetKey: string) { const auth = await authenticate(sessionToken); return figurines.customerPhoto(auth.user.id, requestId, assetKey); },
    async figurineAdminList(admin: any) { return figurines.adminList(admin); },
    async figurineAdminDetail(admin: any, requestId: string) { return figurineWorkflow.adminDetail(admin, requestId); },
    async figurineAdminDashboard(admin: any) { return figurineWorkflow.adminList(admin); },
    async figurineAdminSaveOffer(admin: any, requestId: string, data: any, present: boolean) { return figurineWorkflow.adminSaveOffer(admin, requestId, data, present); },
    async figurineAdminWithdrawOffer(admin: any, requestId: string, offerId: string) { return figurineWorkflow.adminWithdrawOffer(admin, requestId, offerId); },
    async figurineAdminRequestUpdate(admin: any, requestId: string, data: any) { return figurineWorkflow.adminRequestUpdate(admin, requestId, data); },
    async figurineAdminOperation(admin: any, orderId: string, data: any) { return figurineWorkflow.adminOperation(admin, orderId, data); },
    async figurineAdminReturnList(admin: any) { return figurineWorkflow.adminReturnList(admin); },
    async figurineAdminReturnDecision(admin: any, id: string, data: any) { return figurineWorkflow.adminReturnDecision(admin, id, data); },
    async figurineAdminOutbox(admin: any) { return figurines.adminOutbox(admin); },
    async figurineAdminRetryOutbox(admin: any, id: string) { return figurines.retryOutbox(admin, id); },
    async figurineRetentionPreview(admin: any) { return figurines.retentionPreview(admin); },
    async figurineRetentionExecute(admin: any, data: any) { return figurines.retentionExecute(admin, data); },
    async guestClaimAdminList(admin: any) {
      await dataAdministrator(strapi, Number(admin?.id));
      const rows = await q('guest-order-claim').findMany({ where: { status: 'needs-review' }, populate: ['order','claimant'], orderBy: { createdAt: 'asc' }, limit: 100 });
      return { claims: rows.map((r: any) => ({ id: r.documentId, status: r.status, createdAt: r.createdAt, orderNumber: r.order?.orderNumber || '', channelAvailable: Boolean(r.order?.buyerEmail || r.order?.buyerPhone), claimantEmail: r.claimant?.email || '' })) };
    },
    async accountDeletionAdminList(admin: any) {
      await dataAdministrator(strapi, Number(admin?.id));
      const rows = await q('account-deletion-request').findMany({ where: { status: { $in: ['pending-review','blocked','approved'] } }, populate: ['owner'], orderBy: { requestedAt: 'asc' }, limit: 100 });
      return { requests: rows.map((r: any) => ({ id: r.documentId, status: r.status, reason: r.reason || '', requestedAt: r.requestedAt, decisionReason: r.decisionReason || '', customerEmail: r.owner?.email || null })) };
    },
    async accountDeletionAdminDecision(admin: any, id: string, input: any) {
      const actor = await dataAdministrator(strapi, Number(admin?.id)); fields(input, ['status','reason']);
      if (!['blocked','approved','rejected'].includes(input.status)) throw new CustomerError(400, 'Karar durumu geÃ§ersiz.');
      const row = await q('account-deletion-request').findOne({ where: { documentId: text(id, 100, true) } });
      if (!row || ['completed','rejected'].includes(row.status)) throw new CustomerError(404, 'BaÅŸvuru bulunamadÄ±.');
      let reason = text(input.reason, 2000, true), status = input.status;
      if (status === 'approved' && row.owner) {
        const linkedOrders = await strapi.db.query('api::order.order').findMany({ where: { user: { id: row.owner.id } }, select: ['id','paymentState','status','fulfillmentState'] });
        const unresolved = linkedOrders.some((o: any) => ['pending','unknown'].includes(o.paymentState || o.status) || !o.fulfillmentState || ['preparing','production','ready','shipped'].includes(o.fulfillmentState));
        if (unresolved) { status = 'blocked'; reason = `${reason}\nSipariş, ödeme veya operasyon durumu için ek inceleme gerekiyor.`; }
      }
      const next = await q('account-deletion-request').update({ where: { id: row.id }, data: { status, decisionReason: reason, decidedAt: iso(), reviewerKey: String(actor.id) } });
      await strapi.db.query('api::operation-event.operation-event').create({ data: { actor: `admin:${actor.id}`, fromState: row.status, toState: status, details: { kind: 'account-deletion-review', requestId: row.documentId, reason } } });
      return { id: next.documentId, status: next.status, decidedAt: next.decidedAt, message: status === 'approved' ? 'Başvuru değerlendirmesi onaylandı; veri kaldırma ayrıca yetkili süreçte yürütülmelidir.' : status === 'blocked' ? 'Başvuru ek sipariş/ödeme incelemesi için durduruldu.' : 'Karar kaydedildi.' };
    },
    async figurineAdminPhoto(admin: any, requestId: string, assetKey: string) { return figurines.adminPhoto(admin, requestId, assetKey); },
    async figurineCleanup() { return figurines.cleanup(); },
    async figurineOutbox() { return figurines.flushOutbox(); },
    async setupFigurinePackages() { return figurines.seedDefaults(); },
  };
};
