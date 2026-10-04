import { iso, seal } from '../customer/security';

const outboxUid = 'api::figurine-outbox.figurine-outbox';
const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string));
const shown = (value: unknown) => value === null || value === undefined || value === '' ? 'Kayıtlı değil' : String(value);
const money = (minor: unknown, currency = 'TRY') => Number.isSafeInteger(Number(minor)) ? new Intl.NumberFormat('tr-TR', { style: 'currency', currency }).format(Number(minor) / 100) : 'Kayıtlı değil';
const majorMoney = (value: unknown, currency = 'TRY') => value !== null && value !== undefined && Number.isFinite(Number(value)) ? new Intl.NumberFormat('tr-TR', { style: 'currency', currency }).format(Number(value)) : 'Kayıtlı değil';
const date = (value: unknown) => value && !Number.isNaN(Date.parse(String(value))) ? new Intl.DateTimeFormat('tr-TR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Istanbul' }).format(new Date(String(value))) : 'Kayıtlı değil';
const row = (label: string, value: unknown) => `<tr><th align="left" style="padding:6px 10px;border:1px solid #ddd">${escapeHtml(label)}</th><td style="padding:6px 10px;border:1px solid #ddd">${escapeHtml(shown(value))}</td></tr>`;
const table = (rows: string) => `<table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;max-width:760px">${rows}</table>`;

function staffLink(path: string) {
  const origin = process.env.CUSTOMER_STAFF_ADMIN_ORIGIN;
  if (!origin) throw new Error('CUSTOMER_STAFF_ADMIN_ORIGIN is not configured');
  const url = new URL(path, origin);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('CUSTOMER_STAFF_ADMIN_ORIGIN must be a credential-free HTTPS origin');
  return url.toString();
}

function publicImage(value: unknown) {
  if (!value) return null;
  try {
    const raw = String(value);
    const publicPath = raw.startsWith('/uploads/') ? `/backend${raw}` : raw;
    const url = new URL(publicPath, process.env.CUSTOMER_PUBLIC_ORIGIN);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.toString();
  } catch { return null; }
}

async function enqueue(strapi: any, trx: any, data: any) {
  const query = strapi.db.query(outboxUid);
  const existing = await query.findOne({ where: { eventKey: data.eventKey }, transacting: trx });
  if (existing) return existing;
  return query.create({ data: {
    eventKey: data.eventKey,
    audience: 'business',
    recipient: process.env.BUSINESS_NOTIFICATION_EMAIL || 'info@kesiolabs.com',
    encryptedPayload: seal({ subject: data.subject, text: data.text, html: data.html }),
    status: 'pending', attempts: 0, nextAttemptAt: iso(),
    ...(data.requestId ? { request: data.requestId } : {}),
    ...(data.orderId ? { order: data.orderId } : {}),
  }, transacting: trx });
}

export async function queueBusinessOrder(strapi: any, trx: any, order: any, test = false) {
  const currency = order.currency || 'TRY';
  const address = order.shippingAddress && typeof order.shippingAddress === 'object' ? order.shippingAddress : {};
  const items = Array.isArray(order.items) ? order.items : [];
  const manage = staffLink(`/admin/plugins/figurine-admin?order=${encodeURIComponent(order.documentId)}`);
  const itemText = items.map((item: any, index: number) => `${index + 1}. ${shown(item.isim)} | Varyant: ${shown(item.variant?.colorName)} | Adet: ${shown(item.adet)} | Birim: ${money(item.birimFiyat, currency)} | Toplam: ${money(item.satirToplami, currency)}`).join('\n');
  const itemHtml = items.map((item: any) => {
    const image = publicImage(item.imageUrl);
    return `<tr><td style="padding:8px;border:1px solid #ddd">${image ? `<img src="${escapeHtml(image)}" alt="" width="96" style="max-width:96px;height:auto">` : 'Görsel kaydedilmemiş'}</td><td style="padding:8px;border:1px solid #ddd">${escapeHtml(shown(item.isim))}</td><td style="padding:8px;border:1px solid #ddd">${escapeHtml(shown(item.variant?.colorName))}</td><td style="padding:8px;border:1px solid #ddd">${escapeHtml(shown(item.adet))}</td><td style="padding:8px;border:1px solid #ddd">${escapeHtml(money(item.birimFiyat, currency))}</td><td style="padding:8px;border:1px solid #ddd">${escapeHtml(money(item.satirToplami, currency))}</td></tr>`;
  }).join('');
  const subject = `${test ? '[TEST] ' : ''}Yeni sipariş · ${shown(order.orderNumber)}`;
  const text = `${subject}\nTarih: ${date(order.createdAt)}\nMüşteri: ${shown(order.buyerName)}\nE-posta: ${shown(order.buyerEmail)}\nTelefon: ${shown(order.buyerPhone)}\nTeslimat alıcısı: ${shown(address.fullName)}\nTeslimat telefonu: ${shown(address.phone)}\nAdres: ${[address.addressLine, address.district, address.city, address.postalCode].filter(Boolean).join(', ') || 'Kayıtlı değil'}\n\nÜrünler:\n${itemText || 'Kayıtlı ürün satırı yok'}\n\nAra toplam: ${money(order.subtotal, currency)}\nİndirim: ${money(order.discountTotal, currency)}\nVergi: ${money(order.vatTotal, currency)}\nKargo: ${money(order.shippingCost, currency)}\nGenel toplam: ${money(order.grandTotal, currency)}\nÖdeme durumu: ${shown(order.paymentState || order.status)}\nOperasyon durumu: ${shown(order.fulfillmentState)}\nMüşteri notu: ${shown(order.fulfillmentCustomerNote)}\n\nPersonel bağlantısı: ${manage}\nBu bildirim siparişin oluşturulduğunu belirtir; ödeme alındığı veya üretimin başladığı anlamına gelmez.`;
  const html = `<h1>${escapeHtml(subject)}</h1>${table(row('Sipariş numarası', order.orderNumber) + row('Tarih', date(order.createdAt)) + row('Müşteri', order.buyerName) + row('E-posta', order.buyerEmail) + row('Telefon', order.buyerPhone) + row('Teslimat alıcısı', address.fullName) + row('Teslimat telefonu', address.phone) + row('Teslimat adresi', [address.addressLine, address.district, address.city, address.postalCode].filter(Boolean).join(', ')))}<h2>Ürünler</h2><table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;max-width:900px"><thead><tr><th>Görsel</th><th>Ürün</th><th>Varyant</th><th>Adet</th><th>Birim</th><th>Toplam</th></tr></thead><tbody>${itemHtml}</tbody></table><h2>Tutarlar ve durum</h2>${table(row('Ara toplam', money(order.subtotal, currency)) + row('İndirim', money(order.discountTotal, currency)) + row('Vergi', money(order.vatTotal, currency)) + row('Kargo', money(order.shippingCost, currency)) + row('Genel toplam', money(order.grandTotal, currency)) + row('Ödeme durumu', order.paymentState || order.status) + row('Operasyon durumu', order.fulfillmentState) + row('Müşteri notu', order.fulfillmentCustomerNote))}<p><a href="${escapeHtml(manage)}">Siparişi yetkili personel ekranında aç</a></p><p><strong>Not:</strong> Bu bildirim siparişin oluşturulduğunu belirtir; ödeme alındığı veya üretimin başladığı anlamına gelmez.</p>`;
  return enqueue(strapi, trx, { eventKey: `${test ? 'test:' : ''}business:order:${order.id}:created`, subject, text, html, orderId: order.id });
}

export async function queueBusinessFigurine(strapi: any, trx: any, request: any, test = false) {
  const details = request.details || {};
  const manage = staffLink(`/admin/plugins/figurine-admin?request=${encodeURIComponent(request.documentId)}`);
  const people = Array.isArray(details.people) ? details.people : [];
  const peopleText = people.map((item: any, index: number) => `${index + 1}. ${item.kind === 'pet' ? 'Pet' : 'Kişi'} — Açıklama: ${shown(item.description)}; Kıyafet: ${shown(item.outfit)}; Poz: ${shown(item.pose)}; Saç/görünüm: ${shown(item.hair || item.appearance)}; Aksesuar/ayırt edici özellik: ${shown(item.accessories || item.distinctiveFeatures)}`).join('\n');
  const peopleHtml = people.map((item: any, index: number) => row(`${index + 1}. ${item.kind === 'pet' ? 'Pet' : 'Kişi'}`, `Açıklama: ${shown(item.description)}; Kıyafet: ${shown(item.outfit)}; Poz: ${shown(item.pose)}; Saç/görünüm: ${shown(item.hair || item.appearance)}; Aksesuar/ayırt edici özellik: ${shown(item.accessories || item.distinctiveFeatures)}`)).join('');
  const subject = `${test ? '[TEST] ' : ''}Yeni figür talebi · ${shown(request.requestNumber)}`;
  const startingPrice = details.package?.priceKind === 'starting' ? majorMoney(details.package?.startingPrice, 'TRY') : 'Teklif alın — kesin teklif değildir';
  const text = `${subject}\nTarih: ${date(request.createdAt)}\nMüşteri: ${shown(details.fullName)}\nE-posta: ${shown(details.verifiedEmail)}\nTelefon: ${shown(details.phone)}\nİletişim tercihi: ${shown(request.contactPreference || details.contactPreference)}\nPaket: ${shown(details.package?.title)}\nBaşlangıç fiyatı: ${startingPrice} (kesin teklif değildir)\nKişi: ${shown(details.characters)}\nPet: ${shown(details.pets)}\nRenk: ${shown(details.style)}\n\nDetaylar:\n${peopleText || 'Kayıtlı kişi/pet detayı yok'}\nKaide: ${shown(details.base)}\nKaide yazısı: ${shown(details.plinthText)}\nEk not: ${shown(details.note)}\n\nPersonel bağlantısı: ${manage}\nBu kayıt bir figür talebidir; kesinleşmiş sipariş veya teklif değildir. Teslimat adresi henüz alınmamıştır. Referans fotoğrafları e-postaya eklenmemiştir.`;
  const html = `<h1>${escapeHtml(subject)}</h1>${table(row('Talep numarası', request.requestNumber) + row('Tarih', date(request.createdAt)) + row('Müşteri', details.fullName) + row('E-posta', details.verifiedEmail) + row('Telefon', details.phone) + row('İletişim tercihi', request.contactPreference || details.contactPreference) + row('Paket', details.package?.title) + row('Başlangıç fiyatı', `${startingPrice} — kesin teklif değildir`) + row('Kişi sayısı', details.characters) + row('Pet sayısı', details.pets) + row('Renk seçimi', details.style))}<h2>Kişi ve pet detayları</h2>${table(peopleHtml || row('Detay', 'Kayıtlı kişi/pet detayı yok'))}${table(row('Kaide', details.base) + row('Kaide yazısı', details.plinthText) + row('Ek not', details.note))}<p><a href="${escapeHtml(manage)}">Talebi yetkili personel ekranında aç</a></p><p><strong>Not:</strong> Bu kayıt kesinleşmiş sipariş veya teklif değildir; teslimat adresi henüz alınmamıştır. Özel referans fotoğrafları bu e-postada yer almaz.</p>`;
  return enqueue(strapi, trx, { eventKey: `${test ? 'test:' : ''}business:figurine-request:${request.id}:received`, subject, text, html, requestId: request.id });
}
