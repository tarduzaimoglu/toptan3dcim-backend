// import type { Core } from '@strapi/strapi';

export default {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register(/* { strapi }: { strapi: Core.Strapi } */) {},

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  async bootstrap({ strapi }: any) {
    // Public package records are safe to display while authenticated requests
    // and private-photo submission remain feature-gated. Seed only missing
    // keys so staff-managed edits are preserved across restarts.
    await strapi.service('api::customer.customer').setupFigurinePackages();
    if (process.env.CUSTOMER_ACCOUNTS_ENABLED === 'true') {
      if (!process.env.CUSTOMER_BFF_SECRET || Buffer.byteLength(process.env.CUSTOMER_BFF_SECRET) < 32) throw new Error('CUSTOMER_BFF_SECRET must be at least 32 bytes');
      const { encryptionKey } = require('./customer/security');
      encryptionKey();
      const origin = new URL(process.env.CUSTOMER_PUBLIC_ORIGIN || '');
      if (process.env.NODE_ENV === 'production' && origin.protocol !== 'https:') throw new Error('Customer origin must use HTTPS in production');
      if (process.env.CUSTOMER_SCHEMA_SETUP === 'true') await strapi.service('api::customer.customer').setup();
      strapi.db.lifecycles.subscribe({
        models: ['plugin::users-permissions.user'],
        beforeCreate(event: any) {
          if (typeof event.params.data.email === 'string') event.params.data.email = event.params.data.email.trim().toLowerCase();
        },
        beforeUpdate(event: any) {
          if (typeof event.params.data.email === 'string') event.params.data.email = event.params.data.email.trim().toLowerCase();
        },
        async beforeUpdateMany(event: any) {
          const data = event.params.data;
          if (data.blocked === true || data.password !== undefined || data.email !== undefined) {
            event.state.customerIds = (await strapi.db.query('plugin::users-permissions.user').findMany({ where: event.params.where, select: ['id'] })).map((u: any) => u.id);
          }
        },
        async afterUpdateMany(event: any) {
          for (const id of event.state.customerIds || []) await strapi.service('api::customer.customer').revokeUser(id);
        },
        async afterUpdate(event: any) {
          const data = event.params.data;
          if (event.result?.id && (data.blocked === true || data.password !== undefined || data.email !== undefined)) {
            await strapi.service('api::customer.customer').revokeUser(event.result.id);
          }
        },
      });
      // Integration suites drive queue workers explicitly to avoid wall-clock races.
      if (process.env.NODE_ENV !== 'test') {
        strapi.cron.add({ customerCleanup: { task: () => strapi.service('api::customer.customer').cleanup(), options: { rule: '*/15 * * * *' } } });
        strapi.cron.add({ customerMail: { task: () => strapi.service('api::customer.customer').flushMail(), options: { rule: '* * * * *' } } });
        if (process.env.FIGURINE_REQUESTS_ENABLED === 'true') {
          strapi.cron.add({ figurineUploadCleanup: { task: () => strapi.service('api::customer.customer').figurineCleanup(), options: { rule: '*/15 * * * *' } } });
          strapi.cron.add({ figurineNotificationOutbox: { task: () => strapi.service('api::customer.customer').figurineOutbox(), options: { rule: '* * * * *' } } });
        }
      }
    }
    const publicRole = await strapi.db.query('plugin::users-permissions.role').findOne({
      where: { type: 'public' },
    });

    if (!publicRole) {
      strapi.log.warn('[custom-product-types] Public role not found; read permissions were not configured.');
      return;
    }

    for (const action of [
      'api::custom-product-type.custom-product-type.find',
      'api::custom-product-type.custom-product-type.findOne',
    ]) {
      const existing = await strapi.db.query('plugin::users-permissions.permission').findOne({
        where: { action, role: publicRole.id },
      });

      if (!existing) {
        await strapi.db.query('plugin::users-permissions.permission').create({
          data: { action, role: publicRole.id },
        });
      }
    }
  },
};
