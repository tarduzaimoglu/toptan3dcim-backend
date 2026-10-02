import { CustomerError } from '../../../customer/security';
async function body(ctx: any, limit: number) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const part of ctx.req) { const chunk = Buffer.from(part); size += chunk.length; if (size > limit) { ctx.req.destroy(); throw new CustomerError(413, 'Dosya boyutu sınırı aşıldı.'); } chunks.push(chunk); }
  return Buffer.concat(chunks);
}
export default ({ strapi }: any) => ({
  async put(ctx: any) {
    try {
      if (process.env.NODE_ENV === 'production' || process.env.FIGURINE_STORAGE_DRIVER !== 'local') throw new CustomerError(404, 'Bulunamadı.');
      const bytes = await body(ctx, Number(process.env.FIGURINE_MAX_FILE_BYTES || 10 * 1024 * 1024));
      ctx.body = await strapi.service('api::customer.customer').localFigurinePut(ctx.params.id, ctx.get('x-local-upload-token'), bytes);
      ctx.set('Cache-Control', 'no-store');
    } catch (e: any) { ctx.status = e instanceof CustomerError ? e.status : 503; ctx.body = { message: e instanceof CustomerError ? e.message : 'Dosya yüklenemedi.' }; }
  },
  async photo(ctx: any) {
    try {
      const image = await strapi.service('api::customer.customer').figurineCustomerPhoto(ctx.get('x-customer-session'), ctx.params.id, ctx.params.assetKey);
      ctx.type = 'image/webp'; ctx.body = image; ctx.set('Cache-Control', 'private, no-store, max-age=0'); ctx.set('X-Content-Type-Options', 'nosniff');
      ctx.set('Content-Security-Policy', "default-src 'none'; sandbox");
    } catch (e: any) { ctx.status = e instanceof CustomerError ? e.status : 404; ctx.body = { message: 'Görsel bulunamadı.' }; }
  },
});
