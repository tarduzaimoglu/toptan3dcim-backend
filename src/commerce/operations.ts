import { CustomerError, fields, text } from '../customer/security';
import { operator } from './authorization';

// Internal service for a future authenticated admin action. No Content API route is exposed.
export default (strapi: any) => ({
  async update(adminId: number, orderId: string, data: any) {
    const admin = await operator(strapi, adminId);
    fields(data, ['fulfillmentState','shippingCarrier','trackingNumber','trackingUrl','fulfillmentCustomerNote','fulfillmentInternalNote']);
    const transitions = { unknown: ['preparing','production','ready','shipped','delivered','cancelled'], preparing: ['production','ready','cancelled'], production: ['ready','cancelled'], ready: ['shipped','cancelled'], shipped: ['delivered'], delivered: [], cancelled: [] };
    const q = strapi.db.query('api::order.order');
    return strapi.db.transaction(async ({ trx }) => {
      const order = await q.findOne({ where: { documentId: orderId }, populate: ['figurineRequest'] });
      if (!order) throw new CustomerError(404, 'Sipariş bulunamadı.');
      const table = strapi.db.metadata.get('api::order.order').tableName;
      await strapi.db.connection(table).transacting(trx).where({ id: order.id }).update({ updated_at: new Date() });
      const fresh = await q.findOne({ where: { id: order.id } });
      const from = fresh.fulfillmentState || 'unknown', to = text(data.fulfillmentState, 30, true);
      if (to !== from && !transitions[from]?.includes(to)) throw new CustomerError(409, 'İzin verilmeyen durum geçişi.');
      if (to !== 'cancelled' && fresh.status !== 'paid') throw new CustomerError(409, 'Ödeme doğrulanmadan hazırlık başlatılamaz.');
      const normalized: any = { fulfillmentState: to };
      const terminalAt = new Date().toISOString();
      if (to !== from && to === 'delivered') normalized.deliveredAt = terminalAt;
      if (to !== from && to === 'cancelled') normalized.cancelledAt = terminalAt;
      for (const field of ['shippingCarrier','trackingNumber']) if (data[field] !== undefined) normalized[field] = text(data[field], 150);
      if (data.fulfillmentCustomerNote !== undefined) normalized.fulfillmentCustomerNote = text(data.fulfillmentCustomerNote, 1000);
      if (data.fulfillmentInternalNote !== undefined) normalized.fulfillmentInternalNote = text(data.fulfillmentInternalNote, 3000);
      if (data.trackingUrl !== undefined) {
        const value = text(data.trackingUrl, 500);
        if (value) { let u: URL; try { u = new URL(value); } catch { throw new CustomerError(400, 'Takip bağlantısı geçersiz.'); } if (u.protocol !== 'https:' || u.username || u.password) throw new CustomerError(400, 'HTTPS takip bağlantısı gerekli.'); }
        normalized.trackingUrl = value;
      }
      if (to === 'shipped' && !(normalized.shippingCarrier || fresh.shippingCarrier) || to === 'shipped' && !(normalized.trackingNumber || fresh.trackingNumber)) throw new CustomerError(400, 'Kargo firması ve takip numarası gerekli.');
      await q.update({ where: { id: order.id }, data: normalized });
      if (order.figurineRequest && to !== from && ['delivered', 'cancelled'].includes(to)) {
        const days = to === 'delivered' ? 90 : 30;
        await strapi.db.query('api::figurine-request.figurine-request').update({ where: { id: order.figurineRequest.id }, data: {
          photoRetentionBasis: to,
          photoRetentionStartedAt: terminalAt,
          photoRetentionDueAt: new Date(Date.parse(terminalAt) + days * 86400000).toISOString(),
        }, transacting: trx });
      }
      await strapi.db.query('api::operation-event.operation-event').create({ data: { order: order.id, actor: `admin:${admin.id}`, fromState: from, toState: to, details: normalized } });
      return { fulfillmentState: to };
    });
  },
});
