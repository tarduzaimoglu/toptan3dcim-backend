import crypto from 'node:crypto';
import { CustomerError, digest, fields, iso, text, seal } from '../customer/security';
import { operator } from './authorization';
import operationsFactory from './operations';

const requestUid = 'api::figurine-request.figurine-request';
const offerUid = 'api::figurine-offer.figurine-offer';
const orderUid = 'api::order.order';
const responseUid = 'api::figurine-response.figurine-response';
const returnUid = 'api::figurine-return-request.figurine-return-request';
const outboxUid = 'api::figurine-outbox.figurine-outbox';
const eventUid = 'api::operation-event.operation-event';
const fail = (status: number, message: string) => new CustomerError(status, message);
const id = (value: unknown) => text(value, 100, true);

export default (strapi: any) => {
  const db = strapi.db;
  const requests = () => db.query(requestUid);
  const offers = () => db.query(offerUid);
  const orders = () => db.query(orderUid);
  const returns = () => db.query(returnUid);
  const responses = () => db.query(responseUid);
  const orderOps = operationsFactory(strapi);

  async function lockRequest(request: any, trx: any) {
    const table = db.metadata.get(requestUid).tableName;
    const result = await db.connection(table).transacting(trx).where({ id: request.id }).update({ updated_at: new Date() });
    if (!result) throw fail(409, 'Talep eşzamanlı olarak değişti. Yenileyip tekrar deneyin.');
    return requests().findOne({ where: { id: request.id, owner: { id: request.owner?.id } }, populate: ['owner'] });
  }
  async function customerRequest(owner: number, requestId: string, trx?: any) {
    const row = await requests().findOne({ where: { documentId: id(requestId), owner: { id: owner } }, populate: ['owner'] });
    if (!row) throw fail(404, 'Figür talebi bulunamadı.');
    return row;
  }
  const minor = (n: unknown, name: string, allowZero = true) => {
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < (allowZero ? 0 : 1) || n > 2147483647) throw fail(400, `${name} tutarı geçersiz.`);
    return n;
  };
  function normalizeScope(input: any, request: any) {
    fields(input, ['characters', 'pets', 'colorChoice', 'designDescription', 'includedParts', 'sizeDescription', 'standIncluded', 'boxIncluded', 'productionDeliveryNote']);
    const characters = Number(input.characters), pets = Number(input.pets);
    if (!Number.isInteger(characters) || characters !== request.details?.characters || !Number.isInteger(pets) || pets !== request.details?.pets) throw fail(400, 'Teklifteki kişi/pet adetleri talep ile eşleşmeli.');
    if (!['color', 'monochrome', 'custom'].includes(input.colorChoice)) throw fail(400, 'Renk kapsamını seçin.');
    if (!Array.isArray(input.includedParts) || input.includedParts.length < 1 || input.includedParts.length > 30) throw fail(400, 'Dahil olan parçaları açıkça belirtin.');
    const includedParts = input.includedParts.map((part: unknown) => text(part, 160, true));
    const boolOrNull = (v: unknown, label: string) => v === null || v === undefined ? null : typeof v === 'boolean' ? v : (() => { throw fail(400, `${label} bilgisi geçersiz.`); })();
    return {
      characters, pets, colorChoice: input.colorChoice,
      designDescription: text(input.designDescription, 3000, true), includedParts,
      sizeDescription: text(input.sizeDescription || '', 500), standIncluded: boolOrNull(input.standIncluded, 'Kaide'),
      boxIncluded: boolOrNull(input.boxIncluded, 'Kutu'), productionDeliveryNote: text(input.productionDeliveryNote || '', 1000),
    };
  }
  function publicOffer(offer: any) {
    if (!offer) return null;
    const expired = offer.validUntil && Date.parse(offer.validUntil) <= Date.now();
    return {
      id: offer.documentId, version: offer.version,
      state: expired && offer.state === 'offered' ? 'expired' : offer.state,
      scope: offer.scope, amountMinor: offer.amountMinor, taxMinor: offer.taxMinor,
      shippingMinor: offer.shippingMinor, totalMinor: offer.totalMinor, currency: offer.currency,
      taxShippingDisclosure: offer.taxShippingDisclosure, customerNote: offer.customerNote || '',
      validUntil: offer.validUntil || null, offeredAt: offer.offeredAt || null,
      acceptedAt: offer.acceptedAt || null,
      approvalInvalidatedAt: offer.approvalInvalidatedAt || null,
    };
  }
  async function latestOffers(requestIds: number[]) {
    if (!requestIds.length) return new Map();
    const rows = await offers().findMany({ where: { request: { id: { $in: requestIds } } }, orderBy: { version: 'desc' }, populate: ['request'] });
    const map = new Map<number, any[]>();
    for (const offer of rows) { const list = map.get(offer.request.id) || []; list.push(offer); map.set(offer.request.id, list); }
    return map;
  }
  async function putOutbox(trx: any, eventKey: string, recipient: string, subject: string, textBody: string, requestId: number | null) {
    const existing = await strapi.db.query(outboxUid).findOne({ where: { eventKey }, transacting: trx });
    if (existing) return existing;
    return strapi.db.query(outboxUid).create({ data: { eventKey, recipient, encryptedPayload: seal({ subject, text: textBody }), status: 'pending', attempts: 0,
      nextAttemptAt: iso(), ...(requestId ? { request: requestId } : {}) }, transacting: trx });
  }
  async function audit(trx: any, actor: string, requestId: number | null, orderId: number | null, from: string, to: string, details: any) {
    await db.query(eventUid).create({ data: { actor, fromState: from, toState: to, details,
      ...(requestId ? { figurineRequest: requestId } : {}), ...(orderId ? { order: orderId } : {}) }, transacting: trx });
  }
  async function customerDetail(owner: number, input: any) {
    fields(input, ['id']);
    const request = await customerRequest(owner, input.id);
    const versions = (await offers().findMany({ where: { request: { id: request.id }, state: { $ne: 'draft' } }, orderBy: { version: 'desc' } })).map(publicOffer);
    const photos = (await db.query('api::figurine-private-asset.figurine-private-asset').findMany({ where: { request: { id: request.id }, owner: { id: owner }, deletedAt: null }, select: ['assetKey'] })).map((a: any) => ({ id: a.assetKey }));
    const order = await orders().findOne({ where: { figurineRequest: { id: request.id }, user: { id: owner } } });
    const returnRows = order ? await returns().findMany({ where: { order: { id: order.id }, owner: { id: owner } }, orderBy: { createdAt: 'desc' } }) : [];
    return {
      paymentsEnabled: process.env.FIGURINE_PAYMENTS_ENABLED === 'true' && process.env.POSNET_BANK_VERIFIED === 'true',
      request: { requestId: request.documentId, requestNumber: request.requestNumber, status: request.customerStatusText || 'Talep alındı', createdAt: request.createdAt,
        package: request.details?.package || null, details: request.details, message: 'Üretim, teslimat ve diğer ayrıntılar teklif görüşmesi sırasında netleştirilir.' },
      photos, offers: versions,
      order: order ? { id: order.documentId, orderNumber: order.orderNumber, paymentState: order.paymentState || order.status, fulfillmentState: order.fulfillmentState || null,
        shippingCarrier: order.shippingCarrier || null, trackingNumber: order.trackingNumber || null, trackingUrl: order.trackingUrl || null,
        customerNote: order.fulfillmentCustomerNote || '', grandTotal: order.grandTotal, currency: order.currency,
        paymentAvailable: process.env.FIGURINE_PAYMENTS_ENABLED === 'true' && process.env.POSNET_BANK_VERIFIED === 'true' } : null,
      returnRequests: returnRows.map((r: any) => ({ id: r.documentId, reason: r.reason, state: r.state, customerNote: r.customerNote || '', decisionAt: r.decisionAt || null, createdAt: r.createdAt })),
    };
  }
  async function customerList(owner: number) {
    const rows = await requests().findMany({ where: { owner: { id: owner } }, orderBy: { createdAt: 'desc' }, limit: 100 });
    const byRequest = await latestOffers(rows.map((r: any) => r.id));
    return { requests: rows.map((r: any) => {
      const versions = byRequest.get(r.id) || [], current = versions.find((v: any) => ['offered', 'accepted'].includes(v.state));
      return { requestId: r.documentId, requestNumber: r.requestNumber, status: r.customerStatusText || 'Talep alındı', createdAt: r.createdAt,
        package: r.details?.package || null, offerState: current ? publicOffer(current).state : null };
    }) };
  }
  async function respond(owner: number, input: any, kind: 'accepted' | 'change-request') {
    fields(input, kind === 'accepted' ? ['requestId', 'offerId'] : ['requestId', 'offerId', 'comment', 'idempotencyKey']);
    const request = await customerRequest(owner, id(input.requestId));
    const comment = kind === 'change-request' ? text(input.comment, 2000, true) : '';
    const eventKey = kind === 'accepted' ? `offer:${id(input.offerId)}:customer-accepted` : `offer:${id(input.offerId)}:change:${text(input.idempotencyKey, 80, true)}`;
    if (kind === 'change-request' && !/^[A-Za-z0-9_-]{16,80}$/.test(input.idempotencyKey)) throw fail(400, 'İşlem anahtarı geçersiz.');
    const old = await db.query(responseUid).findOne({ where: { eventKey, owner: { id: owner } } });
    if (old) {
      const savedOffer = await offers().findOne({ where: { documentId: id(input.offerId), request: { id: request.id } } });
      if (kind === 'accepted' && (!savedOffer || savedOffer.state !== 'accepted' || savedOffer.approvalInvalidatedAt)) throw fail(409, 'Bu teklif onayı yeni sürüm nedeniyle artık geçerli değil.');
      return { state: old.kind, quoteVersion: old.quoteVersion, repeated: true };
    }
    return db.transaction(async ({ trx }: any) => {
      const locked = await lockRequest(request, trx);
      const offer = await offers().findOne({ where: { documentId: id(input.offerId), request: { id: request.id } }, transacting: trx });
      if (!offer) throw fail(404, 'Teklif bulunamadı.');
      if (kind === 'accepted' && offer.state === 'accepted' && !offer.approvalInvalidatedAt) return { state: 'accepted', quoteVersion: offer.version, repeated: true };
      if (offer.state !== 'offered' || offer.validUntil && Date.parse(offer.validUntil) <= Date.now()) throw fail(409, 'Bu teklif artık onaylanamaz. Güncel teklifi kontrol edin.');
      const newest = await offers().findOne({ where: { request: { id: request.id } }, orderBy: { version: 'desc' }, transacting: trx });
      if (newest?.id !== offer.id) throw fail(409, 'Bu teklif güncel değil.');
      await db.query(responseUid).create({ data: { eventKey, kind, comment, actor: `customer:${owner}`, quoteVersion: offer.version, quote: offer.id, request: request.id, owner }, transacting: trx });
      if (kind === 'accepted') {
        await offers().update({ where: { id: offer.id, state: 'offered' }, data: { state: 'accepted', acceptedAt: iso(), acceptedBy: owner }, transacting: trx });
        await requests().update({ where: { id: request.id }, data: { status: 'quoted', customerStatusText: 'Teklif onaylandı' }, transacting: trx });
      } else {
        await offers().update({ where: { id: offer.id, state: 'offered' }, data: { state: 'changes-requested' }, transacting: trx });
        await requests().update({ where: { id: request.id }, data: { status: 'change-requested', customerStatusText: 'Talep üzerinde değişiklik isteniyor' }, transacting: trx });
      }
      const origin = process.env.CUSTOMER_PUBLIC_ORIGIN || 'http://localhost:3000';
      await putOutbox(trx, `figurine-response:${eventKey}`, locked.owner.email, kind === 'accepted' ? 'Teklif onayınız alındı' : 'Değişiklik talebiniz alındı',
        `${request.requestNumber} numaralı talebiniz için yanıtınız kaydedildi. Ayrıntıları hesabınızdan görüntüleyin: ${new URL(`/hesap/figur-talepleri/${request.documentId}`, origin)}`, request.id);
      await audit(trx, `customer:${owner}`, request.id, null, offer.state, kind, { quoteVersion: offer.version });
      return { state: kind, quoteVersion: offer.version, repeated: false };
    });
  }
  function requestAddress(a: any) {
    if (!a || typeof a !== 'object') throw fail(400, 'Teslimat ve fatura adreslerini hesabınızdaki adreslerden seçin.');
    return Object.fromEntries(['fullName', 'phone', 'city', 'district', 'addressLine', 'postalCode'].map(k => [k, text(a[k] || '', k === 'addressLine' ? 500 : 160, ['city', 'district', 'addressLine'].includes(k))]));
  }
  async function convert(owner: number, input: any, auth: any) {
    fields(input, ['requestId', 'offerId', 'shippingAddressId', 'billingAddressId', 'contractAccepted']);
    if (input.contractAccepted !== true) throw fail(400, 'Satış koşullarını onaylayın.');
    const request = await customerRequest(owner, id(input.requestId));
    return db.transaction(async ({ trx }: any) => {
      const locked = await lockRequest(request, trx);
      const offer = await offers().findOne({ where: { documentId: id(input.offerId), request: { id: request.id } }, transacting: trx });
      if (!offer || offer.state !== 'accepted' || offer.approvalInvalidatedAt || offer.validUntil && Date.parse(offer.validUntil) <= Date.now()) throw fail(409, 'Güncel ve geçerli teklif onayı gerekli.');
      const existingOrder = await orders().findOne({ where: { figurineOfferKey: String(offer.id), user: { id: owner } }, transacting: trx });
      if (existingOrder) return { orderId: existingOrder.documentId, orderNumber: existingOrder.orderNumber, paymentState: existingOrder.paymentState || existingOrder.status, repeated: true };
      const addrQuery = db.query('api::customer-address.customer-address');
      const shipping = await addrQuery.findOne({ where: { documentId: id(input.shippingAddressId), owner: { id: owner } }, transacting: trx });
      if (!shipping) throw fail(404, 'Teslimat adresi bulunamadı.');
      const billing = input.billingAddressId ? await addrQuery.findOne({ where: { documentId: id(input.billingAddressId), owner: { id: owner } }, transacting: trx }) : shipping;
      if (!billing) throw fail(404, 'Fatura adresi bulunamadı.');
      const shippingSnapshot = requestAddress(shipping), billingSnapshot = requestAddress(billing);
      const phone = shippingSnapshot.phone || auth.profile.phone;
      if (!phone) throw fail(400, 'Profilinize veya teslimat adresinize telefon ekleyin.');
      const total = minor(offer.totalMinor, 'Toplam', false);
      if (minor(offer.amountMinor, 'Ürün') + minor(offer.taxMinor, 'Vergi') + minor(offer.shippingMinor, 'Kargo') !== total) throw fail(409, 'Teklif toplamı doğrulanamadı.');
      const snapshot = { requestNumber: locked.requestNumber, offerVersion: offer.version, scope: offer.scope, amountMinor: offer.amountMinor,
        taxMinor: offer.taxMinor, shippingMinor: offer.shippingMinor, totalMinor: total, currency: offer.currency, taxShippingDisclosure: offer.taxShippingDisclosure, customerNote: offer.customerNote || '' };
      const order = await strapi.documents(orderUid).create({ data: {
        orderNumber: `FIG-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
        status: 'pending', paymentState: 'pending', items: [{ productId: 'personalized-figurine', isim: `Kişiye Özel Figür · ${locked.requestNumber}`, adet: 1,
          birimFiyat: total, satirToplami: total, variant: null, figurineOfferVersion: offer.version }],
        subtotal: offer.amountMinor, discountTotal: 0, vatTotal: offer.taxMinor, shippingCost: offer.shippingMinor, grandTotal: total, currency: offer.currency,
        buyerName: shippingSnapshot.fullName || locked.details?.fullName, buyerEmail: locked.owner.email, buyerPhone: phone,
        shippingAddress: shippingSnapshot, billingAddress: billingSnapshot, contractAccepted: true, contractAcceptedAt: iso(), user: owner,
        figurineRequest: request.id, figurineOffer: offer.id, figurineOfferKey: String(offer.id), figurineSnapshot: snapshot,
      }, transacting: trx });
      await offers().update({ where: { id: offer.id, state: 'accepted', approvalInvalidatedAt: null }, data: { order: order.id }, transacting: trx });
      await requests().update({ where: { id: request.id }, data: { status: 'converted', customerStatusText: 'Sipariş oluşturuldu' }, transacting: trx });
      await audit(trx, `customer:${owner}`, request.id, order.id, 'accepted', 'order-created', { offerVersion: offer.version, orderNumber: order.orderNumber, totalMinor: total, currency: offer.currency });
      await putOutbox(trx, `figurine-order:${order.id}:created`, locked.owner.email, 'Figür siparişiniz oluşturuldu',
        `${order.orderNumber} numaralı siparişiniz oluşturuldu. Ödeme ve sipariş durumunu hesabınızdan görüntüleyin: ${new URL(`/hesap/figur-talepleri/${request.documentId}`, process.env.CUSTOMER_PUBLIC_ORIGIN || 'http://localhost:3000')}`, request.id);
      return { orderId: order.documentId, orderNumber: order.orderNumber, paymentState: order.paymentState, repeated: false };
    });
  }
  async function startPayment(owner: number, input: any) {
    fields(input, ['orderId']);
    if (process.env.FIGURINE_PAYMENTS_ENABLED !== 'true' || process.env.POSNET_BANK_VERIFIED !== 'true') throw fail(503, 'Bu ortamda figür siparişleri için çevrimiçi ödeme etkin değil. Ödeme sonucu varmış gibi gösterilmedi.');
    const order = await orders().findOne({ where: { documentId: id(input.orderId), user: { id: owner } }, populate: ['figurineOffer', 'figurineRequest'] });
    if (!order?.figurineOffer || !order.figurineRequest) throw fail(404, 'Figür siparişi bulunamadı.');
    const offer = await offers().findOne({ where: { id: order.figurineOffer.id, request: { id: order.figurineRequest.id } } });
    if (!offer || offer.state !== 'accepted' || offer.approvalInvalidatedAt || String(offer.id) !== order.figurineOfferKey) throw fail(409, 'Ödeme için teklif onayı artık geçerli değil.');
    if (order.status === 'paid' || order.paymentState === 'paid') return { paid: true, orderNumber: order.orderNumber };
    if (['unknown', 'creating', 'resolving', 'charging'].includes(order.paymentState)) throw fail(409, 'Ödeme sonucu doğrulanmadan yeni deneme başlatılamaz.');
    return strapi.service('api::payment.payment').startOrder(order);
  }
  async function submitReturn(owner: number, input: any) {
    fields(input, ['orderId', 'reason', 'idempotencyKey']);
    const key = text(input.idempotencyKey, 80, true);
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(key)) throw fail(400, 'İşlem anahtarı geçersiz.');
    const reason = text(input.reason, 3000, true);
    const previous = await returns().findOne({ where: { idempotencyKey: digest(`${owner}:${key}`), owner: { id: owner } } });
    if (previous) return { id: previous.documentId, state: previous.state, repeated: true };
    const order = await orders().findOne({ where: { documentId: id(input.orderId), user: { id: owner } }, populate: ['figurineRequest', 'user'] });
    if (!order) throw fail(404, 'Sipariş bulunamadı.');
    try {
      return await db.transaction(async ({ trx }: any) => {
        const row = await returns().create({ data: { idempotencyKey: digest(`${owner}:${key}`), reason, state: 'submitted', order: order.id, owner,
          ...(order.figurineRequest ? { request: order.figurineRequest.id } : {}) }, transacting: trx });
        const reqId = order.figurineRequest?.id || null;
        await audit(trx, `customer:${owner}`, reqId, order.id, '', 'return-request-submitted', { returnRequestId: row.documentId });
        await putOutbox(trx, `figurine-return:${row.id}:submitted`, order.buyerEmail, 'Sipariş başvurunuz alındı',
          `${order.orderNumber} için iptal/iade başvurunuz kaydedildi; sipariş veya ödeme otomatik değiştirilmedi. Başvurunuzu hesabınızdan takip edin: ${new URL(`/hesap/siparisler/${order.documentId}`, process.env.CUSTOMER_PUBLIC_ORIGIN || 'http://localhost:3000')}`, reqId);
        return { id: row.documentId, state: row.state, repeated: false };
      });
    } catch (e) {
      const duplicate = await returns().findOne({ where: { idempotencyKey: digest(`${owner}:${key}`) } });
      if (duplicate) return { id: duplicate.documentId, state: duplicate.state, repeated: true };
      throw e;
    }
  }
  async function customerReturns(owner: number) {
    const rows = await returns().findMany({ where: { owner: { id: owner } }, orderBy: { createdAt: 'desc' }, limit: 50, populate: ['order'] });
    return { returnRequests: rows.map((r: any) => ({ id: r.documentId, orderId: r.order?.documentId, orderNumber: r.order?.orderNumber, reason: r.reason, state: r.state, customerNote: r.customerNote || '', decisionAt: r.decisionAt || null, createdAt: r.createdAt })) };
  }

  async function checkAdmin(admin: any, capability: 'review' | 'quote' | 'operations' | 'photo' | 'refund') {
    const roleEnv: Record<string, string> = { review: 'FIGURINE_REVIEW_ROLE_NAMES', quote: 'FIGURINE_QUOTE_ROLE_NAMES', operations: 'FIGURINE_OPERATIONS_ROLE_NAMES', photo: 'FIGURINE_PHOTO_ROLE_NAMES', refund: 'FIGURINE_REVIEW_ROLE_NAMES' };
    const current = await db.query('admin::user').findOne({ where: { id: admin?.id, isActive: true }, populate: ['roles'] });
    const configured = process.env[roleEnv[capability]] ?? process.env.FIGURINE_ADMIN_ROLE_NAMES ?? '';
    if (!current?.roles?.some((r: any) => configured.split(',').map((v: string) => v.trim()).includes(r.name))) throw fail(403, 'Bu işlem için personel yetkiniz yok.');
    return current;
  }
  async function adminDetail(admin: any, requestId: string) {
    await checkAdmin(admin, 'review');
    const request = await requests().findOne({ where: { documentId: id(requestId) }, populate: ['owner', 'assets'] });
    if (!request) throw fail(404, 'Talep bulunamadı.');
    const [quotes, order, responseRows, returnRows] = await Promise.all([
      offers().findMany({ where: { request: { id: request.id } }, orderBy: { version: 'desc' } }),
      orders().findOne({ where: { figurineRequest: { id: request.id } } }),
      responses().findMany({ where: { request: { id: request.id } }, orderBy: { createdAt: 'desc' } }),
      returns().findMany({ where: { request: { id: request.id } }, orderBy: { createdAt: 'desc' }, populate: ['order'] }),
    ]);
    return {
      id: request.documentId, requestNumber: request.requestNumber, status: request.status, customerStatusText: request.customerStatusText || 'Talep alındı',
      createdAt: request.createdAt, customerEmail: request.owner?.email, customerName: request.details?.fullName, package: request.details?.package,
      details: request.details, internalNotes: request.internalNotes || '', photos: (request.assets || []).filter((a: any) => !a.deletedAt).map((a: any) => ({ id: a.assetKey, width: a.width, height: a.height })),
      offers: quotes.map((q: any) => ({ ...publicOffer(q), internalNote: q.internalNote || '' })),
      responses: responseRows.map((r: any) => ({ kind: r.kind, comment: r.comment || '', quoteVersion: r.quoteVersion, createdAt: r.createdAt })),
      order: order ? { id: order.documentId, orderNumber: order.orderNumber, status: order.status, paymentState: order.paymentState || order.status,
        fulfillmentState: order.fulfillmentState || 'unknown', shippingCarrier: order.shippingCarrier || '', trackingNumber: order.trackingNumber || '', trackingUrl: order.trackingUrl || '', customerNote: order.fulfillmentCustomerNote || '', internalNote: order.fulfillmentInternalNote || '' } : null,
      returns: returnRows.map((r: any) => ({ id: r.documentId, orderNumber: r.order?.orderNumber, reason: r.reason, state: r.state, customerNote: r.customerNote || '', staffNote: r.staffNote || '', createdAt: r.createdAt })),
    };
  }
  async function adminList(admin: any) {
    await checkAdmin(admin, 'review');
    const [rows, actionOrders, returnRows] = await Promise.all([
      requests().findMany({ orderBy: { updatedAt: 'desc' }, limit: 100, populate: ['owner'] }),
      orders().findMany({ where: { figurineRequest: { id: { $notNull: true } }, $or: [{ status: { $ne: 'paid' } }, { fulfillmentState: { $nin: ['delivered', 'cancelled'] } }] }, orderBy: { updatedAt: 'desc' }, limit: 100, populate: ['figurineRequest', 'user'] }),
      returns().findMany({ where: { state: { $in: ['submitted', 'reviewing'] } }, orderBy: { createdAt: 'asc' }, limit: 100, populate: ['request', 'order', 'owner'] }),
    ]);
    return { requests: rows.map((r: any) => ({ id: r.documentId, requestNumber: r.requestNumber, status: r.customerStatusText || 'Talep alındı', state: r.status,
      createdAt: r.createdAt, customerEmail: r.owner?.email, customerName: r.details?.fullName, package: r.details?.package })),
      orders: actionOrders.map((o: any) => ({ id: o.documentId, orderNumber: o.orderNumber, requestId: o.figurineRequest?.documentId, requestNumber: o.figurineRequest?.requestNumber,
        customerEmail: o.buyerEmail, paymentState: o.paymentState || o.status, fulfillmentState: o.fulfillmentState || 'unknown', updatedAt: o.updatedAt })),
      returnRequests: returnRows.map((r: any) => ({ id: r.documentId, orderNumber: r.order?.orderNumber, requestNumber: r.request?.requestNumber, customerEmail: r.owner?.email, state: r.state, createdAt: r.createdAt })) };
  }
  async function adminSaveOffer(admin: any, requestId: string, input: any, present: boolean) {
    const actor = await checkAdmin(admin, 'quote');
    fields(input, ['offerId', 'scope', 'amountMinor', 'taxMinor', 'shippingMinor', 'totalMinor', 'currency', 'taxShippingDisclosure', 'customerNote', 'internalNote', 'validUntil']);
    const request = await requests().findOne({ where: { documentId: id(requestId) }, populate: ['owner'] });
    if (!request) throw fail(404, 'Talep bulunamadı.');
    return db.transaction(async ({ trx }: any) => {
      const locked = await lockRequest(request, trx);
      const currentOrder = await orders().findOne({ where: { figurineRequest: { id: request.id } }, transacting: trx });
      if (currentOrder?.paymentState === 'paid' || currentOrder?.status === 'paid') throw fail(409, 'Ödenmiş siparişin teklifi değiştirilemez.');
      if (currentOrder) {
        const active = await db.query('api::payment-attempt.payment-attempt').findOne({ where: { order: { id: currentOrder.id }, state: { $in: ['creating', 'ready', 'resolving', 'charging', 'unknown'] } }, transacting: trx });
        if (active) throw fail(409, 'Aktif veya sonucu belirsiz ödeme uzlaştırılmadan teklif değiştirilemez.');
      }
      let quote = input.offerId ? await offers().findOne({ where: { documentId: id(input.offerId), request: { id: request.id } }, transacting: trx }) : null;
      if (quote && quote.state !== 'draft') throw fail(409, 'Sunulmuş teklif sürümleri değiştirilemez; yeni sürüm oluşturun.');
      const scope = normalizeScope(input.scope, locked);
      const amountMinor = minor(input.amountMinor, 'Teklif', false), taxMinor = minor(input.taxMinor, 'Vergi'), shippingMinor = minor(input.shippingMinor, 'Kargo');
      const totalMinor = minor(input.totalMinor, 'Ödenecek toplam', false);
      if (totalMinor !== amountMinor + taxMinor + shippingMinor) throw fail(400, 'Ödenecek toplam, teklif + vergi + kargo tutarlarıyla aynı olmalı.');
      if (input.currency !== 'TRY') throw fail(400, 'Posnet üzerinden yalnızca TRY teklifleri tahsil edilebilir.');
      const disclosure = text(input.taxShippingDisclosure, 1000, true);
      const validUntil = input.validUntil ? new Date(input.validUntil) : null;
      if (input.validUntil && (!Number.isFinite(validUntil!.getTime()) || validUntil!.getTime() <= Date.now() || validUntil!.getTime() > Date.now() + 90 * 86400000)) throw fail(400, 'Teklif geçerlilik tarihi gelecek 90 gün içinde olmalı.');
      const values = { scope, amountMinor, taxMinor, shippingMinor, totalMinor, currency: 'TRY', taxShippingDisclosure: disclosure,
        customerNote: text(input.customerNote || '', 3000), internalNote: text(input.internalNote || '', 3000), validUntil: validUntil?.toISOString() || null, createdByAdmin: String(actor.id) };
      if (!quote) {
        const latest = await offers().findOne({ where: { request: { id: request.id } }, orderBy: { version: 'desc' }, transacting: trx });
        quote = await offers().create({ data: { ...values, version: Number(latest?.version || 0) + 1, state: 'draft', request: request.id }, transacting: trx });
      } else quote = await offers().update({ where: { id: quote.id, request: { id: request.id }, state: 'draft' }, data: values, transacting: trx });
      if (present) {
        if (!disclosure.trim() || !totalMinor) throw fail(400, 'KDV/kargo kapsamı ve ödenecek toplam açıklanmadan teklif sunulamaz.');
        const previousVersions = await offers().findMany({ where: { request: { id: request.id }, id: { $ne: quote.id }, state: { $in: ['offered', 'accepted'] } }, transacting: trx });
        for (const previous of previousVersions) await offers().update({ where: { id: previous.id, state: previous.state }, data: { state: 'superseded', approvalInvalidatedAt: iso() }, transacting: trx });
        quote = await offers().update({ where: { id: quote.id, state: 'draft' }, data: { state: 'offered', offeredAt: iso() }, transacting: trx });
        await requests().update({ where: { id: request.id }, data: { status: 'waiting-customer', customerStatusText: 'Teklif yanıtı bekleniyor' }, transacting: trx });
        await putOutbox(trx, `figurine-offer:${quote.id}:presented`, locked.owner.email, `Figür talebiniz için teklif · ${locked.requestNumber}`,
          `Teklifiniz hesabınızda görüntülenmeye hazır. Lütfen giriş yapın: ${new URL(`/hesap/figur-talepleri/${request.documentId}`, process.env.CUSTOMER_PUBLIC_ORIGIN || 'http://localhost:3000')}`, request.id);
      }
      await audit(trx, `admin:${actor.id}`, request.id, currentOrder?.id || null, 'quote-draft', present ? 'quote-offered' : 'quote-draft-saved', { version: quote.version, amountMinor: quote.amountMinor, totalMinor: quote.totalMinor, currency: quote.currency });
      return publicOffer(quote);
    });
  }
  async function adminRequestUpdate(admin: any, requestId: string, input: any) {
    const actor = await checkAdmin(admin, 'review');
    fields(input, ['status', 'customerStatusText', 'internalNotes']);
    const request = await requests().findOne({ where: { documentId: id(requestId) }, populate: ['owner'] });
    if (!request) throw fail(404, 'Talep bulunamadı.');
    const allowed = ['received', 'reviewing', 'waiting-customer', 'closed'];
    if (!allowed.includes(input.status)) throw fail(400, 'Talep durumu geçersiz.');
    return db.transaction(async ({ trx }: any) => {
      const locked = await lockRequest(request, trx);
      const data: any = { status: input.status, customerStatusText: text(input.customerStatusText, 300, true), internalNotes: text(input.internalNotes || '', 5000) };
      if (input.status === 'closed' && request.status !== 'closed') {
        const linkedOrder = await orders().findOne({ where: { figurineRequest: { id: request.id } }, transacting: trx });
        if (linkedOrder && !['delivered', 'cancelled'].includes(linkedOrder.fulfillmentState)) throw fail(409, 'Aktif siparişe bağlı talep doğrudan kapatılamaz. Sipariş operasyon durumunu kullanın.');
        if (!linkedOrder) {
          const closedAt = iso();
          data.closedAt = closedAt;
          data.photoRetentionBasis = 'closed';
          data.photoRetentionStartedAt = closedAt;
          data.photoRetentionDueAt = iso(Date.parse(closedAt) + 30 * 86400000);
        }
      }
      await requests().update({ where: { id: request.id }, data, transacting: trx });
      await audit(trx, `admin:${actor.id}`, request.id, null, request.status, input.status, { customerStatusText: data.customerStatusText });
      const activeOffer = await offers().findOne({ where: { request: { id: request.id }, state: 'offered' }, orderBy: { version: 'desc' }, transacting: trx });
      if (activeOffer && locked.owner?.email && data.customerStatusText !== request.customerStatusText) await putOutbox(trx, `figurine-status:${request.id}:${digest(`${input.status}:${data.customerStatusText}`)}`,
        locked.owner.email, `Figür talebiniz güncellendi · ${request.requestNumber}`, `Talebinizin durumu güncellendi: ${data.customerStatusText}. Ayrıntılar için hesabınıza giriş yapın: ${new URL(`/hesap/figur-talepleri/${request.documentId}`, process.env.CUSTOMER_PUBLIC_ORIGIN || 'http://localhost:3000')}`, request.id);
      return { updated: true };
    });
  }
  async function adminWithdrawOffer(admin: any, requestId: string, offerId: string) {
    const actor = await checkAdmin(admin, 'quote');
    const request = await requests().findOne({ where: { documentId: id(requestId) }, populate: ['owner'] });
    if (!request) throw fail(404, 'Talep bulunamadı.');
    return db.transaction(async ({ trx }: any) => {
      const locked = await lockRequest(request, trx);
      const offer = await offers().findOne({ where: { documentId: id(offerId), request: { id: request.id } }, transacting: trx });
      if (!offer || !['offered', 'accepted'].includes(offer.state)) throw fail(409, 'Geri çekilebilecek güncel teklif yok.');
      const order = await orders().findOne({ where: { figurineOffer: { id: offer.id } }, transacting: trx });
      if (order?.status === 'paid' || order?.paymentState === 'paid') throw fail(409, 'Ödenmiş siparişin teklifi geri çekilemez.');
      if (order) {
        const active = await db.query('api::payment-attempt.payment-attempt').findOne({ where: { order: { id: order.id }, state: { $in: ['creating', 'ready', 'resolving', 'charging', 'unknown'] } }, transacting: trx });
        if (active) throw fail(409, 'Aktif veya sonucu belirsiz ödeme uzlaştırılmadan teklif geri çekilemez.');
      }
      await offers().update({ where: { id: offer.id, state: offer.state }, data: { state: 'withdrawn', ...(offer.state === 'accepted' ? { approvalInvalidatedAt: iso() } : {}) }, transacting: trx });
      await requests().update({ where: { id: request.id }, data: { status: 'reviewing', customerStatusText: 'Teklif güncelleniyor' }, transacting: trx });
      await putOutbox(trx, `figurine-offer:${offer.id}:withdrawn`, locked.owner.email, `Figür teklifiniz güncellenecek · ${request.requestNumber}`,
        `Teklif sürüm ${offer.version} geri çekildi; yeni sürüm hazır olduğunda hesabınızda görüntüleyebilirsiniz: ${new URL(`/hesap/figur-talepleri/${request.documentId}`, process.env.CUSTOMER_PUBLIC_ORIGIN || 'http://localhost:3000')}`, request.id);
      await audit(trx, `admin:${actor.id}`, request.id, order?.id || null, offer.state, 'withdrawn', { version: offer.version });
      return { withdrawn: true, version: offer.version };
    });
  }
  async function adminOperation(admin: any, orderId: string, input: any) {
    const actor = await checkAdmin(admin, 'operations');
    const order = await orders().findOne({ where: { documentId: id(orderId), figurineRequest: { id: { $notNull: true } } }, populate: ['figurineRequest'] });
    if (!order) throw fail(404, 'Figür siparişi bulunamadı.');
    fields(input, ['fulfillmentState', 'shippingCarrier', 'trackingNumber', 'trackingUrl', 'customerNote', 'internalNote']);
    const result = await orderOps.update(actor.id, orderId, { fulfillmentState: input.fulfillmentState, shippingCarrier: input.shippingCarrier, trackingNumber: input.trackingNumber, trackingUrl: input.trackingUrl });
    const fresh = await orders().findOne({ where: { id: order.id } });
    const notes: any = {};
    if (input.customerNote !== undefined) notes.fulfillmentCustomerNote = text(input.customerNote, 1000);
    if (input.internalNote !== undefined) notes.fulfillmentInternalNote = text(input.internalNote, 3000);
    if (Object.keys(notes).length) await orders().update({ where: { id: order.id }, data: notes });
    if ((fresh.fulfillmentState !== order.fulfillmentState || fresh.trackingNumber !== order.trackingNumber || notes.fulfillmentCustomerNote !== undefined) && order.buyerEmail) {
      const key = `figurine-order:${order.id}:operation:${digest(JSON.stringify([fresh.fulfillmentState, fresh.trackingNumber, notes.fulfillmentCustomerNote]))}`;
      await db.transaction(async ({ trx }: any) => {
        await putOutbox(trx, key, order.buyerEmail, `Sipariş durumunuz güncellendi · ${order.orderNumber}`,
          `Sipariş durumu: ${fresh.fulfillmentCustomerNote || fresh.fulfillmentState || 'Güncellendi'}${fresh.shippingCarrier ? ` · Kargo: ${fresh.shippingCarrier}` : ''}${fresh.trackingNumber ? ` · Takip no: ${fresh.trackingNumber}` : ''}. Ayrıntılar: ${new URL(`/hesap/siparisler/${order.documentId}`, process.env.CUSTOMER_PUBLIC_ORIGIN || 'http://localhost:3000')}`, order.figurineRequest.id);
        await audit(trx, `admin:${actor.id}`, order.figurineRequest.id, order.id, order.fulfillmentState || 'unknown', fresh.fulfillmentState || 'unknown', { shippingCarrier: fresh.shippingCarrier || '', trackingNumber: fresh.trackingNumber || '', noteChanged: notes.fulfillmentCustomerNote !== undefined });
      });
    }
    return result;
  }
  async function adminReturnList(admin: any) {
    await checkAdmin(admin, 'review');
    return returns().findMany({ where: { state: { $in: ['submitted', 'reviewing'] } }, orderBy: { createdAt: 'asc' }, limit: 100, populate: ['order', 'request', 'owner'] }).then((rows: any[]) => rows.map(r => ({ id: r.documentId, orderNumber: r.order?.orderNumber, requestNumber: r.request?.requestNumber, customerEmail: r.owner?.email, reason: r.reason, state: r.state, createdAt: r.createdAt })));
  }
  async function adminReturnDecision(admin: any, returnId: string, input: any) {
    const actor = await checkAdmin(admin, 'refund');
    fields(input, ['state', 'customerNote', 'staffNote']);
    if (!['reviewing', 'accepted', 'rejected'].includes(input.state)) throw fail(400, 'Başvuru kararı geçersiz.');
    const row = await returns().findOne({ where: { documentId: id(returnId) }, populate: ['owner', 'order', 'request'] });
    if (!row) throw fail(404, 'Başvuru bulunamadı.');
    if (['accepted', 'rejected'].includes(row.state)) throw fail(409, 'Karar verilmiş başvuru değiştirilemez.');
    return db.transaction(async ({ trx }: any) => {
      const data = { state: input.state, customerNote: text(input.customerNote || '', 1000), staffNote: text(input.staffNote || '', 3000), actor: `admin:${actor.id}`, ...(input.state === 'reviewing' ? {} : { decisionAt: iso() }) };
      await returns().update({ where: { id: row.id, state: row.state }, data, transacting: trx });
      await audit(trx, `admin:${actor.id}`, row.request?.id || null, row.order?.id || null, row.state, input.state, { returnRequestId: row.documentId });
      await putOutbox(trx, `figurine-return:${row.id}:decision:${input.state}`, row.owner.email, `Sipariş başvurunuz güncellendi · ${row.order.orderNumber}`,
        `Başvurunuz incelendi. Karar: ${input.state === 'accepted' ? 'Kabul edildi' : input.state === 'rejected' ? 'Reddedildi' : 'İnceleniyor'}. ${data.customerNote} Başvuru kararı ödeme/iade işlemi yapıldığı anlamına gelmez. Ayrıntılar için hesabınıza giriş yapın: ${new URL(`/hesap/siparisler/${row.order.documentId}`, process.env.CUSTOMER_PUBLIC_ORIGIN || 'http://localhost:3000')}`, row.request?.id || null);
      return { state: data.state, decisionAt: data.decisionAt || null };
    });
  }
  async function adminPhoto(admin: any, requestId: string, assetKey: string, read: (owner: number, req: string, key: string) => Promise<Buffer>) {
    await checkAdmin(admin, 'photo');
    const request = await requests().findOne({ where: { documentId: id(requestId) } });
    if (!request) throw fail(404, 'Talep bulunamadı.');
    return read(request.owner?.id || Number((await requests().findOne({ where: { id: request.id }, populate: ['owner'] }))?.owner?.id), requestId, assetKey);
  }
  return {
    handles: (op: string) => ['figurine-requests', 'figurine-request', 'figurine-offer-accept', 'figurine-change-request', 'figurine-convert-order', 'figurine-start-payment', 'figurine-return-submit', 'figurine-return-list'].includes(op),
    async run(op: string, input: any, auth: any) {
      const owner = auth.user.id;
      if (op === 'figurine-requests') { fields(input, []); return customerList(owner); }
      if (op === 'figurine-request') return customerDetail(owner, input);
      if (op === 'figurine-offer-accept') return respond(owner, input, 'accepted');
      if (op === 'figurine-change-request') return respond(owner, input, 'change-request');
      if (op === 'figurine-convert-order') return convert(owner, input, auth);
      if (op === 'figurine-start-payment') return startPayment(owner, input);
      if (op === 'figurine-return-submit') return submitReturn(owner, input);
      if (op === 'figurine-return-list') { fields(input, []); return customerReturns(owner); }
      throw fail(404, 'İşlem bulunamadı.');
    },
    async adminList(admin: any) { return adminList(admin); },
    async adminDetail(admin: any, requestId: string) { return adminDetail(admin, requestId); },
    async adminSaveOffer(admin: any, requestId: string, input: any, present: boolean) { return adminSaveOffer(admin, requestId, input, present); },
    async adminWithdrawOffer(admin: any, requestId: string, offerId: string) { return adminWithdrawOffer(admin, requestId, offerId); },
    async adminRequestUpdate(admin: any, requestId: string, input: any) { return adminRequestUpdate(admin, requestId, input); },
    async adminOperation(admin: any, orderId: string, input: any) { return adminOperation(admin, orderId, input); },
    async adminReturnList(admin: any) { return adminReturnList(admin); },
    async adminReturnDecision(admin: any, requestId: string, input: any) { return adminReturnDecision(admin, requestId, input); },
    async checkAdmin(admin: any, capability: 'review' | 'quote' | 'operations' | 'photo' | 'refund') { return checkAdmin(admin, capability); },
  };
};
