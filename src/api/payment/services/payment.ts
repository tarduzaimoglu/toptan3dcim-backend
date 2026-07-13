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

const MAX_VARIANT_COLOR_NAME_LENGTH = 100;

interface InitiateItemVariantInput {
  colorName: string;
  [key: string]: string;
}

interface InitiateItemInput {
  productId: string | number;
  qty: number;
  variant?: InitiateItemVariantInput | null;
}

// variant opsiyoneldir; geçersiz/anlamsız geldiğinde hata fırlatmak yerine
// sessizce null'a düşürülür (fiyat hesabını etkilemez, sadece Order.items'a
// bilgi amaçlı yazılır).
function normalizeVariant(input: unknown): InitiateItemVariantInput | null {
  if (!input || typeof input !== 'object') return null;
  const colorName = (input as Record<string, unknown>).colorName;
  if (typeof colorName !== 'string') return null;
  const trimmed = colorName.trim();
  if (!trimmed || trimmed.length > MAX_VARIANT_COLOR_NAME_LENGTH) return null;
  return { colorName: trimmed };
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
  // strapi.documents(...) çağrıları status parametresi verilmezse Document
  // Service'in kendi varsayılanı olan 'draft' ile sorgulanır (bkz.
  // @strapi/core draft-and-publish.js defaultStatus). Halbuki frontend, ürünleri
  // otomatik REST controller'ı (CoreService.getFetchParams -> status: 'published')
  // üzerinden çektiği için product.id her zaman YAYINLANMIŞ satırın numeric id'sidir.
  // draftAndPublish açık olduğunda draft/published satırlar farklı numeric id'lere
  // sahip olduğundan, status belirtilmeden yapılan sorgu published id'yi asla
  // bulamaz. Bu yüzden burada status: 'published' açıkça verilmelidir - ödeme akışı
  // zaten yalnızca yayınlanmış ürünler için geçerli olmalıdır.
  async findProduct(productId: string) {
    const numericId = Number(productId);
    const isNumeric = Number.isInteger(numericId) && String(numericId) === productId;
    const attempted: string[] = [];

    if (isNumeric) {
      attempted.push('id(published)');
      const results = await strapi.documents('api::product.product').findMany({
        filters: { id: { $eq: numericId } },
        status: 'published',
        fields: ['title', 'wholesalePrice', 'isActive'],
      });
      if (results[0]) return results[0];
    }

    attempted.push('documentId(published)');
    try {
      const product = await strapi.documents('api::product.product').findOne({
        documentId: productId,
        status: 'published',
        fields: ['title', 'wholesalePrice', 'isActive'],
      });
      if (product) return product;
    } catch (err) {
      strapi.log.warn(
        `payment.findProduct: documentId sorgusu hata verdi, productId=${productId}, denenenler=[${attempted.join(', ')}], hata=${(err as Error).message}`
      );
      return null;
    }

    strapi.log.warn(
      `payment.findProduct: ürün hiçbir sorguyla bulunamadı, productId=${productId}, denenenler=[${attempted.join(', ')}]`
    );
    return null;
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
      variant: normalizeVariant(it?.variant),
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
      variant: InitiateItemVariantInput | null;
    }> = [];
    let subtotalKurus = 0;
    let discountKurus = 0;

    for (const it of normalizedItems) {
      const product = await this.findProduct(it.productId);
      if (!product) {
        // findProduct zaten hangi sorguların denendiğini logladı; burada sadece
        // müşteriye dönecek genel mesajı fırlatıyoruz (ürün id enumeration'a
        // karşı kasıtlı olarak "yok" ile "pasif" ayrımı müşteriye sızdırılmıyor).
        throw new PaymentValidationError(`Ürün bulunamadı veya satışa kapalı: ${it.productId}`);
      }
      if (product.isActive === false) {
        strapi.log.warn(`payment.initiate: ürün pasif (isActive=false), productId=${it.productId}`);
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
        variant: it.variant,
      });
    }

    // Ürün fiyatları (wholesalePrice) KDV DAHİLDİR. discountedKurus, kademeli
    // indirim uygulanmış KDV dahil net satış tutarıdır ve doğrudan grandTotal'a
    // girer - KDV ayrıca toplama EKLENMEZ. vatTotal sadece bilgilendirme
    // amaçlıdır (dahil KDV ayrıştırması): toplam * oran/(1+oran).
    // Kargo: discountedKurus (indirimli, KDV dahil sepet toplamı) 1500 TL'ye
    // ulaşıyorsa (dahil) ücretsiz, altındaysa sabit 200 TL. frontend/lib/pricing.ts
    // shippingFeeFor ile birebir aynı kural - bkz. pricing.ts.
    const discountedKurus = subtotalKurus - discountKurus;
    const vatKurus = Math.round((discountedKurus * VAT_RATE) / (1 + VAT_RATE));
    const shippingKurus = pricing.shippingFeeForKurus(discountedKurus);
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

    // GEÇİCİ TEŞHİS: "Merchant No 10 karakterden fazla olamaz" hatasının Railway
    // env değerlerindeki gizli whitespace/satır sonu karakterlerinden kaynaklanıp
    // kaynaklanmadığını doğrulamak için eklendi (bkz. posnet.logEnvDiagnostics).
    posnet.logEnvDiagnostics(strapi.log);

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
        // Kart bilgileri banka OOS sayfasında toplanıyor (docs/2.pdf: "cardHolderName,
        // ccno, expDate, cvc alanlarına XML içerisinde yer verilmez veya boş bırakılır").
        // "Yer verilmez" varyantı denenmişti; burada "boş bırakılır" varyantı deneniyor.
        cardHolderName: '',
        ccno: '',
        expDate: '',
        cvc: '',
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
    // Dokümante edilmemiş ama canlıda görülen banka hata alanı: bazı durumlarda
    // (ör. bağlantı/IP-MID-TID reddi) banka tam MerchantPacket/BankPacket/Sign seti
    // yerine sadece bu alanı gönderiyor.
    const bankReasonCode = typeof body.reasonCode === 'string' ? body.reasonCode : undefined;

    if (!bankData || !merchantData || !sign || !xidFromForm) {
      // Xid yine de gelmişse (ör. sadece reasonCode ile birlikte kısmi bir hata
      // payload'u), ilgili Order'ı bulup failed olarak işaretlemeliyiz - aksi halde
      // sipariş sonsuza kadar 'pending' kalır ve hiçbir yerde hata kaydı oluşmaz.
      if (xidFromForm) {
        const orders = await strapi.documents('api::order.order').findMany({
          filters: { posnetXid: { $eq: xidFromForm } },
          limit: 1,
        });
        const order = orders[0];
        const reason = bankReasonCode || 'MISSING_CALLBACK_FIELDS';
        if (order && order.status === 'pending') {
          await this.markFailed(order.documentId, reason);
        }
        return { success: false, orderNumber: order?.orderNumber, reason };
      }
      return { success: false, orderNumber: undefined, reason: bankReasonCode || 'MISSING_CALLBACK_FIELDS' };
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
