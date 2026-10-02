import { CustomerError } from '../../../customer/security';
export default ({ strapi }: any) => ({
  async dispatch(ctx: any) {
    try {
      ctx.set('Cache-Control', 'no-store');
      ctx.body = await strapi.service('api::customer.customer').dispatch(ctx.request.body, ctx.get('x-customer-session'), ctx.get('x-customer-client'));
    } catch (err) {
      ctx.status = err instanceof CustomerError ? err.status : 503;
      ctx.body = { message: err instanceof CustomerError ? err.message : 'Hesap hizmetine şu anda erişilemiyor. Lütfen tekrar deneyin.' };
      // Do not log error objects: SMTP/auth errors can contain credentials or tokens.
      if (!(err instanceof CustomerError)) strapi.log.error('[customer] operation failed');
    }
  },
});
