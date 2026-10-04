import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { settleGuestCart } from '../../toptan3dcim-frontend/lib/cart-settlement';
import { open } from '../src/customer/security';

export async function commerceTests({ app, request, test, aliceUser, aToken, bToken, addressId }: any) {
  console.log('Stage 2: bank transport is MOCKED; no real bank requests');
  const posnet = require(path.resolve('dist/src/api/payment/services/posnet.js')).default;
  const originalPost = posnet.postXml;
  Object.assign(process.env, { POSNET_MERCHANT_ID: '0000000001', POSNET_TERMINAL_ID: '00000001', POSNET_ID: '1', POSNET_ENCKEY: 'mock-only-key', POSNET_XML_URL: 'https://bank.invalid/xml', POSNET_OOS_URL: 'https://bank.invalid/oos', BACKEND_URL: 'http://localhost:1337' });
  const config = posnet.getConfig(), parser = new XMLParser({ parseTagValue: false });
  const payment = app.service('api::payment.payment'), attempts = () => app.db.query('api::payment-attempt.payment-attempt'), orders = () => app.db.query('api::order.order');
  let charges = 0, requestCount = 0, mode = 'ok', agreementStatus = '1', throwPaid = false;
  const originalQuery = app.db.query.bind(app.db);
  app.db.query = (uid: string) => {
    const query = originalQuery(uid);
    if (uid !== 'api::payment-attempt.payment-attempt') return query;
    return { ...query, update: async (params: any) => { if (throwPaid && params.data.state === 'paid') { throwPaid = false; throw new Error('Injected DB outage after bank charge'); } return query.update(params); } };
  };
  posnet.postXml = async (_config: any, xml: string, xid: string) => {
    const body = parser.parse(xml).posnetRequest;
    if (body.oosRequestData) { requestCount++; if (mode === 'init-timeout') throw new Error('Mock timeout'); return { approved: '1', oosRequestDataResponse: { data1: 'mock-encrypted-form', data2: '', sign: 'mock-sign' } }; }
    const a = await attempts().findOne({ where: { xid } });
    const base = { xid, amount: a.amount, currency: a.currency, merchantId: config.merchantId, terminalId: config.terminalId, encKey: config.encKey };
    if (body.oosResolveMerchantData) {
      await new Promise(r => setTimeout(r, 15));
      return { approved: '1', oosResolveMerchantDataResponse: { xid, amount: String(a.amount), mdStatus: '1', mac: mode === 'fake' ? 'invalid' : posnet.buildResolveResponseMac({ ...base, mdStatus: '1' }) } };
    }
    if (body.oosTranData) { charges++; if (mode === 'charge-timeout') throw new Error('Mock post-charge timeout'); if (mode === 'db-error') throwPaid = true;
      return { approved: '1', hostlogkey: 'mock-reference', authCode: 'mock-auth', mac: posnet.buildTranResponseMac({ ...base, hostlogkey: 'mock-reference' }) }; }
    if (body.agreement) return { approved: '1', transactions: { transaction: { orderID: body.agreement.orderID, amount: (a.amount / 100).toFixed(2).replace('.',','), currencyCode: 'TL', state: 'Sale', txnStatus: agreementStatus, authCode: 'mock-auth', hostLogKey: 'mock-reference' } } };
    throw new Error('Unexpected mock bank operation');
  };
  const callback = (xid: string) => payment.handleCallback({ Xid: xid, BankPacket: 'mock-bank', MerchantPacket: 'mock-merchant', Sign: 'mock-sign' });
  const product = await app.documents('api::product.product').create({ data: { title: 'Commerce fixture', slug: `commerce-${crypto.randomUUID()}`, wholesalePrice: 50, minQty: 2, isActive: true, variants: [{ ColorName: 'Mavi', ColorCode: '#0000ff' }] }, status: 'published' });
  const item = { productId: product.documentId, qty: 2, variant: { colorName: 'Mavi' }, price: 50 };
  const buyer = { name: 'Checkout fixture', email: 'guest@example.test', phone: '5551234567', address: { city: 'İstanbul', district: 'Kadıköy', addressLine: 'Original checkout address' } };
  const role = await app.db.query('admin::role').findOne({ where: { code: 'strapi-super-admin' } });
  const admin = await app.db.query('admin::user').create({ data: { firstname: 'Local', lastname: 'Test', email: `operation-${crypto.randomUUID()}@example.test`, password: 'unused-test-only', isActive: true, roles: [role.id] } });
  let memberOrder: any;
  async function checkout(token = '', extra: any = {}) {
    const current = token ? (await request('cart', {}, token)).body.cart : null;
    const items = current ? current.lines.map((l: any) => ({ productId: l.productId, qty: l.qty, variant: l.variant, price: l.price })) : [item];
    const quote = await request('checkout-quote', { items, ...(current ? { revision: current.revision } : {}) }, token); assert.equal(quote.status, 200);
    const data = { items, buyer, quoteHash: quote.body.quoteHash, checkoutId: crypto.randomUUID(), contractAccepted: true, guestKey: crypto.randomUUID(), ...(current ? { revision: current.revision } : {}), ...extra };
    const result = await request('checkout', data, token);
    return { result, data };
  }
  try {
    await test('Persistent cart, repeated merge receipt and two-device revision collision', async () => {
      const merge = { mergeId: crypto.randomUUID(), items: [item] };
      assert.equal((await request('cart-merge', merge, aToken)).status, 200);
      assert.equal((await request('cart-merge', merge, aToken)).body.cart.lines[0].qty, 2);
      const before = (await request('cart', {}, aToken)).body.cart;
      const updates = await Promise.all([3,4].map(qty => request('cart-save', { revision: before.revision, items: [{ ...item, qty }] }, aToken)));
      assert.deepEqual(updates.map(r => r.status).sort(), [200,409]);
      assert.ok([3,4].includes((await request('cart', {}, aToken)).body.cart.lines[0].qty));
      assert.equal((await request('cart', {}, bToken)).body.cart.lines.length, 0);
      const c = (await request('cart', {}, aToken)).body.cart;
      assert.equal((await request('cart-save', { revision: c.revision, items: [item] }, aToken)).status, 200);
    });
    await test('Server variant/min/max/active/identity validation and price change warnings', async () => {
      for (const bad of [{ ...item, qty: 1 }, { ...item, qty: 2001 }, { ...item, qty: 2.5 }, { ...item, variant: { colorName: 'Unconfigured' } }]) assert.equal((await request('cart-merge', { mergeId: crypto.randomUUID(), items: [bad] }, aToken)).status, 400);
      assert.equal((await request('cart', { userId: aliceUser.id }, bToken)).status, 400);
      const q = await request('checkout-quote', { items: [{ ...item, price: 0.01 }] }); assert.equal(q.body.grandTotal, 30000); assert.ok(q.body.warnings.length);
      await app.documents('api::product.product').update({ documentId: product.documentId, data: { isActive: false }, status: 'published' });
      assert.ok((await request('checkout-quote', { items: [item] })).body.lines[0].invalid);
      await app.documents('api::product.product').update({ documentId: product.documentId, data: { isActive: true }, status: 'published' });
    });
    await test('Guest/member checkout, optional user relation, address ownership/snapshots and repeated initiation', async () => {
      const member = await checkout(aToken, { shippingAddressId: addressId, billingAddressId: addressId }); assert.equal(member.result.status, 200);
      memberOrder = await orders().findOne({ where: { orderNumber: member.result.body.orderNumber }, populate: ['user'] });
      assert.equal(memberOrder.user.id, aliceUser.id); assert.equal(memberOrder.buyerEmail, aliceUser.email); assert.ok(memberOrder.billingAddress.addressLine);
      const count = requestCount;
      const repeats = await Promise.all([request('checkout', member.data, aToken), request('checkout', member.data, aToken)]);
      assert.deepEqual(repeats.map(r => r.status), [200,200]); assert.equal(requestCount, count);
      assert.equal(await orders().count({ where: { checkoutKey: memberOrder.checkoutKey } }), 1);
      const businessJobs = await app.db.query('api::figurine-outbox.figurine-outbox').findMany({ where: { order: { id: memberOrder.id }, audience: 'business' } });
      assert.equal(businessJobs.length, 1, 'checkout retries must not duplicate the business notification');
      const businessMail = open(businessJobs[0].encryptedPayload);
      assert.match(businessMail.subject, /^Yeni sipariş/); assert.match(businessMail.text, /Ödeme durumu: pending/); assert.match(businessMail.text, /üretimin başladığı anlamına gelmez/);
      assert.equal((await request('checkout', { ...member.data, userId: 99 }, aToken)).status, 400);
      const other = await checkout(bToken, { shippingAddressId: addressId }); assert.equal(other.result.status, 404);
      const guest = await checkout(); assert.equal(guest.result.status, 200);
      const g = await orders().findOne({ where: { orderNumber: guest.result.body.orderNumber }, populate: ['user'] }); assert.equal(g.user, null);
      assert.equal((await request('payment-result', { orderNumber: g.orderNumber, guestKey: guest.data.guestKey })).status, 200);
      assert.equal((await request('payment-result', { orderNumber: g.orderNumber, guestKey: 'wrong-key' })).status, 404);
      assert.equal((await request('payment-result', { orderNumber: memberOrder.orderNumber }, bToken)).status, 404);
      const a = await attempts().findOne({ where: { order: { id: g.id } } }); await callback(a.xid);
    });
    await test('Changed server price requires renewed confirmation before creating an order/bank request', async () => {
      const q = (await request('checkout-quote', { items: [item] })).body;
      await app.documents('api::product.product').update({ documentId: product.documentId, data: { wholesalePrice: 60 }, status: 'published' });
      const count = requestCount;
      assert.equal((await request('checkout', { items: [item], buyer, quoteHash: q.quoteHash, checkoutId: crypto.randomUUID(), guestKey: crypto.randomUUID(), contractAccepted: true })).status, 409);
      assert.equal(requestCount, count);
      assert.ok((await request('cart', {}, aToken)).body.cart.warnings.some((w: string) => w.includes('fiyat')));
      await app.documents('api::product.product').update({ documentId: product.documentId, data: { wholesalePrice: 50 }, status: 'published' });
    });
    await test('Fake/incomplete callback cannot alter Order; parallel callbacks charge exactly once', async () => {
      const a = await attempts().findOne({ where: { order: { id: memberOrder.id } } });
      await payment.handleCallback({ Xid: a.xid, reasonCode: 'FAKE_FAILURE' });
      assert.equal((await orders().findOne({ where: { id: memberOrder.id } })).status, 'pending');
      mode = 'fake'; await callback(a.xid); mode = 'ok';
      assert.equal((await orders().findOne({ where: { id: memberOrder.id } })).paymentState, 'pending');
      const c = (await request('cart', {}, aToken)).body.cart;
      await request('cart-save', { revision: c.revision, items: [{ ...item, qty: 5 }] }, aToken);
      const before = charges;
      const results = await Promise.all(Array.from({ length: 5 }, () => callback(a.xid)));
      assert.equal(results.filter(r => r.success).length >= 1, true); assert.equal(charges, before + 1);
      assert.equal((await request('cart', {}, aToken)).body.cart.lines[0].qty, 3);
      await callback(a.xid); assert.equal(charges, before + 1); assert.equal((await request('cart', {}, aToken)).body.cart.lines[0].qty, 3);
      const result = await request('payment-result', { orderNumber: memberOrder.orderNumber }, aToken); assert.equal(result.body.paymentState, 'paid'); assert.ok(!JSON.stringify(result.body).includes('mock-auth'));
    });
    await test('Timeout and bank-success/DB-failure remain uncertain; replay/new checkout cannot recharge; agreement mock resolves', async () => {
      for (const scenario of ['charge-timeout','db-error']) {
        const { result, data } = await checkout(); assert.equal(result.status, 200);
        const o = await orders().findOne({ where: { orderNumber: result.body.orderNumber } }); const a = await attempts().findOne({ where: { order: { id: o.id } } });
        mode = scenario; const before = charges; await callback(a.xid); mode = 'ok';
        assert.equal((await attempts().findOne({ where: { id: a.id } })).state, 'unknown');
        await callback(a.xid); assert.equal(charges, before + 1);
        assert.equal((await request('checkout', data)).status, 409);
        assert.equal((await request('checkout', { ...data, checkoutId: crypto.randomUUID() })).status, 409);
        assert.equal((await request('payment-result', { orderNumber: o.orderNumber, guestKey: data.guestKey })).body.paymentState, 'unknown');
        await assert.rejects(payment.reconcile(a.xid, admin.id));
        process.env.POSNET_AGREEMENT_ENABLED = 'true'; process.env.POSNET_AGREEMENT_XID_PREFIX = 'TDS_';
        await assert.rejects(payment.reconcile(a.xid, 999999));
        await payment.reconcile(a.xid, admin.id); process.env.POSNET_AGREEMENT_ENABLED = 'false';
        assert.equal((await orders().findOne({ where: { id: o.id } })).status, 'paid');
      }
      const failedAttempt = await checkout(), failedOrder = await orders().findOne({ where: { orderNumber: failedAttempt.result.body.orderNumber } });
      const attempt = await attempts().findOne({ where: { order: { id: failedOrder.id } } }); mode = 'charge-timeout'; await callback(attempt.xid); mode = 'ok';
      agreementStatus = '0'; process.env.POSNET_AGREEMENT_ENABLED = 'true'; process.env.POSNET_AGREEMENT_XID_PREFIX = 'TDS_';
      assert.equal((await payment.reconcile(attempt.xid, admin.id)).state, 'failed'); agreementStatus = '1'; process.env.POSNET_AGREEMENT_ENABLED = 'false';
      assert.equal((await orders().findOne({ where: { id: failedOrder.id } })).paymentState, 'failed');
      mode = 'init-timeout'; const initiated = await checkout(); mode = 'ok'; assert.equal(initiated.result.status, 503);
      assert.equal((await request('checkout', initiated.data)).status, 409);
    });
    await test('Legacy order/XID retained; late valid callback is processed and direct success is not proof', async () => {
      const o = await app.documents('api::order.order').create({ data: { orderNumber: `LEGACY-${crypto.randomUUID()}`, posnetXid: posnet.generateXid(), status: 'failed', items: [{ isim: 'Legacy', adet: 1 }], grandTotal: 12345, buyerName: 'Legacy', buyerEmail: buyer.email, buyerPhone: buyer.phone, contractAccepted: true } });
      const original = { amount: o.grandTotal, xid: o.posnetXid, items: o.items };
      await payment.handleCallback({ Xid: o.posnetXid }); assert.equal((await orders().findOne({ where: { id: o.id } })).status, 'failed');
      assert.equal((await callback(o.posnetXid)).success, true);
      const after = await orders().findOne({ where: { id: o.id } }); assert.deepEqual({ amount: after.grandTotal, xid: after.posnetXid, items: after.items }, original);
      assert.equal((await request('payment-result', { orderNumber: o.orderNumber, guestKey: 'unknown' })).status, 404);
      const raw = { items: [{ productId: '1', qty: 5 }, { productId: '2', qty: 3 }] };
      const settled = settleGuestCart(raw, 'PAID', [{ productId: 'doc', sourceProductId: '1', qty: 2 }]);
      assert.equal(settled.items![0].qty, 3); assert.equal(settled.items![1].qty, 3); assert.deepEqual(settleGuestCart(settled, 'PAID', [{ productId: '1', qty: 2 }]), settled);
    });
    await test('Operation service authorization, separate status, transition validation and audit', async () => {
      const operations = app.service('api::order.operations');
      await assert.rejects(operations.update(999999, memberOrder.documentId, { fulfillmentState: 'shipped' }));
      await operations.update(admin.id, memberOrder.documentId, { fulfillmentState: 'preparing' });
      await assert.rejects(operations.update(admin.id, memberOrder.documentId, { fulfillmentState: 'delivered' }));
      await assert.rejects(operations.update(admin.id, memberOrder.documentId, { fulfillmentState: 'ready', trackingUrl: 'javascript:alert(1)' }));
      await operations.update(admin.id, memberOrder.documentId, { fulfillmentState: 'ready' });
      await operations.update(admin.id, memberOrder.documentId, { fulfillmentState: 'shipped', shippingCarrier: 'Fixture carrier', trackingNumber: 'TEST-1', trackingUrl: 'https://carrier.example.test/TEST-1' });
      const detail = (await request('order', { id: memberOrder.documentId }, aToken)).body.order;
      assert.equal(detail.fulfillmentState, 'shipped'); assert.equal(detail.paymentState, 'paid'); assert.ok(detail.trackingUrl);
      assert.equal((await request('order-update', { id: memberOrder.documentId, fulfillmentState: 'delivered' }, aToken)).status, 404);
      assert.equal(await app.db.query('api::operation-event.operation-event').count({ where: { order: { id: memberOrder.id } } }), 3);
    });
    process.env.CUSTOMER_TEST_PRODUCT_ID = product.documentId;
  } finally { if (!process.argv.includes('--e2e')) posnet.postXml = originalPost; app.db.query = originalQuery; }
}
