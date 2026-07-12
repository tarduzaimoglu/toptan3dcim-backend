/**
 * payment service
 *
 * /api/payment/initiate ve /api/payment/callback için iş mantığı.
 * Fiyatlar her zaman sunucuda, Strapi'deki product kaydından hesaplanır;
 * client'tan gelen tutarlar asla güvenilmez. MAC/akış kuralları
 * docs/2.pdf (POSNET ThreeD Secure XML Servis Entegrasyonu) dokümanına
 * birebir uyar.
 */

import crypto from 'crypto';
import type { Core } from '@strapi/strapi';
import posnet from './posnet';
import pricing from './pricing';

const CURRENCY_CODE = 'TL'; // Posnet oosRequestData/oosResolveMerchantData currencyCode değeri (TRY -> TL)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9+()\s-]{7,20}$/;
// product.wholesalePrice KDV DAHİL fiyattır. Oran frontend/app/cart/page.tsx
// içindeki VAT_RATE=0.2 ile aynı tutulmalıdır (dahil KDV = toplam * oran/(1+oran)).
const VAT_RATE = 0.2;

export class PaymentValidationError extends Error {}

interface InitiateItemInput {
  productId: string | number;
  qty: number;
}

interface InitiateBuyerInput {
  name: string;
  email: string;
  phone: string;
  address?: Record<string, unknown> | null;
}

interface InitiateInput {
  items: InitiateItemInput[];
  buyer: InitiateBuyerInput;
  contractAccepted: boolean;
}

function toKurus(tryAmount: number): number {
  return Math.round(tryAmount * 100);
}

function generateOrderNumber(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `ORD-${ts}-${rand}`;
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async findProduct(productId: string) {
    const numericId = Number(productId);
    if (Number.isInteger(numericId) && String(numericId) === productId) {
      const results = await strapi.documents('api::product.product').findMany({
        filters: { id: { $eq: numericId } },
        fields: ['title', 'wholesalePrice', 'isActive'],
      });
      if (results[0]) return results[0];
    }

    try {
      return await strapi.documents('api::product.product').findOne({
        documentId: productId,
        fields: ['title', 'wholesalePrice', 'isActive'],
      });
    } catch {
      return null;
    }
  },

  async markFailed(documentId: string, reasonCode: string) {
    await strapi.documents('api::order.order').update({
      documentId,
      data: {
        status: 'failed',
        bankResponseRaw: { reasonCode },
      },
    });
  },

  async initiate(input: InitiateInput, clientIp: string) {
    const { items, buyer, contractAccepted } = input || ({} as InitiateInput);

    if (contractAccepted !== true) {
      throw new PaymentValidationError('Mesafeli satış sözleşmesi onaylanmadan ödeme başlatılamaz');
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw new PaymentValidationError('Sepet boş olamaz');
    }
    if (!buyer || !buyer.name || !buyer.email || !buyer.phone) {
      throw new PaymentValidationError('Alıcı bilgileri eksik');
    }
    if (!EMAIL_RE.test(buyer.email)) {
      throw new PaymentValidationError('Geçersiz e-posta adresi');
    }
    if (!PHONE_RE.test(buyer.phone)) {
      throw new PaymentValidationError('Geçersiz telefon numarası');
    }

    const normalizedItems = items.map((it) => ({
      productId: String(it?.productId ?? ''),
      qty: Number(it?.qty),
    }));

    for (const it of normalizedItems) {
      if (!it.productId || !Number.isInteger(it.qty) || it.qty <= 0) {
        throw new PaymentValidationError('Sepet satırları geçersiz: adet pozitif bir tam sayı olmalıdır');
      }
    }

    const lineItems: Array<{
      productId: string;
      isim: string;
      adet: number;
      birimFiyat: number;
      satirToplami: number;
    }> = [];
    let subtotalKurus = 0;
    let discountKurus = 0;

    for (const it of normalizedItems) {
      const product = await this.findProduct(it.productId);
      if (!product || product.isActive === false) {
        throw new PaymentValidationError(`Ürün bulunamadı veya satışa kapalı: ${it.productId}`);
      }

      const basePrice = Number(product.wholesalePrice);
      const unitPrice = pricing.effectiveUnitPriceTRY(basePrice, it.qty);
      const baseLineKurus = toKurus(basePrice * it.qty);
      const lineKurus = toKurus(unitPrice * it.qty);

      subtotalKurus += baseLineKurus;
      discountKurus += baseLineKurus - lineKurus;

      lineItems.push({
        productId: it.productId,
        isim: product.title,
        adet: it.qty,
        birimFiyat: toKurus(unitPrice),
        satirToplami: lineKurus,
      });
    }

    // Ürün fiyatları (wholesalePrice) KDV DAHİLDİR. discountedKurus, kademeli
    // indirim uygulanmış KDV dahil net satış tutarıdır ve doğrudan grandTotal'a
    // girer - KDV ayrıca toplama EKLENMEZ. vatTotal sadece bilgilendirme
    // amaçlıdır (dahil KDV ayrıştırması): toplam * oran/(1+oran).
    // Kargo: frontend'de (app/cart/page.tsx) somut bir kargo ücreti hesabı yok,
    // sadece "1500 TL üzeri ücretsiz / altında Hesaplanacak" bilgisi var. Bu
    // yüzden şimdilik 0 sabitlenmiştir.
    const discountedKurus = subtotalKurus - discountKurus;
    const vatKurus = Math.round((discountedKurus * VAT_RATE) / (1 + VAT_RATE));
    const shippingKurus = 0;
    const grandTotalKurus = discountedKurus + shippingKurus;

    if (grandTotalKurus <= 0) {
      throw new PaymentValidationError('Hesaplanan tutar geçersiz');
    }

    const xid = posnet.generateXid();
    const orderNumber = generateOrderNumber();

    const order = await strapi.documents('api::order.order').create({
      data: {
        orderNumber,
        status: 'pending',
        items: lineItems,
        subtotal: subtotalKurus,
        discountTotal: discountKurus,
        vatTotal: vatKurus,
        shippingCost: shippingKurus,
        grandTotal: grandTotalKurus,
        currency: 'TRY',
        buyerName: buyer.name,
        buyerEmail: buyer.email,
        buyerPhone: buyer.phone,
        shippingAddress: (buyer.address ?? null) as any,
        contractAccepted: true,
        contractAcceptedAt: new Date().toISOString(),
        posnetXid: xid,
        clientIp,
      },
    });

    const config = posnet.getConfig();

    const requestXml = posnet.buildXml({
      mid: config.merchantId,
      tid: config.terminalId,
      oosRequestData: {
        posnetid: config.posnetId,
        XID: xid,
        amount: grandTotalKurus,
        currencyCode: CURRENCY_CODE,
        installment: '00',
        tranType: 'Sale',
      },
    });

    let response;
    try {
      response = await posnet.postXml(config, requestXml, xid);
    } catch (err) {
      await this.markFailed(order.documentId, 'POSNET_REQUEST_ERROR');
      throw err;
    }

    if (response.approved !== '1') {
      await this.markFailed(order.documentId, response.respCode || 'OOS_REQUEST_NOT_APPROVED');
      throw new Error(`Posnet şifreleme isteği başarısız: ${response.respText || response.respCode}`);
    }

    const oosResponse = response.oosRequestDataResponse as
      | { data1?: string; data2?: string; sign?: string }
      | undefined;

    if (!oosResponse?.data1 || !oosResponse?.sign) {
      await this.markFailed(order.documentId, 'OOS_RESPONSE_INCOMPLETE');
      throw new Error('Posnet şifreleme cevabı eksik');
    }

    const backendUrl = posnet.requiredEnv('BACKEND_URL');

    return {
      orderNumber,
      oosUrl: config.oosUrl,
      formFields: {
        mid: config.merchantId,
        posnetID: config.posnetId,
        posnetData: oosResponse.data1,
        posnetData2: oosResponse.data2 ?? '',
        digest: oosResponse.sign,
        merchantReturnURL: `${backendUrl}/api/payment/callback`,
        lang: 'tr',
        openANewWindow: '0',
      },
    };
  },

  async handleCallback(body: Record<string, unknown>) {
    const bankData = typeof body.BankPacket === 'string' ? body.BankPacket : '';
    const merchantData = typeof body.MerchantPacket === 'string' ? body.MerchantPacket : '';
    const sign = typeof body.Sign === 'string' ? body.Sign : '';
    // Xid form alanı dokümana göre bilgi amaçlıdır; sadece Order'ı bulmak için
    // kullanılır, tutar/xid doğrulaması oosResolveMerchantDataResponse ile yapılır.
    const xidFromForm = typeof body.Xid === 'string' ? body.Xid : '';

    if (!bankData || !merchantData || !sign || !xidFromForm) {
      return { success: false, orderNumber: undefined, reason: 'MISSING_CALLBACK_FIELDS' };
    }

    const orders = await strapi.documents('api::order.order').findMany({
      filters: { posnetXid: { $eq: xidFromForm } },
      limit: 1,
    });
    const order = orders[0];

    if (!order) {
      return { success: false, orderNumber: undefined, reason: 'ORDER_NOT_FOUND' };
    }

    if (order.status !== 'pending') {
      return {
        success: order.status === 'paid',
        orderNumber: order.orderNumber,
        reason: order.status === 'paid' ? undefined : order.status,
      };
    }

    const config = posnet.getConfig();
    const macBase = {
      xid: order.posnetXid as string,
      amount: order.grandTotal as number,
      currency: CURRENCY_CODE,
      merchantId: config.merchantId,
      encKey: config.encKey,
      terminalId: config.terminalId,
    };

    const requestMac = posnet.buildRequestMac(macBase);

    const resolveXml = posnet.buildXml({
      mid: config.merchantId,
      tid: config.terminalId,
      oosResolveMerchantData: {
        bankData,
        merchantData,
        sign,
        mac: requestMac,
      },
    });

    let resolveResponse;
    try {
      resolveResponse = await posnet.postXml(config, resolveXml, order.posnetXid as string);
    } catch {
      await this.markFailed(order.documentId, 'RESOLVE_REQUEST_ERROR');
      return { success: false, orderNumber: order.orderNumber, reason: 'RESOLVE_REQUEST_ERROR' };
    }

    if (resolveResponse.approved !== '1') {
      const reason = resolveResponse.respCode || 'RESOLVE_NOT_APPROVED';
      await this.markFailed(order.documentId, reason as string);
      return { success: false, orderNumber: order.orderNumber, reason };
    }

    const resolveData = resolveResponse.oosResolveMerchantDataResponse as
      | {
          xid?: string;
          amount?: string;
          mdStatus?: string;
          mdErrorMessage?: string;
          mac?: string;
        }
      | undefined;

    if (!resolveData) {
      await this.markFailed(order.documentId, 'RESOLVE_DATA_MISSING');
      return { success: false, orderNumber: order.orderNumber, reason: 'RESOLVE_DATA_MISSING' };
    }

    const expectedResolveMac = posnet.buildResolveResponseMac({
      ...macBase,
      mdStatus: String(resolveData.mdStatus),
    });

    if (!posnet.timingSafeEqual(String(resolveData.mac || ''), expectedResolveMac)) {
      await this.markFailed(order.documentId, 'MAC_MISMATCH');
      return { success: false, orderNumber: order.orderNumber, reason: 'MAC_MISMATCH' };
    }

    if (String(resolveData.xid) !== order.posnetXid || Number(resolveData.amount) !== order.grandTotal) {
      await this.markFailed(order.documentId, 'XID_AMOUNT_MISMATCH');
      return { success: false, orderNumber: order.orderNumber, reason: 'XID_AMOUNT_MISMATCH' };
    }

    if (String(resolveData.mdStatus) !== '1') {
      const reason = `MD_STATUS_${resolveData.mdStatus}`;
      await this.markFailed(order.documentId, reason);
      return { success: false, orderNumber: order.orderNumber, reason };
    }

    const tranXml = posnet.buildXml({
      mid: config.merchantId,
      tid: config.terminalId,
      oosTranData: {
        bankData,
        wpAmount: 0,
        mac: requestMac,
      },
    });

    let tranResponse;
    try {
      tranResponse = await posnet.postXml(config, tranXml, order.posnetXid as string);
    } catch {
      await this.markFailed(order.documentId, 'TRAN_REQUEST_ERROR');
      return { success: false, orderNumber: order.orderNumber, reason: 'TRAN_REQUEST_ERROR' };
    }

    if (tranResponse.approved !== '1' && tranResponse.approved !== '2') {
      const reason = tranResponse.respCode || 'TRAN_NOT_APPROVED';
      await this.markFailed(order.documentId, reason as string);
      return { success: false, orderNumber: order.orderNumber, reason };
    }

    const hostlogkey = String(tranResponse.hostlogkey || '');
    const authCode = String(tranResponse.authCode || '');

    const expectedTranMac = posnet.buildTranResponseMac({
      ...macBase,
      hostlogkey,
    });

    if (!posnet.timingSafeEqual(String(tranResponse.mac || ''), expectedTranMac)) {
      await this.markFailed(order.documentId, 'TRAN_MAC_MISMATCH');
      return { success: false, orderNumber: order.orderNumber, reason: 'TRAN_MAC_MISMATCH' };
    }

    // oosTranData yanıtında hostlogkey ("Referans numarası") ve authCode dışında
    // ayrı, açıkça adlandırılmış bir "YKB ref no" alanı dokümante edilmemiştir.
    // Bu yüzden ykbRefNo boş bırakılıyor; ham yanıt bankResponseRaw'da saklanır,
    // gerçek test işleminde doğru alan netleşirse eşleme buradan güncellenir.
    await strapi.documents('api::order.order').update({
      documentId: order.documentId,
      data: {
        status: 'paid',
        authCode,
        hostlogkey,
        bankResponseRaw: {
          resolve: {
            approved: resolveResponse.approved,
            mdStatus: resolveData.mdStatus,
            txStatus: (resolveData as any).txStatus,
          },
          tran: {
            approved: tranResponse.approved,
            respCode: tranResponse.respCode,
            hostlogkey: tranResponse.hostlogkey,
            authCode: tranResponse.authCode,
            instInfo: (tranResponse as any).instInfo,
            pointInfo: (tranResponse as any).pointInfo,
          },
        },
      },
    });

    return { success: true, orderNumber: order.orderNumber };
  },
});
