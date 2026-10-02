import crypto from 'node:crypto';
import { CustomerError, digest, fields, text, email, phone } from '../customer/security';
import cartFactory from './cart';

export default (strapi: any) => {
  const cart = cartFactory(strapi), orders = () => strapi.db.query('api::order.order');
  async function address(owner: number | undefined, id: any, fallback: any) {
    if (id) {
      if (!owner) throw new CustomerError(401, 'Adres seçmek için giriş yapın.');
      const a = await strapi.db.query('api::customer-address.customer-address').findOne({ where: { documentId: text(id, 100, true), owner: { id: owner } } });
      if (!a) throw new CustomerError(404, 'Adres bulunamadı.');
      return Object.fromEntries(['fullName', 'phone', 'city', 'district', 'addressLine', 'postalCode'].map(k => [k, a[k] || '']));
    }
    fields(fallback, ['city', 'district', 'addressLine']);
    return { city: text(fallback.city, 100, true), district: text(fallback.district, 100, true), addressLine: text(fallback.addressLine, 500, true) };
  }
  async function run(operation: string, data: any, auth: any) {
    const owner = auth?.user.id;
    if (operation === 'cart') { fields(data, []); if (!owner) throw new CustomerError(401, 'Giriş yapın.'); return cart.view(owner); }
    if (operation === 'cart-save' || operation === 'cart-merge') { if (!owner) throw new CustomerError(401, 'Giriş yapın.'); return cart.save(owner, data, operation === 'cart-merge'); }
    if (operation === 'checkout-quote') {
      fields(data, ['items', 'revision']);
      if (owner) { const c = await cart.cart(owner); if (c.revision !== data.revision) throw new CustomerError(409, 'Sepet değişti; tekrar kontrol edin.'); return cart.quote(c.lines || []); }
      return cart.quote(data.items);
    }
    if (operation === 'payment-result') {
      fields(data, ['orderNumber', 'guestKey']);
      const where = owner ? { orderNumber: text(data.orderNumber, 100, true), user: { id: owner } } : { orderNumber: text(data.orderNumber, 100, true), guestHash: digest(text(data.guestKey, 100, true)), user: null };
      const order = await orders().findOne({ where });
      if (!order) throw new CustomerError(404, 'Sipariş bulunamadı.');
      if (order.status === 'paid') await cart.settle({ ...order, user: owner });
      return { orderNumber: order.orderNumber, paymentState: order.paymentState || order.status, paidItems: order.status === 'paid' ? order.cartSnapshot || [] : [] };
    }
    fields(data, ['items', 'revision', 'quoteHash', 'checkoutId', 'buyer', 'shippingAddressId', 'billingAddressId', 'contractAccepted', 'guestKey']);
    if (data.contractAccepted !== true) throw new CustomerError(400, 'Satış sözleşmesini onaylayın.');
    fields(data.buyer, ['name', 'email', 'phone', 'address']);
    const buyer = { name: text(data.buyer.name, 100, true), email: owner ? auth.user.email : email(data.buyer.email), phone: phone(data.buyer.phone) };
    if (!buyer.phone) throw new CustomerError(400, 'Telefon zorunlu.');
    const shippingAddress = await address(owner, data.shippingAddressId, data.buyer.address);
    const billingAddress = data.billingAddressId ? await address(owner, data.billingAddressId, null) : { ...shippingAddress };
    const scope = owner ? `user:${owner}` : `guest:${digest(text(data.guestKey, 100, true))}`;
    const checkoutKey = digest(`${scope}:${text(data.checkoutId, 100, true)}`);
    const checkoutHash = digest(JSON.stringify({ buyer, shippingAddress, billingAddress, quoteHash: data.quoteHash, revision: data.revision }));
    let order = await orders().findOne({ where: { checkoutKey } });
    if (order && order.checkoutHash !== checkoutHash) throw new CustomerError(409, 'Bu ödeme isteği farklı bilgilerle tekrar kullanılamaz.');
    if (!order) {
      const uncertain = await strapi.db.query('api::payment-attempt.payment-attempt').findOne({ where: {
        state: { $in: ['creating','resolving','charging','unknown'] },
        order: owner ? { user: { id: owner } } : { guestHash: digest(data.guestKey), user: null }
      } });
      if (uncertain) throw new CustomerError(409, 'Önceki ödemenin sonucu henüz kesin değil. Mutabakat tamamlanmadan yeni tahsilat başlatılamaz.');
      const c = owner ? await cart.cart(owner) : null;
      try {
        order = await strapi.db.transaction(async ({ trx }) => {
          if (c) await cart.lock(c, data.revision, trx);
          const q = await cart.quote(c ? c.lines || [] : data.items);
          if (!q.lines.length || q.lines.some(l => l.invalid)) throw new CustomerError(400, q.warnings.join(' ') || 'Sepet boş.');
          if (q.quoteHash !== data.quoteHash) throw new CustomerError(409, 'Fiyat değişti. Güncel toplamı kontrol edip yeniden onaylayın.');
          // checkout does not modify the cart: undo revision increment while retaining transaction lock.
          if (c) await strapi.db.query('api::customer-cart.customer-cart').update({ where: { id: c.id }, data: { revision: data.revision } });
          return strapi.documents('api::order.order').create({ data: { checkoutKey, checkoutHash, guestHash: owner ? null : digest(data.guestKey),
            orderNumber: `ORD-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`, status: 'pending', paymentState: 'pending',
            items: q.lines.map(l => ({ productId: l.productId, isim: l.isim, adet: l.adet, birimFiyat: l.birimFiyat, satirToplami: l.satirToplami, variant: l.variant })),
            ...Object.fromEntries(['subtotal','discountTotal','vatTotal','shippingCost','grandTotal','currency'].map(k => [k,q[k]])),
            buyerName: buyer.name, buyerEmail: buyer.email, buyerPhone: buyer.phone, shippingAddress, billingAddress,
            contractAccepted: true, contractAcceptedAt: new Date().toISOString(), user: owner || null, cartSnapshot: q.lines.map(l => ({ ...cart.stored([l])[0], sourceProductId: l.sourceProductId })) } });
        });
      } catch (e) { order = await orders().findOne({ where: { checkoutKey } }); if (!order) throw e; if (order.checkoutHash !== checkoutHash) throw new CustomerError(409, 'Ödeme isteği çakıştı.'); }
    }
    return strapi.service('api::payment.payment').startOrder(order);
  }
  return { run };
};
