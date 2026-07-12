/**
 * posnet service
 *
 * Yapı Kredi Posnet XML Servisi / 3D Secure entegrasyonu için düşük seviye
 * yardımcı fonksiyonlar: ortam değişkenleri, MAC hesaplama, XML üretimi/ayrıştırma
 * ve banka servisine HTTP isteği. Tüm alan adları ve MAC formülleri
 * docs/1.pdf (XML Servisleri Entegrasyon Dokümanı) ve docs/2.pdf
 * (POSNET ThreeD Secure XML Servis Entegrasyonu) dokümanlarından alınmıştır.
 *
 * ENCKEY hiçbir zaman response ile birlikte loglanmaz.
 */

import crypto from 'crypto';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';

const xmlBuilder = new XMLBuilder({ ignoreAttributes: true, format: false });
// parseTagValue: false -> respCode/authCode/hostlogkey gibi alanlardaki
// başında sıfır olan değerlerin veya "00"/"01" gibi kodların sayıya
// çevrilip bozulmaması için.
const xmlParser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} ortam değişkeni tanımlı değil`);
  }
  return value;
}

export interface PosnetConfig {
  merchantId: string;
  terminalId: string;
  posnetId: string;
  encKey: string;
  xmlUrl: string;
  oosUrl: string;
}

function getConfig(): PosnetConfig {
  return {
    merchantId: requiredEnv('POSNET_MERCHANT_ID'),
    terminalId: requiredEnv('POSNET_TERMINAL_ID'),
    posnetId: requiredEnv('POSNET_ID'),
    encKey: requiredEnv('POSNET_ENCKEY'),
    xmlUrl: requiredEnv('POSNET_XML_URL'),
    oosUrl: requiredEnv('POSNET_OOS_URL'),
  };
}

/**
 * Posnet varsayılan (OrderID parametresi aktive edilmemiş üye işyerleri için)
 * kuralı: XID tam 20 karakter, alfanumerik olmalıdır.
 */
function generateXid(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(8).toString('hex').toUpperCase();
  return (ts + rand).slice(0, 20).padEnd(20, '0');
}

function sha256Base64(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('base64');
}

function firstHash(encKey: string, terminalId: string): string {
  return sha256Base64(`${encKey};${terminalId}`);
}

interface MacBase {
  xid: string;
  amount: number | string;
  currency: string;
  merchantId: string;
  encKey: string;
  terminalId: string;
}

/**
 * oosRequestData ve oosTranData isteklerinde kullanılan standart MAC:
 * HASH(xid;amount;currency;merchantNo;HASH(encKey;terminalID))
 */
function buildRequestMac({ xid, amount, currency, merchantId, encKey, terminalId }: MacBase): string {
  const fh = firstHash(encKey, terminalId);
  return sha256Base64(`${xid};${amount};${currency};${merchantId};${fh}`);
}

/**
 * oosResolveMerchantDataResponse doğrulaması:
 * HASH(mdStatus;xid;amount;currency;merchantNo;HASH(encKey;terminalID))
 */
function buildResolveResponseMac(params: MacBase & { mdStatus: string }): string {
  const { mdStatus, xid, amount, currency, merchantId, encKey, terminalId } = params;
  const fh = firstHash(encKey, terminalId);
  return sha256Base64(`${mdStatus};${xid};${amount};${currency};${merchantId};${fh}`);
}

/**
 * oosTranData response doğrulaması:
 * HASH(hostLogkey;xid;amount;currency;merchantNo;HASH(encKey;terminalID))
 */
function buildTranResponseMac(params: MacBase & { hostlogkey: string }): string {
  const { hostlogkey, xid, amount, currency, merchantId, encKey, terminalId } = params;
  const fh = firstHash(encKey, terminalId);
  return sha256Base64(`${hostlogkey};${xid};${amount};${currency};${merchantId};${fh}`);
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function buildXml(body: Record<string, unknown>): string {
  const payload = {
    posnetRequest: body,
  };
  return `<?xml version="1.0" encoding="ISO-8859-9"?>\n${xmlBuilder.build(payload)}`;
}

interface PosnetResponse {
  approved?: string;
  respCode?: string;
  respText?: string;
  [key: string]: unknown;
}

/**
 * XML servisine xmldata= parametresi ile POST atar ve cevabı ayrıştırır.
 * Ham response gövdesi hiçbir zaman console.log ile yazdırılmaz.
 */
async function postXml(config: PosnetConfig, xml: string, correlationId: string): Promise<PosnetResponse> {
  const body = 'xmldata=' + encodeURIComponent(xml);

  const res = await fetch(config.xmlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      'X-MERCHANT-ID': config.merchantId,
      'X-TERMINAL-ID': config.terminalId,
      'X-POSNET-ID': config.posnetId,
      'X-CORRELATION-ID': correlationId,
    },
    body,
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Posnet XML servisi HTTP ${res.status} döndü`);
  }

  const parsed = xmlParser.parse(text);
  const response = parsed?.posnetResponse as PosnetResponse | undefined;

  if (!response) {
    throw new Error('Posnet XML servisi beklenmeyen bir cevap döndü');
  }

  return response;
}

export default {
  requiredEnv,
  getConfig,
  generateXid,
  buildRequestMac,
  buildResolveResponseMac,
  buildTranResponseMac,
  timingSafeEqual,
  buildXml,
  postXml,
};
