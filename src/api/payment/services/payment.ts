import posnet from './posnet';
import { CustomerError, seal, open } from '../../../customer/security';
import cartFactory from '../../../commerce/cart';
import { operator } from '../../../commerce/authorization';
import { digest } from '../../../customer/security';

export class PaymentValidationError extends CustomerError { constructor(message: string) { super(400, message); } }
export default ({ strapi }: any) => {
  const attempts = () => strapi.db.query('api::payment-attempt.payment-attempt');
  const orders = () => strapi.db.query('api::order.order');
  const meta = () => strapi.db.metadata.get('api::payment-attempt.payment-attempt');
  const cart = cartFactory(strapi);
  async function cas(id: number, from: string[], to: string, extra: any = {}) {
    return strapi.db.connection(meta().tableName).where({ id }).whereIn('state', from).update({ state: to, ...extra });
  }
  async function unknown(attempt: any, code: string) {
    await attempts().update({ where: { id: attempt.id }, data: { state: 'unknown', failureCode: code } });
    await orders().update({ where: { id: attempt.order.id, status: { $ne: 'paid' } }, data: { paymentState: 'unknown' } });
  }
  async function paid(attempt: any, authCode = '', hostlogkey = '') {
    await strapi.db.transaction(async () => {
      await attempts().update({ where: { id: attempt.id }, data: { state: 'paid', settledAt: new Date().toISOString() } });
      await orders().update({ where: { id: attempt.order.id }, data: { status: 'paid', paymentState: 'paid', authCode, hostlogkey } });
    });
    await cart.settle(await orders().findOne({ where: { id: attempt.order.id }, populate: ['user'] }));
  }
  async function failed(attempt: any, code: string) {
    await strapi.db.transaction(async () => {
      await attempts().update({ where: { id: attempt.id }, data: { state: 'failed', failureCode: code } });
      await orders().update({ where: { id: attempt.order.id, status: { $ne: 'paid' } }, data: { status: 'failed', paymentState: 'failed' } });
    });
  }
  async function callbackRate(xid: string) {
    const window = Math.floor(Date.now() / 60000), name = 'api::customer-rate.customer-rate';
    const table = strapi.db.metadata.get(name).tableName, key = strapi.db.metadata.get(name).attributes.bucketKey.columnName;
    const hits = strapi.db.metadata.get(name).attributes.hits.columnName, expires = strapi.db.metadata.get(name).attributes.expiresAt.columnName;
    const result = await strapi.db.connection(table).insert({ [key]: digest(`payment-callback:${xid}:${window}`), [hits]: 1, [expires]: new Date((window + 2) * 60000) })
      .onConflict(key).merge({ [hits]: strapi.db.connection.raw('?? + 1', [hits]) }).returning(hits);
    if (Number(result[0][hits]) > 20) throw new CustomerError(429, 'Çok fazla ödeme bildirimi.');
  }
  async function existing(order: any) {
    // Only one active attempt for an order. The order row serializes creation across instances.
    return strapi.db.transaction(async ({ trx }) => {
      const table = strapi.db.metadata.get('api::order.order').tableName;
      await strapi.db.connection(table).transacting(trx).where({ id: order.id }).update({ updated_at: new Date() });
      const current = await orders().findOne({ where: { id: order.id } });
      if (current.status === 'paid') throw new CustomerError(409, 'Bu sipariş zaten ödendi.');
      const previous = await attempts().findOne({ where: { order: { id: order.id } }, orderBy: { id: 'desc' } });
      if (previous && previous.state !== 'failed') return { attempt: previous, created: false };
      const attempt = await attempts().create({ data: { order: order.id, xid: posnet.generateXid(), amount: order.grandTotal, currency: 'TL', state: 'creating' } });
      // Keep the first legacy XID intact. Every subsequent attempt has its own XID.
      await orders().update({ where: { id: order.id }, data: { ...(!current.posnetXid ? { posnetXid: attempt.xid } : {}), status: 'pending', paymentState: 'pending' } });
      return { attempt, created: true };
    });
  }
  async function claimCharge(attempt: any) {
    return strapi.db.transaction(async ({ trx }) => {
      const table = strapi.db.metadata.get('api::order.order').tableName;
      await strapi.db.connection(table).transacting(trx).where({ id: attempt.order.id }).update({ updated_at: new Date() });
      const current = await orders().findOne({ where: { id: attempt.order.id } });
      const latest = await attempts().findOne({ where: { order: { id: attempt.order.id } }, orderBy: { id: 'desc' } });
      if (current.status === 'paid' || latest?.id !== attempt.id) return false;
      return Boolean(await strapi.db.connection(meta().tableName).transacting(trx).where({ id: attempt.id, state: 'resolving' }).update({ state: 'charging', charged_at: new Date() }));
    });
  }
  return {
    async startOrder(order: any) {
      // Configuration is validated before recording any bank attempt.
      const config = posnet.getConfig(), backendUrl = posnet.requiredEnv('BACKEND_URL');
      const { attempt, created } = await existing(order);
      if (!created) {
        if (attempt.state === 'ready' && attempt.encryptedForm) return { orderNumber: order.orderNumber, ...open(attempt.encryptedForm) };
        throw new CustomerError(409, 'Ödeme işleniyor veya sonucu belirsiz. Yeni tahsilat başlatılmadı; sipariş durumunu kontrol edin.');
      }
      try {
        const response = await posnet.postXml(config, posnet.buildXml({ mid: config.merchantId, tid: config.terminalId,
          oosRequestData: { posnetid: config.posnetId, XID: attempt.xid, amount: attempt.amount, currencyCode: attempt.currency, installment: '00', tranType: 'Sale', cardHolderName: '', ccno: '', expDate: '', cvc: '' } }), attempt.xid);
        const data: any = response.oosRequestDataResponse;
        if (response.approved !== '1' || !data?.data1 || !data?.sign) {
          await failed({ ...attempt, order }, 'OOS_REJECTED'); throw new CustomerError(400, 'Banka ödeme hazırlığını kabul etmedi.');
        }
        const form = { oosUrl: config.oosUrl, formFields: { mid: config.merchantId, posnetID: config.posnetId, posnetData: data.data1, posnetData2: data.data2 || '', digest: data.sign,
          merchantReturnURL: `${backendUrl}/api/payment/callback`, lang: 'tr', openANewWindow: '0' } };
        await attempts().update({ where: { id: attempt.id }, data: { state: 'ready', encryptedForm: seal(form) } });
        return { orderNumber: order.orderNumber, ...form };
      } catch (e) {
        if (e instanceof CustomerError) throw e;
        // DB failure after the bank response must not pretend the bank rejected the request.
        try { await unknown({ ...attempt, order }, 'INITIATION_UNCERTAIN'); } catch { /* creating remains fail-closed */ }
        throw new CustomerError(503, 'Banka işleminin sonucu henüz doğrulanamadı. Yeni ödeme başlatmayın.');
      }
    },
    async handleCallback(body: Record<string, unknown>) {
      const xid = typeof body.Xid === 'string' ? body.Xid : '';
      if (!xid || ![body.BankPacket, body.MerchantPacket, body.Sign].every(v => typeof v === 'string' && v.length > 0 && v.length <= 32000)) return { success: false, reason: 'UNVERIFIED_CALLBACK' };
      await callbackRate(xid);
      let attempt = await attempts().findOne({ where: { xid }, populate: ['order'] });
      if (!attempt) {
        const order = await orders().findOne({ where: { posnetXid: xid } });
        if (!order) return { success: false, reason: 'NOT_FOUND' };
        // Legacy callback compatibility. Never rewrite existing XIDs or amounts.
        if (order.status === 'paid') return { success: true, orderNumber: order.orderNumber };
        try { attempt = await attempts().create({ data: { xid, order: order.id, amount: order.grandTotal, currency: 'TL', state: 'ready' } }); }
        catch { attempt = await attempts().findOne({ where: { xid } }); }
        attempt = { ...attempt, order };
      }
      const orderNumber = attempt.order.orderNumber;
      if (attempt.state === 'paid') { await cart.settle(await orders().findOne({ where: { id: attempt.order.id }, populate: ['user'] })); return { success: true, orderNumber }; }
      // Never repeat a financial call, including after process death or an expired HTTP request.
      if (attempt.chargedAt || !await cas(attempt.id, ['ready', 'unknown', 'failed'], 'resolving')) return { success: false, orderNumber, reason: 'PROCESSING_OR_UNCERTAIN' };
      const config = posnet.getConfig();
      const base = { xid: attempt.xid, amount: attempt.amount, currency: attempt.currency, merchantId: config.merchantId, terminalId: config.terminalId, encKey: config.encKey };
      const mac = posnet.buildRequestMac(base);
      try {
        const response = await posnet.postXml(config, posnet.buildXml({ mid: config.merchantId, tid: config.terminalId, oosResolveMerchantData: { bankData: body.BankPacket, merchantData: body.MerchantPacket, sign: body.Sign, mac } }), xid);
        const data: any = response.oosResolveMerchantDataResponse;
        if (response.approved !== '1' || !data || !posnet.timingSafeEqual(String(data.mac || ''), posnet.buildResolveResponseMac({ ...base, mdStatus: String(data.mdStatus) })) || String(data.xid) !== xid || Number(data.amount) !== attempt.amount) {
          // Unsigned rejection/MAC mismatch cannot change the Order payment status.
          await attempts().update({ where: { id: attempt.id }, data: { state: 'ready', failureCode: 'UNVERIFIED_CALLBACK' } });
          return { success: false, orderNumber, reason: 'UNVERIFIED_CALLBACK' };
        }
        if (String(data.mdStatus) !== '1') { await failed(attempt, 'AUTHENTICATION_FAILED'); return { success: false, orderNumber, reason: 'AUTHENTICATION_FAILED' }; }
        if (!await claimCharge(attempt)) { await cas(attempt.id, ['resolving'], 'failed'); return { success: false, orderNumber, reason: 'SUPERSEDED' }; }
        const tran = await posnet.postXml(config, posnet.buildXml({ mid: config.merchantId, tid: config.terminalId, oosTranData: { bankData: body.BankPacket, wpAmount: 0, mac } }), xid);
        const hostlogkey = String(tran.hostlogkey || '');
        // All post-charge errors, including an unauthenticated rejection, remain uncertain.
        if (!hostlogkey || !['1', '2'].includes(String(tran.approved)) || !posnet.timingSafeEqual(String(tran.mac || ''), posnet.buildTranResponseMac({ ...base, hostlogkey }))) {
          await unknown(attempt, 'CHARGE_UNCONFIRMED'); return { success: false, orderNumber, reason: 'PAYMENT_UNKNOWN' };
        }
        await paid(attempt, String(tran.authCode || ''), hostlogkey);
        return { success: true, orderNumber };
      } catch {
        try { await unknown(attempt, 'BANK_OR_DATABASE_UNCERTAIN'); } catch { /* charging/resolving prevents retry after DB outage */ }
        return { success: false, orderNumber, reason: 'PAYMENT_UNKNOWN' };
      }
    },
    async reconcile(xid: string, adminId: number, orderDate?: string) {
      // Internal service only. Bank orderID mapping must be configured after bank verification;
      // do not assume that local XID is the agreement orderID.
      if (process.env.POSNET_AGREEMENT_ENABLED !== 'true') throw new CustomerError(503, 'Banka mutabakat erişimi doğrulanmadı.');
      const admin = await operator(strapi, adminId);
      const prefix = posnet.requiredEnv('POSNET_AGREEMENT_XID_PREFIX');
      const bankOrderId = prefix + xid;
      if (!/^[A-Za-z0-9_]{1,24}$/.test(bankOrderId) || orderDate && !/^\d{8}$/.test(orderDate)) throw new CustomerError(400, 'Mutabakat bilgisi geçersiz.');
      const a = await attempts().findOne({ where: { xid }, populate: ['order'] });
      if (!a || !['unknown', 'charging', 'resolving', 'creating'].includes(a.state)) throw new CustomerError(409, 'Mutabakat gerektiren deneme bulunamadı.');
      const config = posnet.getConfig();
      const response = await posnet.postXml(config, posnet.buildXml({ mid: config.merchantId, tid: config.terminalId, agreement: { orderID: bankOrderId, ...(orderDate ? { orderDate } : {}) } }), xid);
      const raw: any = (response.transactions as any)?.transaction, list = Array.isArray(raw) ? raw : raw ? [raw] : [];
      // Missing/ambiguous records and E219 are NOT proof of nonpayment.
      const transactions = list.filter(t => t.orderID === bankOrderId && t.state === 'Sale' && t.currencyCode === a.currency && Math.round(Number(String(t.amount).replace(',', '.')) * 100) === a.amount && ['0','1'].includes(String(t.txnStatus)));
      if (response.approved !== '1' || transactions.length !== 1 || list.length !== 1) throw new CustomerError(409, 'Banka sonucu kesin değil; tahsilat kilidi korunuyor.');
      const tx = transactions[0];
      if (String(tx.txnStatus) === '1') await paid(a, String(tx.authCode || ''), String(tx.hostLogKey || ''));
      else await strapi.db.transaction(async () => {
        await attempts().update({ where: { id: a.id }, data: { state: 'failed', failureCode: 'BANK_AGREEMENT_FINAL_FAILURE', settledAt: new Date().toISOString() } });
        await orders().update({ where: { id: a.order.id, status: { $ne: 'paid' } }, data: { status: 'failed', paymentState: 'failed' } });
      });
      await strapi.db.query('api::operation-event.operation-event').create({ data: { order: a.order.id, actor: `admin:${admin.id}`, fromState: a.state, toState: String(tx.txnStatus) === '1' ? 'paid' : 'failed', details: { operation: 'agreement', xid } } });
      return { state: String(tx.txnStatus) === '1' ? 'paid' : 'failed' };
    },
  };
};
