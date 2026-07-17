import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

// Upload plugin's image-manipulation service works with this shape (see
// @strapi/strapi's packages/core/upload/server/src/types). We only need the
// subset of fields we actually read/write here.
type UploadableFile = {
  name: string;
  hash: string;
  ext?: string;
  mime: string;
  filepath?: string;
  path?: string | null;
  tmpWorkingDirectory?: string;
  getStream: () => NodeJS.ReadableStream;
  width?: number | null;
  height?: number | null;
  size?: number;
  sizeInBytes?: number;
  [key: string]: unknown;
};

const WEBP_QUALITY = 80;

// Only these raster formats get transcoded. webp/avif/tiff/gif pass through
// to the stock optimizer untouched, and svg is never optimizable in Strapi
// to begin with (it's excluded from FORMATS_TO_OPTIMIZE upstream).
const CONVERTIBLE_FORMATS = new Set(['jpeg', 'png']);

const bytesToKbytes = (bytes: number) => Math.round((bytes / 1000) * 100) / 100;

const writeStreamToFile = (stream: NodeJS.ReadWriteStream, filePath: string) =>
  new Promise<void>((resolve, reject) => {
    const writeStream = fs.createWriteStream(filePath);
    stream.on('error', reject);
    stream.pipe(writeStream);
    writeStream.on('close', () => resolve());
    writeStream.on('error', reject);
  });

const getMetadata = (file: UploadableFile): Promise<sharp.Metadata> => {
  if (!file.filepath) {
    return new Promise((resolve, reject) => {
      const pipeline = sharp();
      pipeline.metadata().then(resolve).catch(reject);
      file.getStream().pipe(pipeline);
    });
  }

  return sharp(file.filepath).metadata();
};

// Swap a trailing .png/.jpg/.jpeg for .webp so the display name (shown in
// the admin media library) matches what's actually being served.
const renameToWebp = (name: string): string => {
  const ext = path.extname(name);
  if (/^\.(png|jpe?g)$/i.test(ext)) {
    return `${name.slice(0, -ext.length)}.webp`;
  }
  return name;
};

export default (plugin: any) => {
  const originalService = plugin.services['image-manipulation'];
  const originalOptimize = originalService.optimize;

  const optimize = async (file: UploadableFile): Promise<UploadableFile> => {
    const { format } = await getMetadata(file);

    if (!format || !CONVERTIBLE_FORMATS.has(format)) {
      return originalOptimize(file);
    }

    const transformer = file.filepath ? sharp(file.filepath) : sharp();
    transformer.webp({ quality: WEBP_QUALITY });

    const filePath = file.tmpWorkingDirectory
      ? path.join(file.tmpWorkingDirectory, `optimized-${file.hash}`)
      : `optimized-${file.hash}`;

    let newInfo: sharp.OutputInfo | undefined;
    if (!file.filepath) {
      transformer.on('info', (info: sharp.OutputInfo) => {
        newInfo = info;
      });
      await writeStreamToFile(file.getStream().pipe(transformer), filePath);
    } else {
      newInfo = await transformer.toFile(filePath);
    }

    const { width, height, size } = newInfo ?? {};

    const newFile: UploadableFile = {
      ...file,
      name: renameToWebp(file.name),
      ext: '.webp',
      mime: 'image/webp',
      filepath: filePath,
      getStream: () => fs.createReadStream(filePath),
    };

    return Object.assign(newFile, {
      width,
      height,
      size: size ? bytesToKbytes(size) : file.size,
      sizeInBytes: size ?? file.sizeInBytes,
    });
  };

  plugin.services['image-manipulation'] = {
    ...originalService,
    optimize,
  };

  return plugin;
};
