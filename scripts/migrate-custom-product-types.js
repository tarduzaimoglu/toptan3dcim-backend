'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const UID = 'api::custom-product-type.custom-product-type';

function sourceBase() {
  const value = String(process.env.CUSTOM_PRODUCTS_SOURCE_URL || '').replace(/\/$/, '');
  if (!value.startsWith('https://')) {
    throw new Error('CUSTOM_PRODUCTS_SOURCE_URL must be an explicit HTTPS origin');
  }
  return value;
}

function safeExtension(media) {
  const extension = String(media.ext || path.extname(media.name || '')).toLowerCase();
  if (!/^\.[a-z0-9]{1,10}$/.test(extension)) throw new Error(`Invalid media extension for ${media.name}`);
  return extension;
}

async function downloadMedia(base, item, tempRoot) {
  const media = item.image;
  if (!media?.url || !String(media.mime || '').startsWith('image/')) {
    throw new Error(`Published source item ${item.slug} has no valid image`);
  }

  const response = await fetch(new URL(media.url, base), { redirect: 'error' });
  if (!response.ok) throw new Error(`Media download failed for ${item.slug}: HTTP ${response.status}`);
  const contentType = String(response.headers.get('content-type') || '').split(';')[0];
  if (!contentType.startsWith('image/')) throw new Error(`Unexpected media type for ${item.slug}`);

  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error(`Invalid media size for ${item.slug}`);
  const name = `custom-products-${item.slug}${safeExtension(media)}`;
  const filepath = path.join(tempRoot, name);
  await fs.promises.writeFile(filepath, bytes, { mode: 0o600 });
  return { filepath, name, size: bytes.length, mimetype: contentType };
}

async function ensureMedia(strapi, base, item, tempRoot) {
  const expectedName = `custom-products-${item.slug}${safeExtension(item.image)}`;
  const existing = await strapi.db.query('plugin::upload.file').findOne({ where: { name: expectedName } });
  if (existing) return { media: existing, created: false };

  const file = await downloadMedia(base, item, tempRoot);
  const uploaded = await strapi.plugin('upload').service('upload').upload({
    files: {
      filepath: file.filepath,
      originalFileName: file.name,
      size: file.size,
      mimetype: file.mimetype,
    },
    data: {
      fileInfo: {
        name: file.name,
        alternativeText: item.title,
        caption: `Custom product type: ${item.slug}`,
      },
    },
  });
  if (!uploaded?.[0]) throw new Error(`Upload service returned no media for ${item.slug}`);
  return { media: uploaded[0], created: true };
}

async function main() {
  const base = sourceBase();
  const response = await fetch(`${base}/api/custom-product-types?sort=order:asc&populate[0]=image&pagination[pageSize]=100`);
  if (!response.ok) throw new Error(`Source API failed: HTTP ${response.status}`);
  const payload = await response.json();
  const sourceItems = Array.isArray(payload?.data) ? payload.data : [];
  if (!sourceItems.length) throw new Error('Source API returned no custom product types');

  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'custom-products-'));
  let createdRecords = 0;
  let updatedRecords = 0;
  let createdMedia = 0;

  try {
    for (const item of sourceItems) {
      if (!item.slug || !item.title || !item.publishedAt) throw new Error('Source contains an invalid or unpublished record');
      const { media, created } = await ensureMedia(app, base, item, tempRoot);
      if (created) createdMedia += 1;
      const data = {
        title: item.title,
        slug: item.slug,
        order: Number.isInteger(item.order) ? item.order : 0,
        isActive: item.isActive !== false,
        image: media.id,
      };
      const existing = await app.documents(UID).findFirst({ filters: { slug: { $eq: item.slug } } });
      if (existing) {
        await app.documents(UID).update({ documentId: existing.documentId, data });
        await app.documents(UID).publish({ documentId: existing.documentId });
        updatedRecords += 1;
      } else {
        await app.documents(UID).create({ data, status: 'published' });
        createdRecords += 1;
      }
    }

    const destination = await app.documents(UID).findMany({ status: 'published', populate: ['image'] });
    const migratedSlugs = new Set(sourceItems.map((item) => item.slug));
    const verified = destination.filter((item) => migratedSlugs.has(item.slug));
    if (verified.length !== sourceItems.length || verified.some((item) => !item.image?.url)) {
      throw new Error(`Destination verification failed: expected ${sourceItems.length}, found ${verified.length}`);
    }

    console.log(JSON.stringify({
      sourceRecords: sourceItems.length,
      createdRecords,
      updatedRecords,
      createdMedia,
      verifiedRecords: verified.length,
      destinationMediaUrls: verified.map((item) => item.image.url),
    }));
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
    await app.destroy();
  }
}

main().catch((error) => {
  console.error(`Custom product migration failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
