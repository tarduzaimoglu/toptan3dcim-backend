/**
 * payment controller
 */

import type { Core } from '@strapi/strapi';
import { PaymentValidationError } from '../services/payment';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async initiate(ctx: any) {
    const body = (ctx.request.body ?? {}) as Record<string, any>;
    const clientIp = ctx.request.ip;

    try {
      const result = await strapi.service('api::payment.payment').initiate(
        {
          items: body.items,
          buyer: body.buyer,
          contractAccepted: body.contractAccepted,
        },
        clientIp
      );
      ctx.body = result;
    } catch (err) {
      if (err instanceof PaymentValidationError) {
        return ctx.badRequest(err.message);
      }
      strapi.log.error(`payment.initiate hata: ${(err as Error).message}`);
      return ctx.internalServerError('Ödeme başlatılamadı');
    }
  },

  async callback(ctx: any) {
    const body = (ctx.request.body ?? {}) as Record<string, unknown>;
    const frontendUrl = process.env.FRONTEND_URL;

    if (!frontendUrl) {
      strapi.log.error('FRONTEND_URL ortam değişkeni tanımlı değil');
      ctx.status = 500;
      ctx.body = 'Sunucu yapılandırma hatası';
      return;
    }

    let result: { success: boolean; orderNumber?: string; reason?: string };
    try {
      result = await strapi.service('api::payment.payment').handleCallback(body);
    } catch (err) {
      strapi.log.error(`payment.callback hata: ${(err as Error).message}`);
      result = { success: false, reason: 'UNEXPECTED_ERROR' };
    }

    const target = new URL(result.success ? '/payment/success' : '/payment/failure', frontendUrl);
    if (result.orderNumber) target.searchParams.set('order', result.orderNumber);
    if (!result.success && result.reason) target.searchParams.set('reason', result.reason);

    ctx.redirect(target.toString());
  },
});
