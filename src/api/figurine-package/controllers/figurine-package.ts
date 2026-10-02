import storage from '../../../commerce/figurine-storage';

const uid = 'api::figurine-package.figurine-package';
const settingsUid = 'api::figurine-settings.figurine-settings';

export default ({ strapi }: any) => ({
  async catalog(ctx: any) {
    ctx.set('Cache-Control', 'no-store');
    ctx.set('X-Content-Type-Options', 'nosniff');
    const records = await strapi.db.query(uid).findMany({
      where: { active: true },
      orderBy: { sortOrder: 'asc' },
      select: ['documentId', 'key', 'title', 'description', 'style', 'characters', 'pets', 'startingPrice', 'showPrice'],
    });
    const settings = await strapi.db.query(settingsUid).findOne({});
    const reasons: string[] = [];
    if (process.env.CUSTOMER_ACCOUNTS_ENABLED !== 'true') reasons.push('account_service_disabled');
    if (process.env.FIGURINE_REQUESTS_ENABLED !== 'true') reasons.push('request_submission_disabled');
    if (!storage.isReady()) reasons.push('private_photo_storage_unavailable');
    if (!settings?.privacyNotice?.trim() || !settings?.privacyVersion?.trim()) reasons.push('privacy_notice_unpublished');
    if (!process.env.CUSTOMER_SMTP_HOST || !process.env.CUSTOMER_SMTP_USER || !process.env.CUSTOMER_SMTP_PASS || !process.env.CUSTOMER_MAIL_FROM) reasons.push('transactional_email_unavailable');
    ctx.body = {
      packages: records.map((item: any) => ({
        id: item.documentId,
        key: item.key,
        title: item.title,
        description: item.description || '',
        style: item.style,
        characters: item.characters,
        pets: item.pets,
        startingPrice: item.showPrice ? item.startingPrice ?? null : null,
        priceLabel: !item.showPrice || item.startingPrice == null ? 'Teklif alın' : `₺${Number(item.startingPrice).toLocaleString('tr-TR')}`,
        priceKind: item.showPrice && item.startingPrice != null ? 'starting' : 'quote',
        gallery: [],
      })),
      priceScopeNote: settings?.priceScopeNote || '',
      customerContactNote: settings?.customerContactNote || '',
      privacyNotice: settings?.privacyNotice || '',
      privacyVersion: settings?.privacyVersion || '',
      submissionEnabled: reasons.length === 0 && records.length > 0,
      submissionBlockReasons: reasons,
      limits: storage.limits(),
    };
  },
});
