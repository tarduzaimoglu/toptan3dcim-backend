/**
 * One-off migration: convert existing PNG/JPG media library assets (and their
 * thumbnail/small/medium/large formats) to WebP, quality 80, in place on
 * Supabase storage, then update the matching plugin::upload.file records.
 *
 * Usage:
 *   npx tsx scripts/convert-to-webp.ts --dry-run   (lists what would happen, changes nothing)
 *   npx tsx scripts/convert-to-webp.ts --execute   (performs the migration)
 *
 * Safety: for each asset, new WebP copies are uploaded first; the DB record
 * is only updated once every copy (main + all formats) succeeded; the old
 * originals are deleted only after the DB update succeeds. If anything fails
 * partway through an asset, that asset is skipped (old files stay live) and
 * the script moves on to the next one.
 */

import path from 'path';
import sharp from 'sharp';
import { compileStrapi, createStrapi } from '@strapi/strapi';
import type { Core } from '@strapi/strapi';

const WEBP_QUALITY = 80;
const PAGE_SIZE = 50;
const CONVERTIBLE_MIME_TYPES = ['image/png', 'image/jpeg'];

type StoredFormat = {
  name: string;
  hash: string;
  ext: string;
  mime: string;
  width?: number;
  height?: number;
  size: number;
  sizeInBytes?: number;
  path?: string | null;
  url: string;
  [key: string]: unknown;
};

type UploadFileRecord = {
  id: number;
  name: string;
  hash: string;
  ext: string | null;
  mime: string;
  size: number;
  url: string;
  formats: Record<string, StoredFormat> | null;
};

type StorageProvider = {
  upload: (file: Record<string, unknown>) => Promise<void>;
  delete: (file: Record<string, unknown>) => Promise<unknown>;
};

type ConvertedAsset = {
  key: 'main' | string;
  original: { hash: string; ext: string | null; path?: string | null };
  webp: {
    ext: '.webp';
    mime: 'image/webp';
    url: string;
    size: number;
    sizeInBytes: number;
    width?: number;
    height?: number;
  };
};

type Report = {
  scanned: number;
  converted: number;
  failed: { id: number; name: string; error: string }[];
  cleanupWarnings: string[];
  bytesBefore: number;
  bytesAfter: number;
};

const bytesToKbytes = (bytes: number) => Math.round((bytes / 1000) * 100) / 100;

const renameToWebp = (name: string): string => {
  const ext = path.extname(name);
  if (/^\.(png|jpe?g)$/i.test(ext)) {
    return `${name.slice(0, -ext.length)}.webp`;
  }
  return name;
};

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry-run'),
    execute: args.includes('--execute'),
  };
}

async function downloadBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`İndirme başarısız (HTTP ${response.status}): ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

// Uploads a WebP copy of one asset (the main file, or one of its formats)
// under the SAME hash but a .webp extension. Does not touch the original.
async function uploadWebpCopy(
  provider: StorageProvider,
  asset: { hash: string; path?: string | null; url: string }
): Promise<{ url: string; size: number; sizeInBytes: number; width?: number; height?: number }> {
  const originalBuffer = await downloadBuffer(asset.url);
  const webpBuffer = await sharp(originalBuffer).webp({ quality: WEBP_QUALITY }).toBuffer();
  const metadata = await sharp(webpBuffer).metadata();

  const newFile: Record<string, unknown> & { url?: string } = {
    hash: asset.hash,
    ext: '.webp',
    mime: 'image/webp',
    path: asset.path ?? undefined,
    buffer: webpBuffer,
  };

  await provider.upload(newFile);

  return {
    url: newFile.url as string,
    size: bytesToKbytes(webpBuffer.length),
    sizeInBytes: webpBuffer.length,
    width: metadata.width,
    height: metadata.height,
  };
}

async function processFile(
  strapi: Core.Strapi,
  dbFile: UploadFileRecord,
  dryRun: boolean,
  report: Report
) {
  console.log(`${dryRun ? '[DRY-RUN] ' : ''}#${dbFile.id} ${dbFile.name} (${dbFile.mime}) işleniyor...`);

  const originalBytesTotal =
    dbFile.size * 1000 +
    Object.values(dbFile.formats ?? {}).reduce((sum, f) => sum + f.size * 1000, 0);

  if (dryRun) {
    const formatKeys = Object.keys(dbFile.formats ?? {});
    console.log(
      `  -> WebP'ye dönüştürülecek (kalite ${WEBP_QUALITY}). Formatlar: ${
        formatKeys.length ? formatKeys.join(', ') : '(yok)'
      }`
    );
    report.converted += 1;
    report.bytesBefore += originalBytesTotal;
    return;
  }

  const provider = strapi.plugin('upload').provider as StorageProvider;

  // Phase 1: upload every WebP copy (main + formats). Nothing old is deleted yet.
  const converted: ConvertedAsset[] = [];

  const mainResult = await uploadWebpCopy(provider, {
    hash: dbFile.hash,
    path: null,
    url: dbFile.url,
  });
  converted.push({
    key: 'main',
    original: { hash: dbFile.hash, ext: dbFile.ext, path: null },
    webp: { ext: '.webp', mime: 'image/webp', ...mainResult },
  });

  const newFormats: Record<string, StoredFormat> = {};
  for (const [key, format] of Object.entries(dbFile.formats ?? {})) {
    const formatResult = await uploadWebpCopy(provider, {
      hash: format.hash,
      path: format.path ?? null,
      url: format.url,
    });
    converted.push({
      key,
      original: { hash: format.hash, ext: format.ext, path: format.path ?? null },
      webp: { ext: '.webp', mime: 'image/webp', ...formatResult },
    });
    newFormats[key] = {
      ...format,
      ext: '.webp',
      mime: 'image/webp',
      url: formatResult.url,
      size: formatResult.size,
      sizeInBytes: formatResult.sizeInBytes,
      width: formatResult.width ?? format.width,
      height: formatResult.height ?? format.height,
    };
  }

  // Phase 2: persist the new metadata. Only after this succeeds do we touch the old files.
  await strapi.db.query('plugin::upload.file').update({
    where: { id: dbFile.id },
    data: {
      name: renameToWebp(dbFile.name),
      ext: '.webp',
      mime: 'image/webp',
      url: mainResult.url,
      size: mainResult.size,
      formats: dbFile.formats ? newFormats : dbFile.formats,
    },
  });

  // Phase 3: best-effort cleanup of the old originals. A failure here doesn't
  // affect correctness (the DB already points at the new WebP files) so we
  // only warn, we don't fail the asset.
  for (const asset of converted) {
    try {
      await provider.delete({
        hash: asset.original.hash,
        ext: asset.original.ext ?? undefined,
        path: asset.original.path ?? undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.cleanupWarnings.push(
        `#${dbFile.id} ${dbFile.name} [${asset.key}]: eski dosya silinemedi (${asset.original.hash}${asset.original.ext ?? ''}) -> ${message}`
      );
    }
  }

  const newBytesTotal = converted.reduce((sum, asset) => sum + asset.webp.sizeInBytes, 0);

  report.converted += 1;
  report.bytesBefore += originalBytesTotal;
  report.bytesAfter += newBytesTotal;
}

async function main() {
  const { dryRun, execute } = parseArgs();

  if (!dryRun && !execute) {
    console.log('Kullanım:');
    console.log('  npx tsx scripts/convert-to-webp.ts --dry-run   (önce bunu çalıştırın)');
    console.log('  npx tsx scripts/convert-to-webp.ts --execute   (gerçek dönüşüm)');
    process.exit(1);
  }

  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  const report: Report = {
    scanned: 0,
    converted: 0,
    failed: [],
    cleanupWarnings: [],
    bytesBefore: 0,
    bytesAfter: 0,
  };

  try {
    // Successful conversions change `mime` away from CONVERTIBLE_MIME_TYPES,
    // so the matching set shrinks as we go — an incrementing `offset` would
    // skip rows. Instead we exclude every id we've already seen (converted
    // or failed) and always ask for the next page from the top.
    const processedIds: number[] = [];
    for (;;) {
      const files = (await app.db.query('plugin::upload.file').findMany({
        where: {
          mime: { $in: CONVERTIBLE_MIME_TYPES },
          ...(processedIds.length > 0 ? { id: { $notIn: processedIds } } : {}),
        },
        orderBy: { id: 'asc' },
        limit: PAGE_SIZE,
      })) as UploadFileRecord[];

      if (files.length === 0) break;

      for (const file of files) {
        report.scanned += 1;
        processedIds.push(file.id);
        try {
          await processFile(app, file, dryRun, report);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          report.failed.push({ id: file.id, name: file.name, error: message });
          console.error(`  HATA, atlanıyor: #${file.id} ${file.name} -> ${message}`);
        }
      }
    }
  } finally {
    console.log('\n=== ÖZET ===');
    console.log(`Mod: ${dryRun ? 'DRY-RUN (hiçbir şey değiştirilmedi)' : 'GERÇEK ÇALIŞTIRMA'}`);
    console.log(`Taranan PNG/JPG asset: ${report.scanned}`);
    console.log(`Dönüştürülen: ${report.converted}`);
    console.log(`Hatalı (atlanan): ${report.failed.length}`);
    if (report.failed.length > 0) {
      report.failed.forEach((f) => console.log(`  - #${f.id} ${f.name}: ${f.error}`));
    }
    if (report.cleanupWarnings.length > 0) {
      console.log(`Eski dosya silme uyarıları: ${report.cleanupWarnings.length}`);
      report.cleanupWarnings.forEach((w) => console.log(`  - ${w}`));
    }
    if (report.bytesBefore > 0) {
      const beforeMb = report.bytesBefore / 1024 / 1024;
      const afterMb = report.bytesAfter / 1024 / 1024;
      const label = dryRun ? 'Tahmini boyut' : 'Toplam boyut';
      if (!dryRun) {
        const savedPct = (((report.bytesBefore - report.bytesAfter) / report.bytesBefore) * 100).toFixed(1);
        console.log(`${label}: ${beforeMb.toFixed(2)} MB -> ${afterMb.toFixed(2)} MB (%${savedPct} azalma)`);
      } else {
        console.log(`${label} (önce): ${beforeMb.toFixed(2)} MB`);
      }
    }

    await app.destroy();
  }

  process.exit(report.failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
