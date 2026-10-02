export default ({ strapi }: any) => ({
  async initiate(ctx: any) {
    // Retired direct endpoint: checkout must pass the same-origin CSRF-protected BFF.
    ctx.status = 404; ctx.body = { message: 'Bulunamadı.' };
  },
  async callback(ctx: any) {
    if (!process.env.FRONTEND_URL) { ctx.status = 503; ctx.body = 'Sunucu yapılandırma hatası'; return; }
    let result: any;
    try { result = await strapi.service('api::payment.payment').handleCallback(ctx.request.body || {}); }
    catch { strapi.log.error('payment callback unavailable'); result = { success: false }; }
    // This redirect never proves payment. Both pages verify the authorized Order on the server.
    const target = new URL(result.success ? '/payment/success' : '/payment/failure', process.env.FRONTEND_URL);
    if (result.orderNumber) target.searchParams.set('order', result.orderNumber);
    ctx.set('Cache-Control', 'no-store'); ctx.set('Referrer-Policy', 'no-referrer'); ctx.redirect(target.href);
  },
});
