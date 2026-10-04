import { CustomerError } from '../../../../../customer/security';
export default ({ strapi }: any) => ({
  async dashboard(ctx: any) {
    try { ctx.body = await strapi.service('api::customer.customer').figurineAdminDashboard(ctx.state.user); ctx.set('Cache-Control', 'no-store'); }
    catch (e: any) { ctx.status = e instanceof CustomerError ? e.status : 503; ctx.body = { message: e instanceof CustomerError ? e.message : 'Operasyon listesi açılamadı.' }; }
  },
  async find(ctx: any) {
    try { ctx.body = { requests: await strapi.service('api::customer.customer').figurineAdminList(ctx.state.user) }; ctx.set('Cache-Control', 'no-store'); }
    catch (e: any) { ctx.status = e instanceof CustomerError ? e.status : 503; ctx.body = { message: e instanceof CustomerError ? e.message : 'Talep listesi açılamadı.' }; }
  },
  async detail(ctx: any) {
    try { ctx.body = await strapi.service('api::customer.customer').figurineAdminDetail(ctx.state.user, ctx.params.requestId); ctx.set('Cache-Control', 'no-store'); }
    catch (e: any) { ctx.status = e instanceof CustomerError ? e.status : 503; ctx.body = { message: e instanceof CustomerError ? e.message : 'Talep detayı açılamadı.' }; }
  },
  async orderDetail(ctx: any) {
    try { ctx.body = await strapi.service('api::customer.customer').figurineAdminOrderDetail(ctx.state.user, ctx.params.orderId); ctx.set('Cache-Control', 'no-store'); }
    catch (e: any) { ctx.status = e instanceof CustomerError ? e.status : 503; ctx.body = { message: e instanceof CustomerError ? e.message : 'Sipariş açılamadı.' }; }
  },
  async requestUpdate(ctx: any) {
    try { ctx.body = await strapi.service('api::customer.customer').figurineAdminRequestUpdate(ctx.state.user, ctx.params.requestId, ctx.request.body || {}); ctx.set('Cache-Control', 'no-store'); }
    catch (e: any) { ctx.status = e instanceof CustomerError ? e.status : 503; ctx.body = { message: e instanceof CustomerError ? e.message : 'Talep güncellenemedi.' }; }
  },
  async saveOffer(ctx: any) {
    try { ctx.body = await strapi.service('api::customer.customer').figurineAdminSaveOffer(ctx.state.user, ctx.params.requestId, ctx.request.body || {}, false); ctx.set('Cache-Control', 'no-store'); }
    catch (e: any) { ctx.status = e instanceof CustomerError ? e.status : 503; ctx.body = { message: e instanceof CustomerError ? e.message : 'Teklif taslağı kaydedilemedi.' }; }
  },
  async presentOffer(ctx: any) {
    try { ctx.body = await strapi.service('api::customer.customer').figurineAdminSaveOffer(ctx.state.user, ctx.params.requestId, { ...(ctx.request.body || {}), offerId: ctx.params.offerId }, true); ctx.set('Cache-Control', 'no-store'); }
    catch (e: any) { ctx.status = e instanceof CustomerError ? e.status : 503; ctx.body = { message: e instanceof CustomerError ? e.message : 'Teklif sunulamadı.' }; }
  },
  async withdrawOffer(ctx: any) {
    try { ctx.body = await strapi.service('api::customer.customer').figurineAdminWithdrawOffer(ctx.state.user, ctx.params.requestId, ctx.params.offerId); ctx.set('Cache-Control', 'no-store'); }
    catch (e: any) { ctx.status = e instanceof CustomerError ? e.status : 503; ctx.body = { message: e instanceof CustomerError ? e.message : 'Teklif geri çekilemedi.' }; }
  },
  async operation(ctx: any) {
    try { ctx.body = await strapi.service('api::customer.customer').figurineAdminOperation(ctx.state.user, ctx.params.orderId, ctx.request.body || {}); ctx.set('Cache-Control', 'no-store'); }
    catch (e: any) { ctx.status = e instanceof CustomerError ? e.status : 503; ctx.body = { message: e instanceof CustomerError ? e.message : 'Sipariş güncellenemedi.' }; }
  },
  async returnList(ctx: any) {
    try { ctx.body = { returnRequests: await strapi.service('api::customer.customer').figurineAdminReturnList(ctx.state.user) }; ctx.set('Cache-Control', 'no-store'); }
    catch (e: any) { ctx.status = e instanceof CustomerError ? e.status : 503; ctx.body = { message: e instanceof CustomerError ? e.message : 'Başvurular açılamadı.' }; }
  },
  async returnDecision(ctx: any) {
    try { ctx.body = await strapi.service('api::customer.customer').figurineAdminReturnDecision(ctx.state.user, ctx.params.id, ctx.request.body || {}); ctx.set('Cache-Control', 'no-store'); }
    catch (e: any) { ctx.status = e instanceof CustomerError ? e.status : 503; ctx.body = { message: e instanceof CustomerError ? e.message : 'Başvuru güncellenemedi.' }; }
  },
  async photo(ctx: any) {
    try {
      const image = await strapi.service('api::customer.customer').figurineAdminPhoto(ctx.state.user, ctx.params.requestId, ctx.params.assetKey);
      ctx.type = 'image/webp'; ctx.body = image; ctx.set('Cache-Control', 'private, no-store, max-age=0'); ctx.set('X-Content-Type-Options', 'nosniff');
    } catch (e: any) { ctx.status = e instanceof CustomerError ? e.status : 503; ctx.body = { message: e instanceof CustomerError ? e.message : 'Fotoğraf açılamadı.' }; }
  },
  async notifications(ctx: any) {
    try { ctx.body = { notifications: await strapi.service('api::customer.customer').figurineAdminOutbox(ctx.state.user) }; ctx.set('Cache-Control', 'no-store'); }
    catch (e: any) { ctx.status = e instanceof CustomerError ? e.status : 503; ctx.body = { message: e instanceof CustomerError ? e.message : 'Bildirim kuyruğu açılamadı.' }; }
  },
  async retryNotification(ctx: any) {
    try { ctx.body = await strapi.service('api::customer.customer').figurineAdminRetryOutbox(ctx.state.user, ctx.params.id); ctx.set('Cache-Control', 'no-store'); }
    catch (e: any) { ctx.status = e instanceof CustomerError ? e.status : 503; ctx.body = { message: e instanceof CustomerError ? e.message : 'Bildirim yeniden kuyruğa alınamadı.' }; }
  },
  async deletionList(ctx: any) {
    try { ctx.body = await strapi.service('api::customer.customer').accountDeletionAdminList(ctx.state.user); ctx.set('Cache-Control', 'no-store'); }
    catch (e: any) { ctx.status = e instanceof CustomerError ? e.status : 503; ctx.body = { message: e instanceof CustomerError ? e.message : 'Başvurular açılamadı.' }; }
  },
  async deletionDecision(ctx: any) {
    try { ctx.body = await strapi.service('api::customer.customer').accountDeletionAdminDecision(ctx.state.user, ctx.params.id, ctx.request.body || {}); ctx.set('Cache-Control', 'no-store'); }
    catch (e: any) { ctx.status = e instanceof CustomerError ? e.status : 503; ctx.body = { message: e instanceof CustomerError ? e.message : 'Karar kaydedilemedi.' }; }
  },
  async retentionPreview(ctx: any) {
    try { ctx.body = await strapi.service('api::customer.customer').figurineRetentionPreview(ctx.state.user); ctx.set('Cache-Control', 'no-store'); }
    catch (e: any) { ctx.status = e instanceof CustomerError ? e.status : 503; ctx.body = { message: e instanceof CustomerError ? e.message : 'Saklama ön izlemesi açılamadı.' }; }
  },
  async retentionExecute(ctx: any) {
    try { ctx.body = await strapi.service('api::customer.customer').figurineRetentionExecute(ctx.state.user, ctx.request.body || {}); ctx.set('Cache-Control', 'no-store'); }
    catch (e: any) { ctx.status = e instanceof CustomerError ? e.status : 503; ctx.body = { message: e instanceof CustomerError ? e.message : 'Saklama işlemi tamamlanamadı.' }; }
  },
  async guestClaims(ctx: any) {
    try { ctx.body = await strapi.service('api::customer.customer').guestClaimAdminList(ctx.state.user); ctx.set('Cache-Control', 'no-store'); }
    catch (e: any) { ctx.status = e instanceof CustomerError ? e.status : 503; ctx.body = { message: e instanceof CustomerError ? e.message : 'Sipariş sahiplenme incelemeleri açılamadı.' }; }
  },
});
