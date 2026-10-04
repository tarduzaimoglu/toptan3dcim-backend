import { CustomerError, digest, fields, text } from '../customer/security';
import pricing from '../api/payment/services/pricing';

export default (strapi: any) => {
  const carts = () => strapi.db.query('api::customer-cart.customer-cart');
  const merges = () => strapi.db.query('api::cart-merge.cart-merge');
  const meta = () => strapi.db.metadata.get('api::customer-cart.customer-cart');
  async function cart(owner: number) {
    const ownerKey = String(owner);
    let row = await carts().findOne({ where: { ownerKey } });
    if (!row) {
      try { row = await carts().create({ data: { ownerKey, owner, revision: 0, lines: [] } }); }
      catch (e) { row = await carts().findOne({ where: { ownerKey } }); if (!row) throw e; }
    }
    return row;
  }
  async function quote(input: any) {
    if (!Array.isArray(input) || input.length > 100) throw new CustomerError(400, 'Sepette en fazla 100 satır olabilir.');
    const lines: any[] = [], warnings: string[] = [], keys = new Set();
    let subtotal = 0, discountTotal = 0;
    for (const row of input) {
      fields(row, ['productId', 'qty', 'variant', 'price']);
      const id = text(String(row.productId ?? ''), 100, true);
      const filter = /^\d+$/.test(id) ? { id: Number(id) } : { documentId: id };
      const [product] = await strapi.documents('api::product.product').findMany({ status: 'published', filters: filter, populate: ['variants', 'image'], limit: 1 });
      let problem = !product || product.isActive === false ? 'Ürün satışa kapalı veya bulunamadı.' : '';
      const qty = Number(row.qty), min = Math.max(1, product?.minQty || 1);
      if (typeof row.qty !== 'number' || !Number.isSafeInteger(qty) || qty < min || qty > 2000) problem = `Adet ${min}–2000 arasında tam sayı olmalı.`;
      const color = row.variant == null ? '' : text(row.variant.colorName, 100, true);
      if (row.variant != null) fields(row.variant, ['colorName']);
      const variants = product?.variants || [];
      // A color is accepted only if it matches exactly one configured variant.
      if (variants.length ? variants.filter(v => v.ColorName === color).length !== 1 : Boolean(color)) problem = 'Ürün için tanımlı bir varyant seçin.';
      const base = Number(product?.wholesalePrice);
      if (!Number.isFinite(base) || base < 0) problem = 'Ürünün satış fiyatı geçersiz.';
      if (problem) { warnings.push(`${product?.title || id}: ${problem}`); lines.push({ ...row, invalid: true, problem }); continue; }
      const productId = product.documentId, key = `${productId}:${color}`;
      if (keys.has(key)) throw new CustomerError(400, 'Aynı ürün/varyant için tek sepet satırı kullanın.');
      keys.add(key);
      const unit = Math.round(pricing.effectiveUnitPriceTRY(base, qty) * 100), total = Math.round(pricing.effectiveUnitPriceTRY(base, qty) * qty * 100);
      subtotal += Math.round(base * qty * 100); discountTotal += Math.round(base * qty * 100) - total;
      if (row.price != null && Number(row.price) !== base) warnings.push(`${product.title}: fiyat güncellendi.`);
      const productImage = Array.isArray(product.image) ? product.image.find((image: any) => typeof image?.url === 'string') : product.image;
      lines.push({ id: key, productId, sourceProductId: id, qty, variant: color ? { colorName: color } : null, price: base,
        product: { id: productId, title: product.title, wholesalePrice: base, minQty: min, imageUrl: productImage?.url || null },
        isim: product.title, adet: qty, birimFiyat: unit, satirToplami: total });
    }
    const net = subtotal - discountTotal, shippingCost = pricing.shippingFeeForKurus(net);
    const totals = { subtotal, discountTotal, vatTotal: Math.round(net / 6), shippingCost, grandTotal: net + shippingCost, currency: 'TRY' };
    if (Object.values(totals).some(v => typeof v === 'number' && (!Number.isSafeInteger(v) || v < 0 || v > 2147483647))) throw new CustomerError(400, 'Sipariş tutarı desteklenen sınırı aşıyor.');
    return { lines, warnings, ...totals, quoteHash: digest(JSON.stringify({ lines: lines.map(l => [l.productId, l.variant, l.qty, l.price, l.satirToplami]), totals })) };
  }
  const stored = (lines: any[]) => lines.map(l => ({ productId: l.productId, qty: l.qty, variant: l.variant || null, price: l.price }));
  async function lock(row: any, revision: number, trx: any) {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new CustomerError(400, 'Sepet sürümü geçersiz.');
    const count = await strapi.db.connection(meta().tableName).transacting(trx).where({ id: row.id, revision }).update({ revision: revision + 1 });
    if (count !== 1) throw new CustomerError(409, 'Sepet başka bir cihazda değişti. Yenileyip tekrar deneyin.');
  }
  async function view(owner: number) { const row = await cart(owner); return { cart: { ...(await quote(row.lines || [])), revision: row.revision } }; }
  async function save(owner: number, data: any, merge = false) {
    fields(data, merge ? ['items', 'mergeId'] : ['items', 'revision']);
    const row = await cart(owner), payloadHash = digest(JSON.stringify(data.items));
    const mergeKey = merge ? digest(`${owner}:${text(data.mergeId, 100, true)}`) : '';
    await strapi.db.transaction(async ({ trx }) => {
      // Revision CAS is the cross-instance database lock, held until commit.
      const current = await carts().findOne({ where: { id: row.id } });
      await lock(current, merge ? current.revision : data.revision, trx);
      if (merge) {
        const receipt = await merges().findOne({ where: { mergeKey } });
        if (receipt) { if (receipt.payloadHash !== payloadHash) throw new CustomerError(409, 'Birleştirme anahtarı farklı bir sepet için kullanılmış.'); return; }
      }
      let incoming = (await quote(data.items)).lines;
      if (incoming.some(l => l.invalid)) throw new CustomerError(400, (await quote(data.items)).warnings.join(' '));
      if (merge) {
        const base = new Map((current.lines || []).map(l => [`${l.productId}:${l.variant?.colorName || ''}`, l]));
        for (const line of incoming) { const key = line.id; const previous: any = base.get(key); base.set(key, { ...line, qty: line.qty + (previous?.qty || 0) }); }
        const combined = await quote(stored([...base.values()] as any[])); incoming = combined.lines;
        if (incoming.some(l => l.invalid)) throw new CustomerError(400, combined.warnings.join(' '));
        await merges().create({ data: { mergeKey, payloadHash } });
      }
      await carts().update({ where: { id: row.id }, data: { lines: stored(incoming) } });
    });
    return view(owner);
  }
  async function settle(order: any) {
    if (!order.user || order.cartSettled) return;
    const owner = typeof order.user === 'object' ? order.user.id : order.user;
    const row = await cart(owner);
    await strapi.db.transaction(async ({ trx }) => {
      const current = await carts().findOne({ where: { id: row.id } }); await lock(current, current.revision, trx);
      const fresh = await strapi.db.query('api::order.order').findOne({ where: { id: order.id } });
      if (fresh.cartSettled) return;
      const paid = new Map((order.cartSnapshot || []).map(l => [`${l.productId}:${l.variant?.colorName || ''}`, l.qty]));
      const lines = (current.lines || []).map(l => ({ ...l, qty: Math.max(0, l.qty - Number(paid.get(`${l.productId}:${l.variant?.colorName || ''}`) || 0)) })).filter(l => l.qty > 0);
      await carts().update({ where: { id: row.id }, data: { lines } });
      await strapi.db.query('api::order.order').update({ where: { id: order.id }, data: { cartSettled: true } });
    });
  }
  return { cart, quote, stored, lock, view, save, settle };
};
