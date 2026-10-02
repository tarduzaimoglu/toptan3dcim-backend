import { CustomerError } from '../customer/security';
export async function operator(strapi: any, adminId: number) {
  if (!Number.isSafeInteger(adminId)) throw new CustomerError(403, 'Operasyon yetkisi gerekli.');
  const admin = await strapi.db.query('admin::user').findOne({ where: { id: adminId, isActive: true }, populate: ['roles'] });
  if (!admin?.roles.some(r => ['strapi-super-admin', 'order-operator'].includes(r.code))) throw new CustomerError(403, 'Operasyon yetkisi gerekli.');
  return admin;
}
export async function dataAdministrator(strapi: any, adminId: number) {
  const configured = (process.env.CUSTOMER_DATA_ADMIN_ROLE_NAMES || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!configured.length || !Number.isSafeInteger(adminId)) throw new CustomerError(403, 'MÃ¼ÅŸteri verisi yÃ¶netim yetkisi gerekli.');
  const admin = await strapi.db.query('admin::user').findOne({ where: { id: adminId, isActive: true }, populate: ['roles'] });
  if (!admin?.roles?.some((r: any) => configured.includes(r.code) || configured.includes(r.name))) throw new CustomerError(403, 'MÃ¼ÅŸteri verisi yÃ¶netim yetkisi gerekli.');
  return admin;
}
