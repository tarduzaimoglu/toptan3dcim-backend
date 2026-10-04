import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { digest, equal, fields, iso, open, randomToken, seal, text, CustomerError } from '../customer/security';
import storage from './figurine-storage';
import { operator, dataAdministrator } from './authorization';
import { queueBusinessFigurine } from './business-notifications';

const pkgUid = 'api::figurine-package.figurine-package';
const uid = (name: string) => `api::figurine-${name}.figurine-${name}`;
const strapiPublic = () => (process.env.BACKEND_URL || '').replace(/\/$/, '');
const error = (status: number, message: string) => new CustomerError(status, message);
const idText = (v: unknown) => text(v, 100, true);
const publicPackage = (p: any) => ({ id: p.documentId, key: p.key, title: p.title, description: p.description || '', style: p.style,
  characters: p.characters, pets: p.pets, startingPrice: p.showPrice ? p.startingPrice ?? null : null,
  priceLabel: !p.showPrice || p.startingPrice == null ? 'Teklif alın' : `₺${Number(p.startingPrice).toLocaleString('tr-TR')}`, priceKind: p.startingPrice == null || !p.showPrice ? 'quote' : 'starting',
  gallery: (p.gallery || []).filter((m: any) => typeof m.url === 'string').map((m: any) => ({ url: new URL(m.url, process.env.BACKEND_URL).href, alt: m.alternativeText || p.title })) });
const packageSnapshot = (p: any) => ({ key: p.key, title: p.title, description: p.description || '', style: p.style, characters: p.characters, pets: p.pets,
  startingPrice: p.showPrice ? p.startingPrice ?? null : null, priceKind: p.startingPrice == null || !p.showPrice ? 'quote' : 'starting' });

export default ({ strapi }: any) => {
  const q = (name: string) => strapi.db.query(uid(name));
  const db = () => strapi.db.connection;
  const table = (name: string) => strapi.db.metadata.get(uid(name)).tableName;
  async function getPackage(id: string) {
    const p = await strapi.db.query(pkgUid).findOne({ where: { documentId: id } });
    if (!p || !p.active) throw error(400, 'Paket seçimini kontrol edin.');
    return p;
  }
  async function getDraft(owner: number, create = false) {
    let d = await q('draft').findOne({ where: { ownerKey: String(owner), owner: { id: owner } }, populate: ['package'] });
    if (!d && create) d = await q('draft').create({ data: { ownerKey: String(owner), owner, payload: {} } });
    return d;
  }
  function parsePeople(value: any, pkg: any, fileAssets: Map<string, any>) {
    if (!Array.isArray(value) || value.length > 10) throw error(400, 'Karakter ve pet bilgilerini kontrol edin.');
    const people = value.map((person: any, index: number) => {
      fields(person, ['id', 'kind', 'description', 'outfit', 'pose', 'hair', 'accessories', 'appearance', 'distinctiveFeatures', 'fileKeys']);
      if (!['person', 'pet'].includes(person.kind)) throw error(400, 'Kişi veya pet türü geçersiz.');
      const fileKeys = Array.isArray(person.fileKeys) ? person.fileKeys.map((key: unknown) => idText(key)) : [];
      if (!fileKeys.length || fileKeys.length > 3) throw error(400, 'Her kişi ve pet için 1–3 referans fotoğrafı ekleyin.');
      for (const key of fileKeys) if (!fileAssets.has(key)) throw error(400, 'Bir veya daha fazla referans fotoğrafı yüklenmemiş.');
      return {
        id: text(person.id || `item-${index + 1}`, 40, true), kind: person.kind,
        description: text(person.description || '', 600),
        ...(person.kind === 'person' ? { outfit: text(person.outfit || '', 300), pose: text(person.pose || '', 300), hair: text(person.hair || '', 300), accessories: text(person.accessories || '', 500) }
          : { appearance: text(person.appearance || '', 400), distinctiveFeatures: text(person.distinctiveFeatures || '', 400), pose: text(person.pose || '', 300) }),
        fileKeys,
      };
    });
    const characters = people.filter((x: any) => x.kind === 'person').length, pets = people.length - characters;
    if (pkg.style === 'custom') {
      if (characters < 1 || characters > 6 || pets > 6) throw error(400, 'Özel talep için kişi/pet adetlerini kontrol edin.');
    } else if (characters !== pkg.characters || pets !== pkg.pets) throw error(400, 'Seçilen paket ile kişi/pet adetleri uyuşmuyor. Paket bilgilerinizi kontrol edin.');
    return { people, fileKeys: people.flatMap((x: any) => x.fileKeys), characters, pets };
  }
  async function ownedAsset(owner: number, draft: any, fileKey: string) {
    const asset = await q('private-asset').findOne({ where: { assetKey: fileKey, owner: { id: owner }, draft: { id: draft.id } } });
    if (asset) return asset;
    const session = await q('upload-session').findOne({ where: { fileKey, owner: { id: owner }, draft: { id: draft.id }, completedAt: { $notNull: true } } });
    return session?.asset ? q('private-asset').findOne({ where: { id: session.asset.id, owner: { id: owner }, draft: { id: draft.id } } }) : null;
  }
  async function saveDraft(owner: number, input: any) {
    fields(input, ['packageId', 'payload']);
    const p = await getPackage(idText(input.packageId));
    const payload = input.payload;
    fields(payload, ['style', 'people', 'base', 'plinthText', 'note', 'contactPreference', 'phone', 'fullName', 'consent', 'privacyVersion', 'declaredFileKeys']);
    if (!['color', 'monochrome'].includes(payload.style)) throw error(400, 'Renk tercihi geçersiz.');
    const draft = await getDraft(owner, true);
    await q('draft').update({ where: { id: draft.id, owner: { id: owner } }, data: { package: p.id, payload } });
    return { saved: true, packageId: p.documentId };
  }
  async function signUpload(owner: number, input: any) {
    fields(input, ['fileKey', 'name', 'mime', 'size']);
    const fileKey = idText(input.fileKey), name = text(input.name || '', 180);
    if (/[\\/\u0000-\u001f]/.test(name)) throw error(400, 'Dosya adı geçersiz.');
    const mime = text(input.mime, 100, true), size = Number(input.size), limits = storage.limits();
    if (!Number.isSafeInteger(size) || size < 1 || size > limits.fileBytes) throw error(413, 'Her dosya en fazla 10 MB olabilir.');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) throw error(415, 'JPEG, PNG veya WebP yükleyin. HEIC dosyalarını burada doğrulayamıyoruz; JPEG/PNG seçin.');
    const draft = await getDraft(owner); if (!draft) throw error(409, 'Önce taslağı kaydedin.');
    const declared = draft.payload?.declaredFileKeys;
    if (!Array.isArray(declared) || !declared.includes(fileKey)) throw error(403, 'Bu dosya taslağa ait değil.');
    const count = await q('private-asset').count({ where: { owner: { id: owner }, draft: { id: draft.id } } });
    const active = await q('upload-session').count({ where: { owner: { id: owner }, draft: { id: draft.id }, completedAt: null, expiresAt: { $gt: iso() } } });
    const total = await q('private-asset').findMany({ where: { owner: { id: owner }, draft: { id: draft.id } }, select: ['size'] });
    const pending = await q('upload-session').findMany({ where: { owner: { id: owner }, draft: { id: draft.id }, completedAt: null, expiresAt: { $gt: iso() } }, select: ['declaredSize'] });
    if (count + active >= limits.files) throw error(413, `Talep başına en fazla ${limits.files} fotoğraf yüklenebilir.`);
    if ([...total.map((x: any) => x.size), ...pending.map((x: any) => x.declaredSize)].reduce((n: number, x: number) => n + x, size) > limits.totalBytes) throw error(413, 'Fotoğrafların toplamı en fazla 50 MB olabilir.');
    const existingAsset = await q('private-asset').findOne({ where: { assetKey: fileKey, owner: { id: owner }, draft: { id: draft.id } } });
    if (existingAsset) return { alreadyUploaded: true, fileKey };
    const token = randomToken(), objectKey = `quarantine/${crypto.randomUUID()}`;
    const session = await q('upload-session').create({ data: { tokenHash: digest(token), objectKey, draftKey: String(draft.id), fileKey, declaredMime: mime, declaredSize: size, expiresAt: iso(Date.now() + 5 * 60000), owner, draft: draft.id } });
    const signed = await storage.signPut(objectKey, mime, size, token);
    if (signed.local) signed.url = `${strapiPublic()}/api/figurine/private-upload/${session.documentId}`;
    return { uploadSessionId: session.documentId, uploadUrl: signed.url, method: signed.method, headers: signed.headers, expiresIn: signed.expiresIn, local: signed.local };
  }
  async function completeUpload(owner: number, input: any) {
    fields(input, ['uploadSessionId']);
    const session = await q('upload-session').findOne({ where: { documentId: idText(input.uploadSessionId), owner: { id: owner } }, populate: ['draft', 'asset'] });
    if (!session || !session.draft) throw error(404, 'Yükleme oturumu bulunamadı.');
    if (session.asset && session.completedAt) {
      try { await storage.delete(session.objectKey); await q('upload-session').update({ where: { id: session.id, owner: { id: owner } }, data: { quarantineRemovedAt: iso() } }); }
      catch { strapi.log.error('[figurine] quarantine cleanup deferred'); }
      return { fileKey: session.fileKey, width: session.asset.width, height: session.asset.height, mime: session.asset.mime };
    }
    if (Date.parse(session.expiresAt) <= Date.now()) throw error(410, 'Yükleme bağlantısının süresi doldu; yeniden deneyin.');
    try {
      const head = await storage.head(session.objectKey), limits = storage.limits();
      if (head.size !== session.declaredSize || head.size > limits.fileBytes) throw error(400, 'Yüklenen dosyanın boyutu doğrulanamadı.');
      if (!storage.isLocal() && digest(head.metadata?.['upload-token'] || '') !== session.tokenHash) throw error(403, 'Yükleme sahipliği doğrulanamadı.');
      const bytes = await storage.read(session.objectKey);
      if (bytes.length !== session.declaredSize) throw error(400, 'Yüklenen dosya eksik veya bozuk.');
      const image = sharp(bytes, { limitInputPixels: limits.maxPixels, failOn: 'error' });
      const meta = await image.metadata();
      if (!['jpeg', 'png', 'webp'].includes(meta.format || '') || !meta.width || !meta.height || meta.width * meta.height > limits.maxPixels || Math.max(meta.width, meta.height) > 12000) throw error(415, 'Dosya geçerli bir JPEG, PNG veya WebP görüntüsü değil ya da piksel sınırını aşıyor.');
      const derived = await image.rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).webp({ quality: 84, effort: 4 }).toBuffer();
      const outputMeta = await sharp(derived).metadata();
      const key = `assets/${crypto.randomUUID()}.webp`;
      await storage.put(key, derived);
      const asset = await q('private-asset').create({ data: { assetKey: session.fileKey, objectKey: key, mime: 'image/webp', size: derived.length, width: outputMeta.width, height: outputMeta.height, originalSize: bytes.length, sha256: crypto.createHash('sha256').update(derived).digest('hex'), owner, draft: session.draft.id } });
      await q('upload-session').update({ where: { id: session.id, owner: { id: owner } }, data: { asset: asset.id, completedAt: iso() } });
      try { await storage.delete(session.objectKey); await q('upload-session').update({ where: { id: session.id, owner: { id: owner } }, data: { quarantineRemovedAt: iso() } }); }
      catch { strapi.log.error('[figurine] quarantine cleanup deferred'); }
      return { fileKey: session.fileKey, width: asset.width, height: asset.height, mime: asset.mime };
    } catch (e: any) {
      if (e instanceof CustomerError) throw e;
      if (process.env.NODE_ENV === 'test') console.error('Figurine image validation test diagnostic:', e?.message || 'unknown');
      throw error(400, 'Görüntü okunamadı. JPEG, PNG veya WebP biçiminde yeniden deneyin.');
    }
  }
  async function submit(owner: number, input: any, user: any, profile: any) {
    fields(input, ['requestKey', 'packageId', 'payload']);
    const requestKey = text(input.requestKey, 80, true);
    if (!/^[A-Za-z0-9_-]{24,80}$/.test(requestKey)) throw error(400, 'Talep anahtarı geçersiz.');
    const previous = await q('request').findOne({ where: { requestKey, owner: { id: owner } } });
    if (previous) return safeRequest(previous);
    const draft = await getDraft(owner); if (!draft) throw error(409, 'Talep taslağı bulunamadı.');
    const p = await getPackage(idText(input.packageId));
    if (String(draft.package?.id) !== String(p.id)) throw error(409, 'Paket seçimi değişti. Bilgilerinizi gözden geçirip tekrar kaydedin.');
    const payload = input.payload; fields(payload, ['style', 'people', 'base', 'plinthText', 'note', 'contactPreference', 'phone', 'fullName', 'consent', 'privacyVersion', 'declaredFileKeys']);
    const settings = await strapi.db.query('api::figurine-settings.figurine-settings').findOne({});
    if (!settings?.privacyNotice?.trim() || !settings?.privacyVersion?.trim()) throw error(503, 'Talep ve fotoğraf bilgilendirmesi henüz yayıma hazır değil. Lütfen daha sonra deneyin.');
    if (payload.consent !== true || payload.privacyVersion !== settings.privacyVersion) throw error(400, 'Güncel bilgilendirmeyi inceleyip onaylayın.');
    if (!['color', 'monochrome'].includes(payload.style)) throw error(400, 'Renk tercihini seçin.');
    if ((p.style === 'color' && payload.style !== 'color') || (p.style === 'monochrome' && payload.style !== 'monochrome')) throw error(400, 'Paket ve renk tercihi uyuşmuyor.');
    const declaredKeys = new Set<string>(Array.isArray(payload.declaredFileKeys) ? payload.declaredFileKeys.map((key: unknown) => idText(key)) : []);
    const payloadKeys = new Map<string, boolean>(Array.from(declaredKeys).map(key => [key, true]));
    const people = parsePeople(payload.people, p, payloadKeys);
    if (people.fileKeys.some((key: string) => !declaredKeys.has(key))) throw error(400, 'Fotoğraf eşleşmesi taslakla uyuşmuyor.');
    const assets = [];
    const seen = new Set<string>();
    for (const key of people.fileKeys) {
      if (seen.has(key)) throw error(400, 'Aynı fotoğraf birden fazla öğeye eklenmiş.');
      seen.add(key);
      const asset = await ownedAsset(owner, draft, key);
      if (!asset) throw error(403, 'Bir veya daha fazla fotoğraf bu hesaba ait değil veya yüklemesi tamamlanmadı.');
      assets.push(asset);
    }
    const allAssets = await q('private-asset').findMany({ where: { owner: { id: owner }, draft: { id: draft.id } }, select: ['assetKey'] });
    if (allAssets.length !== assets.length || assets.length > storage.limits().files) throw error(400, 'Taslakta kullanılmayan fotoğraf var. Fotoğrafları formdaki kişi/pet ile eşleştirin.');
    const contactPreference = payload.contactPreference;
    if (!['email', 'whatsapp'].includes(contactPreference)) throw error(400, 'İletişim tercihini seçin.');
    const phone = text(payload.phone || profile.phone || '', 30);
    if (contactPreference === 'whatsapp' && !/^\+?[0-9()\s-]{7,30}$/.test(phone)) throw error(400, 'WhatsApp için telefon numarası gereklidir.');
    const fullName = text(payload.fullName || profile.fullName || '', 100, true);
    const packageInfo = packageSnapshot(p);
    const details = { style: payload.style, package: packageInfo, characters: people.characters, pets: people.pets,
      people: people.people.map((person: any) => ({ ...person, photos: person.fileKeys })), base: text(payload.base || '', 400),
      plinthText: text(payload.plinthText || '', 100), note: text(payload.note || '', 2000), fullName,
      verifiedEmail: user.email, contactPreference, phone: contactPreference === 'whatsapp' ? phone : '' };
    const reqNo = `KF-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const url = new URL(`/hesap/figur-talepleri`, process.env.CUSTOMER_PUBLIC_ORIGIN).toString();
    const payloadMail = { subject: `Kişiye Özel Figür talebi ${reqNo}`, text: `Yeni talep kaydedildi. Detayları görüntülemek için müşteri hesabına giriş yapın: ${url}` };
    try {
      return await strapi.db.transaction(async ({ trx }: any) => {
        const request = await q('request').create({ data: { requestNumber: reqNo, requestKey, status: 'received', customerStatusText: 'Talep alındı', details,
          contactPreference, privacyNoticeVersion: settings.privacyVersion, privacyNoticeAcceptedAt: iso(), owner, package: p.id, assets: assets.map((a: any) => a.id) }, transacting: trx });
        for (const asset of assets) await q('private-asset').update({ where: { id: asset.id, owner: { id: owner } }, data: { request: request.id }, transacting: trx });
        const outbox = await q('outbox').create({ data: { eventKey: `figurine-request:${request.id}:received`, recipient: user.email, encryptedPayload: seal(payloadMail), status: 'pending', attempts: 0,
          nextAttemptAt: iso(), request: request.id }, transacting: trx });
        if (!outbox) throw new Error('Figurine notification outbox unavailable');
        await queueBusinessFigurine(strapi, trx, request);
        await q('draft').delete({ where: { id: draft.id, owner: { id: owner } }, transacting: trx });
        return safeRequest(request);
      });
    } catch (e: any) {
      const duplicate = await q('request').findOne({ where: { requestKey, owner: { id: owner } } });
      if (duplicate) return safeRequest(duplicate);
      throw e;
    }
  }
  function safeRequest(req: any) {
    return { requestId: req.documentId, requestNumber: req.requestNumber, status: req.customerStatusText || 'Talep alındı', createdAt: req.createdAt,
      package: req.details?.package || null, details: req.details, message: 'Talebiniz kaydedildi. Üretim, teslimat ve diğer ayrıntılar WhatsApp veya e-posta üzerinden netleştirilecek.' };
  }
  async function list(owner: number) {
    const requests = await q('request').findMany({ where: { owner: { id: owner } }, orderBy: { createdAt: 'desc' }, limit: 100 });
    return { requests: requests.map(safeRequest) };
  }
  async function detail(owner: number, input: any) {
    fields(input, ['id']);
    const req = await q('request').findOne({ where: { documentId: idText(input.id), owner: { id: owner } }, populate: ['assets'] });
    if (!req) throw error(404, 'Figür talebi bulunamadı.');
    return { request: safeRequest(req), photos: (req.assets || []).filter((asset: any) => !asset.deletedAt).map((asset: any) => ({ id: asset.assetKey })) };
  }
  async function adminList() {
    const requests = await q('request').findMany({ orderBy: { createdAt: 'desc' }, limit: 100, populate: ['owner', 'package', 'assets'] });
    return requests.map((r: any) => ({ id: r.documentId, requestNumber: r.requestNumber, status: r.customerStatusText, createdAt: r.createdAt,
      customerEmail: r.owner?.email, customerName: r.details?.fullName, package: r.details?.package, details: r.details,
      photos: (r.assets || []).filter((asset: any) => !asset.deletedAt).map((asset: any) => ({ id: asset.assetKey, width: asset.width, height: asset.height })) }));
  }
  async function adminOutbox(admin: any) {
    await checkAdmin(admin);
    const jobs = await q('outbox').findMany({ orderBy: { createdAt: 'desc' }, limit: 100, populate: ['request', 'order'] });
    return jobs.map((job: any) => ({ id: job.documentId, audience: job.audience || 'customer', requestNumber: job.request?.requestNumber || null, orderNumber: job.order?.orderNumber || null, status: job.status,
      attempts: job.attempts, lastErrorCode: job.lastErrorCode || null, nextAttemptAt: job.nextAttemptAt, createdAt: job.createdAt }));
  }
  async function retryOutbox(admin: any, id: string) {
    await checkAdmin(admin);
    const job = await q('outbox').findOne({ where: { documentId: idText(id) } });
    if (!job || job.status === 'sent' || !job.encryptedPayload) throw error(404, 'Yeniden denenebilir bildirim bulunamadı.');
    await q('outbox').update({ where: { id: job.id }, data: { status: 'pending', attempts: 0, nextAttemptAt: iso(), lockUntil: null, lastErrorCode: null } });
    strapi.log.info(`[figurine] notification manually queued by admin ${admin.id}`);
    return { queued: true };
  }
  async function checkAdmin(admin: any, capability = 'review') {
    if (!admin?.id) throw error(403, 'Bu işlem için yetkiniz yok.');
    const current = await strapi.db.query('admin::user').findOne({ where: { id: admin.id }, populate: ['roles'] });
    const envName: Record<string, string> = { review: 'FIGURINE_REVIEW_ROLE_NAMES', photo: 'FIGURINE_PHOTO_ROLE_NAMES' };
    const allowed = (process.env[envName[capability] || ''] || process.env.FIGURINE_ADMIN_ROLE_NAMES || 'Super Admin,Editor').split(',').map((x: string) => x.trim()).filter(Boolean);
    if (!current?.roles?.some((r: any) => allowed.includes(r.name))) throw error(403, 'Bu işlem için yetkiniz yok.');
    return current;
  }
  async function adminPhoto(requestDocumentId: string, assetKey: string) {
    const req = await q('request').findOne({ where: { documentId: idText(requestDocumentId) }, populate: ['assets'] });
    const asset = (req?.assets || []).find((a: any) => a.assetKey === assetKey && !a.deletedAt);
    if (!asset) throw error(404, 'Fotoğraf bulunamadı.');
    return storage.read(asset.objectKey);
  }
  async function seedDefaults() {
    const defaults = [
      { key: 'color-one-character', title: 'Renkli tek karakter', description: 'Tek kişiye özel renkli karakter figürü.', style: 'color', characters: 1, pets: 0, startingPrice: 2000, showPrice: true, sortOrder: 10, active: true },
      { key: 'color-character-pet', title: 'Renkli karakter + pet', description: 'Bir karakter ve bir pet için renkli kişiselleştirme.', style: 'color', characters: 1, pets: 1, startingPrice: 2500, showPrice: true, sortOrder: 20, active: true },
      { key: 'color-two-characters', title: 'Renkli çift karakter', description: 'İki karakter için renkli kişiselleştirme.', style: 'color', characters: 2, pets: 0, startingPrice: 3000, showPrice: true, sortOrder: 30, active: true },
      { key: 'monochrome-one-character', title: 'Beyaz/tek renk karakter', description: 'Bir karakter için beyaz veya tek renk seçeneği.', style: 'monochrome', characters: 1, pets: 0, startingPrice: null, showPrice: false, sortOrder: 40, active: true },
      { key: 'monochrome-character-pet', title: 'Beyaz/tek renk karakter + pet', description: 'Bir karakter ve bir pet için beyaz veya tek renk seçeneği.', style: 'monochrome', characters: 1, pets: 1, startingPrice: null, showPrice: false, sortOrder: 50, active: true },
      { key: 'monochrome-two-characters', title: 'Beyaz/tek renk çift karakter', description: 'İki karakter için beyaz veya tek renk seçeneği.', style: 'monochrome', characters: 2, pets: 0, startingPrice: null, showPrice: false, sortOrder: 60, active: true },
      { key: 'custom-request', title: 'Özel talep', description: 'Farklı kişi/pet adetleri. Fiyat talep sonrasında netleştirilir.', style: 'custom', characters: 0, pets: 0, startingPrice: null, showPrice: false, sortOrder: 70, active: true },
    ];
    for (const item of defaults) if (!await strapi.db.query(pkgUid).findOne({ where: { key: item.key } })) await strapi.db.query(pkgUid).create({ data: item });
  }
  async function localPut(id: string, token: string, bytes: Buffer) {
    const session = await q('upload-session').findOne({ where: { documentId: id } });
    if (!session || session.completedAt || Date.parse(session.expiresAt) <= Date.now() || !equal(session.tokenHash, digest(token))) throw error(404, 'Yükleme oturumu bulunamadı veya süresi doldu.');
    const limits = storage.limits();
    if (bytes.length !== session.declaredSize || bytes.length > limits.fileBytes) throw error(413, 'Dosya boyutu sınırı aşıldı.');
    await storage.verifyLocalPut(Buffer.from(session.objectKey).toString('base64url'), token, crypto.createHmac('sha256', process.env.CUSTOMER_BFF_SECRET || '').update(`put:${Buffer.from(session.objectKey).toString('base64url')}:${token}`).digest('base64url'), bytes);
    return { uploaded: true };
  }
  const photoPolicyVersion = 'figurine-photo-retention-v1-2026-10-03';
  async function retentionRecord(jobKey: string, category: string, policyVersion: string, status: string, data: any = {}) {
    const jobs = strapi.db.query('api::retention-job.retention-job');
    const row = await jobs.findOne({ where: { jobKey } });
    const values = { category, policyVersion, status, targetKey: data.targetKey || jobKey,
      attempts: (row?.attempts || 0) + (status === 'failed' ? 1 : 0), ...data };
    if (row) return jobs.update({ where: { id: row.id }, data: values });
    return jobs.create({ data: { jobKey, ...values } });
  }
  async function deleteRequestPhotos(request: any, executedBy: string) {
    const jobKey = `retention:completed-request-photo:${request.documentId}`;
    const due = Date.parse(request.photoRetentionDueAt || '');
    if (!Number.isFinite(due) || due > Date.now() || !request.photoRetentionStartedAt || !request.photoRetentionBasis) throw error(409, 'Talebin doğrulanmış saklama başlangıcı yok veya süre henüz dolmadı.');
    if (request.photosDeletedAt) {
      await retentionRecord(jobKey, 'completed-request-photo', photoPolicyVersion, 'completed', { targetKey: request.documentId, executedBy, result: { deleted: true, repeated: true } });
      return { status: 'completed', repeated: true };
    }
    await retentionRecord(jobKey, 'completed-request-photo', photoPolicyVersion, 'processing', { targetKey: request.documentId, executedBy, executedAt: iso() });
    try {
      const assets = await q('private-asset').findMany({ where: { request: { id: request.id } }, limit: 50 });
      for (const asset of assets) {
        // A tombstoned asset is still deleted again. This makes a restore of an
        // older object archive converge back to the deletion ledger.
        await storage.delete(asset.objectKey);
        if (!asset.deletedAt) await q('private-asset').update({ where: { id: asset.id }, data: { deletedAt: iso(), deletionPolicyVersion: photoPolicyVersion, deletionJobKey: jobKey } });
      }
      const deletedAt = iso();
      await q('request').update({ where: { id: request.id }, data: { photosDeletedAt: deletedAt } });
      await retentionRecord(jobKey, 'completed-request-photo', photoPolicyVersion, 'completed', { targetKey: request.documentId, executedBy, executedAt: deletedAt, lastErrorCode: null, result: { deleted: true, assetCount: assets.length } });
      return { status: 'completed', repeated: false };
    } catch {
      await retentionRecord(jobKey, 'completed-request-photo', photoPolicyVersion, 'failed', { targetKey: request.documentId, executedBy, lastErrorCode: 'STORAGE_OR_DB_DELETE_FAILED' });
      strapi.log.error('[retention] request photo deletion failed');
      throw error(503, 'Fotoğraf silme tamamlanamadı; güvenli biçimde yeniden denenebilir.');
    }
  }
  return {
    async run(operation: string, input: any, auth: any) {
      if (operation === 'figurine-packages') {
        fields(input, []);
        const packages = await strapi.db.query(pkgUid).findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' }, populate: ['gallery'] });
        const settings = await strapi.db.query('api::figurine-settings.figurine-settings').findOne({});
        const privacyNotice = settings?.privacyNotice || '', privacyVersion = settings?.privacyVersion || '';
        return { packages: packages.map(publicPackage), privacyNotice, privacyVersion, priceScopeNote: settings?.priceScopeNote || '', customerContactNote: settings?.customerContactNote || '', limits: storage.limits(), heicSupported: false,
          submissionEnabled: process.env.FIGURINE_REQUESTS_ENABLED === 'true' && packages.length > 0 && Boolean(privacyNotice.trim() && privacyVersion.trim()) && storage.isReady() };
      }
      const owner = auth.user.id;
      if (operation === 'figurine-draft') return saveDraft(owner, input);
      if (operation === 'figurine-upload-sign') return signUpload(owner, input);
      if (operation === 'figurine-upload-complete') return completeUpload(owner, input);
      if (operation === 'figurine-submit') return submit(owner, input, auth.user, auth.profile);
      if (operation === 'figurine-requests') { fields(input, []); return list(owner); }
      if (operation === 'figurine-request') return detail(owner, input);
      throw error(404, 'İşlem bulunamadı.');
    },
    async seedDefaults() { return seedDefaults(); },
    async localPut(id: string, token: string, bytes: Buffer) { return localPut(id, token, bytes); },
    async adminList(admin: any) {
      await checkAdmin(admin, 'review');
      return adminList();
    },
    async adminOutbox(admin: any) { return adminOutbox(admin); },
    async retryOutbox(admin: any, id: string) { return retryOutbox(admin, id); },
    async adminPhoto(admin: any, requestId: string, assetKey: string) {
      await checkAdmin(admin, 'photo');
      const request = await q('request').findOne({ where: { documentId: idText(requestId) }, populate: ['assets'] });
      const asset = (request?.assets || []).find((a: any) => a.assetKey === assetKey && !a.deletedAt);
      if (!asset) throw error(404, 'Fotoğraf bulunamadı.');
      return storage.read(asset.objectKey);
    },
    async customerPhoto(owner: number, requestId: string, assetKey: string) {
      const request = await q('request').findOne({ where: { documentId: idText(requestId), owner: { id: owner } }, populate: ['assets'] });
      const asset = (request?.assets || []).find((item: any) => item.assetKey === idText(assetKey) && !item.deletedAt);
      if (!asset) throw error(404, 'Fotoğraf bulunamadı.');
      return storage.read(asset.objectKey);
    },
    async cleanup() {
      const configuredHours = Number(process.env.FIGURINE_TEMP_UPLOAD_RETENTION_HOURS || 0);
      const expired = await q('upload-session').findMany({ where: { $or: [
        ...(Number.isSafeInteger(configuredHours) && configuredHours > 0 ? [{ createdAt: { $lt: iso(Date.now() - configuredHours * 3600000) }, completedAt: null }] : []),
        { expiresAt: { $lt: iso() }, completedAt: null },
        { completedAt: { $notNull: true }, quarantineRemovedAt: null },
      ] }, limit: 100 });
      for (const session of expired) {
        const jobKey = `temporary-upload:${session.documentId || session.id}`;
        const uploadPolicy = `hours:${configuredHours || 'signed-upload-ttl-5m'}`;
        await retentionRecord(jobKey, 'temporary-upload', uploadPolicy, 'processing');
        try {
          await storage.delete(session.objectKey);
          if (session.completedAt) await q('upload-session').update({ where: { id: session.id }, data: { quarantineRemovedAt: iso() } });
          else await q('upload-session').delete({ where: { id: session.id } });
          await retentionRecord(jobKey, 'temporary-upload', uploadPolicy, 'completed');
        }
        catch { await retentionRecord(jobKey, 'temporary-upload', uploadPolicy, 'failed', { lastErrorCode: 'STORAGE_OR_DB_DELETE_FAILED' }); strapi.log.error('[figurine] expired upload cleanup failed'); }
      }
      const dueRequests = await q('request').findMany({ where: { photosDeletedAt: null, photoRetentionDueAt: { $lte: iso() } }, limit: 20 });
      for (const request of dueRequests) try { await deleteRequestPhotos(request, 'system:retention-worker'); } catch { /* generic error already recorded */ }
      // Reconcile tombstones after any object-store restore. No request/order or
      // accounting record is removed by this pass.
      const tombstones = await q('private-asset').findMany({ where: { deletedAt: { $notNull: true } }, limit: 100 });
      for (const asset of tombstones) try { await storage.delete(asset.objectKey); } catch { strapi.log.error('[retention] tombstone reconciliation failed'); }
    },
    async retentionPreview(admin: any) {
      await dataAdministrator(strapi, Number(admin?.id));
      const hours = Number(process.env.FIGURINE_TEMP_UPLOAD_RETENTION_HOURS || 0), days = Number(process.env.FIGURINE_UNSUBMITTED_DRAFT_RETENTION_DAYS || 0);
      const uploads = await q('upload-session').findMany({ where: { $or: [{ expiresAt: { $lt: iso() }, completedAt: null }, { completedAt: { $notNull: true }, quarantineRemovedAt: null }, ...(Number.isSafeInteger(hours) && hours > 0 ? [{ createdAt: { $lt: iso(Date.now()-hours*3600000) }, completedAt: null }] : [])] }, limit: 100 });
      const drafts = Number.isSafeInteger(days) && days > 0 ? await q('draft').findMany({ where: { updatedAt: { $lt: iso(Date.now()-days*86400000) } }, limit: 100 }) : [];
      const dueRequests = await q('request').findMany({ where: { photosDeletedAt: null, photoRetentionDueAt: { $lte: iso() } }, limit: 100 });
      const closedWithoutDate = await q('request').findMany({ where: { status: 'closed', closedAt: null, photosDeletedAt: null }, limit: 100 });
      const terminalWithoutDate = await strapi.db.query('api::order.order').findMany({ where: { figurineRequest: { id: { $notNull: true } }, $or: [
        { fulfillmentState: 'delivered', deliveredAt: null }, { fulfillmentState: 'cancelled', cancelledAt: null },
      ] }, populate: ['figurineRequest'], limit: 100 });
      return { dryRun: true, executionEnabled: process.env.CUSTOMER_RETENTION_EXECUTION_ENABLED === 'true', categories: [
        { category: 'temporary-upload', configured: true, count: uploads.length, candidates: uploads.map((x: any) => ({ id: x.documentId, createdAt: x.createdAt })) },
        { category: 'unsubmitted-draft', configured: days > 0, count: drafts.length, candidates: drafts.map((x: any) => ({ id: x.documentId, updatedAt: x.updatedAt })) },
        { category: 'completed-request-photo', configured: true, policyVersion: photoPolicyVersion, count: dueRequests.length,
          candidates: dueRequests.map((x: any) => ({ id: x.documentId, basis: x.photoRetentionBasis, retentionStartedAt: x.photoRetentionStartedAt, dueAt: x.photoRetentionDueAt })) },
        { category: 'photo-retention-review', configured: true, count: closedWithoutDate.length + terminalWithoutDate.length,
          candidates: [
            ...closedWithoutDate.map((x: any) => ({ id: x.documentId, reason: 'CLOSED_AT_UNKNOWN' })),
            ...terminalWithoutDate.map((x: any) => ({ id: x.figurineRequest?.documentId, reason: x.fulfillmentState === 'delivered' ? 'DELIVERED_AT_UNKNOWN' : 'CANCELLED_AT_UNKNOWN' })),
          ].filter((x: any) => x.id) },
        { category: 'account-data', configured: false, count: 0, skipped: 'Hukuki saklama ve yedek yaÅŸam dÃ¶ngÃ¼sÃ¼ belirlenmedi.' },
      ] };
    },
    async retentionExecute(admin: any, input: any) {
      const actor = await dataAdministrator(strapi, Number(admin?.id)); fields(input, ['category','targetId','confirmation']);
      if (process.env.CUSTOMER_RETENTION_EXECUTION_ENABLED !== 'true' || input.confirmation !== 'execute') throw error(403, 'Saklama iÅŸlemi kapalÄ± veya onay eksik.');
      const category = input.category, targetId = idText(input.targetId);
      const configDays = Number(process.env.FIGURINE_UNSUBMITTED_DRAFT_RETENTION_DAYS || 0);
      if (!['temporary-upload','unsubmitted-draft','completed-request-photo'].includes(category)) throw error(400, 'Bu veri sınıfı için silme işlemi tanımlı değil.');
      if (category === 'completed-request-photo') {
        const request = await q('request').findOne({ where: { documentId: targetId } });
        if (!request) throw error(404, 'Talep bulunamadı.');
        return deleteRequestPhotos(request, `admin:${actor.id}`);
      }
      const jobKey = `retention:${category}:${targetId}`, jobs = strapi.db.query('api::retention-job.retention-job');
      let job = await jobs.findOne({ where: { jobKey } });
      if (job?.status === 'completed') return { status: 'completed', repeated: true };
      if (!job) job = await jobs.create({ data: { jobKey, category, targetKey: targetId, status: 'processing', policyVersion: category === 'unsubmitted-draft' ? `days:${configDays}` : 'expired-upload-ttl', executedBy: String(actor.id), executedAt: iso() } });
      else job = await jobs.update({ where: { id: job.id }, data: { status: 'processing', executedBy: String(actor.id), executedAt: iso() } });
      try {
        if (category === 'temporary-upload') {
          const session = await q('upload-session').findOne({ where: { documentId: targetId } });
          const tempHours = Number(process.env.FIGURINE_TEMP_UPLOAD_RETENTION_HOURS || 0);
          const oldEnough = Date.parse(session?.expiresAt || '') <= Date.now() || Number.isSafeInteger(tempHours) && tempHours > 0 && Date.parse(session?.createdAt || '') <= Date.now()-tempHours*3600000;
          if (!session || (session.completedAt ? Boolean(session.quarantineRemovedAt) : !oldEnough)) throw error(409, 'YÃ¼kleme etkin veya silme adayÄ± deÄŸil.');
          await storage.delete(session.objectKey);
          if (session.completedAt) await q('upload-session').update({ where: { id: session.id }, data: { quarantineRemovedAt: iso() } }); else await q('upload-session').delete({ where: { id: session.id } });
        } else {
          if (!Number.isSafeInteger(configDays) || configDays < 1) throw error(409, 'Taslak saklama sÃ¼resi yapÄ±landÄ±rÄ±lmadÄ±.');
          const draft = await q('draft').findOne({ where: { documentId: targetId } });
          if (!draft || Date.parse(draft.updatedAt) > Date.now()-configDays*86400000 || draft.lockUntil && Date.parse(draft.lockUntil) > Date.now()) throw error(409, 'Taslak etkin, kilitli veya saklama sÃ¼resi dolmamÄ±ÅŸ.');
          const assets = await q('private-asset').findMany({ where: { draft: { id: draft.id } }, limit: 20 });
          if (assets.some((asset: any) => asset.request)) throw error(409, 'Talebe iliÅŸtirilmiÅŸ dosya silme adayÄ± deÄŸil.');
          for (const asset of assets) await storage.delete(asset.objectKey);
          for (const asset of assets) await q('private-asset').delete({ where: { id: asset.id } });
          await q('draft').delete({ where: { id: draft.id } });
        }
        await jobs.update({ where: { id: job.id }, data: { status: 'completed', result: { deleted: true }, lastErrorCode: null } });
        try { await strapi.db.query('api::operation-event.operation-event').create({ data: { actor: `admin:${actor.id}`, fromState: 'pending', toState: 'completed', details: { kind: 'retention-delete', category, targetId } } }); }
        catch { strapi.log.error('[retention] audit record write failed after completed deletion job'); }
        return { status: 'completed', repeated: false };
      } catch (e) {
        await jobs.update({ where: { id: job.id }, data: { status: 'failed', attempts: (job.attempts || 0)+1, lastErrorCode: e instanceof CustomerError ? `POLICY_${e.status}` : 'STORAGE_OR_DB_DELETE_FAILED' } });
        throw e;
      }
    },
    async flushOutbox() {
      const jobs = await q('outbox').findMany({ where: { status: { $in: ['pending', 'failed', 'processing'] }, attempts: { $lt: 8 }, nextAttemptAt: { $lte: iso() } }, limit: 20 });
      for (const job of jobs) {
        const lockUntil = iso(Date.now() + 30000), acquired = await db()(table('outbox')).where({ id: job.id }).andWhere(b => b.whereNull('lock_until').orWhere('lock_until', '<', new Date())).update({ lock_until: lockUntil, status: 'processing' });
        if (!acquired) continue;
        try {
          const payload = open(job.encryptedPayload);
          if (process.env.FIGURINE_MAIL_MODE === 'file' && process.env.NODE_ENV !== 'production') {
            const mailbox = path.resolve(process.cwd(), '.tmp/figurine-mail'); await fs.mkdir(mailbox, { recursive: true });
            await fs.writeFile(path.join(mailbox, `${job.id}.json`), JSON.stringify({ to: job.recipient, ...payload }), { mode: 0o600 });
          } else {
            const port = Number(process.env.CUSTOMER_SMTP_PORT || 465);
            const transport = require('nodemailer').createTransport({ host: process.env.CUSTOMER_SMTP_HOST, port, secure: port === 465,
              auth: { user: process.env.CUSTOMER_SMTP_USER, pass: process.env.CUSTOMER_SMTP_PASS }, requireTLS: port !== 465, connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000 });
            await transport.sendMail({ from: process.env.CUSTOMER_MAIL_FROM, to: job.recipient, ...payload });
          }
          await q('outbox').update({ where: { id: job.id }, data: { status: 'sent', encryptedPayload: '', attempts: job.attempts + 1, lockUntil: null, lastErrorCode: null } });
        } catch {
          const attempts = job.attempts + 1;
          await q('outbox').update({ where: { id: job.id }, data: { status: 'failed', attempts, lockUntil: null, nextAttemptAt: iso(Date.now() + Math.min(86400000, 60000 * 2 ** attempts)), lastErrorCode: 'delivery-failed' } });
          strapi.log.error('[figurine] notification delivery failed');
        }
      }
    },
  };
};
