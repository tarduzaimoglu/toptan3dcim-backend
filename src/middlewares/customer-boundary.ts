import { equal } from '../customer/security';

export default () => async (ctx: any, next: any) => {
  // Deny generic Content API access regardless of database role permissions.
  // Admin endpoints are /admin and /content-manager and remain separate.
  const path = ctx.path.replace(/\/+$/, '').toLowerCase();
  // These records may only be mutated through the capability-checked workflow UI.
  if (/^\/content-manager\/(collection-types|single-types)\/(api::order\.order|api::figurine-(request|offer|response|return-request|outbox|private-asset|upload-session)\.figurine-[^/]+)(\/|$)/.test(path)) {
    ctx.status = 404; ctx.body = { error: { message: 'Not found.' } }; return;
  }
  if (/^\/api\/(orders|users|auth|payment-attempts|cart-merges|operation-events|figurine-(packages|requests|drafts|upload-sessions|private-assets|outboxes|settings|offers|responses|return-requests))(\/|$)/.test(path) || /^\/api\/customer-(profiles|addresses|sessions|actions|rates|mails|carts)(\/|$)/.test(path)) {
    ctx.status = 404; ctx.body = { error: { message: 'Bulunamadı.' } }; return;
  }
  // All initiation goes through the same-origin BFF with CSRF and authenticated ownership.
  // The bank callback remains publicly reachable and verifies the bank MAC before changing Order.
  if (path === '/api/payment/initiate') { ctx.status = 404; ctx.body = { message: 'Bulunamadı.' }; return; }
  if (/^\/api\/customer(\/|$)/.test(path)) {
    if (process.env.CUSTOMER_ACCOUNTS_ENABLED !== 'true') { ctx.status = 503; ctx.body = { code: 'ACCOUNT_FEATURE_DISABLED', message: 'Hesap hizmeti etkin değil.' }; return; }
    const key = process.env.CUSTOMER_BFF_SECRET || '';
    if (!key || !equal(ctx.get('x-customer-bff-key'), key)) { ctx.status = 404; ctx.body = { message: 'Bulunamadı.' }; return; }
  }
  await next();
};
