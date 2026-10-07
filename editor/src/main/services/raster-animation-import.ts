import sharp from 'sharp';
import { prepareApng } from './apng-import';
import { checkRasterImportSize, MAX_RASTER_IMPORT_PIXELS } from './raster-import-limits';

export interface RasterImportSource {
  name: string;
  bytes: Buffer;
}
export interface PreparedRasterAnimation {
  format: 'image-sequence' | 'gif' | 'apng';
  canvas: { width: number; height: number };
  frames: { png: Buffer; durationMs: number }[];
}

export async function prepareRasterAnimation(
  sources: RasterImportSource[],
  frameDurationMs: number,
): Promise<PreparedRasterAnimation> {
  if (!sources.length || !Number.isSafeInteger(frameDurationMs) || frameDurationMs < 1)
    throw new Error('Animation import requires sources and a positive frame duration.');
  const first = sources[0]!;
  const apng = await prepareApng(first.bytes, frameDurationMs);
  if (apng) {
    if (sources.length !== 1) throw new Error('Import one animated source at a time.');
    return apng;
  }
  if (first.bytes.subarray(0, 3).toString() === 'GIF') {
    if (sources.length !== 1) throw new Error('Import one animated source at a time.');
    const metadata = await sharp(first.bytes, { animated: true }).metadata();
    const width = metadata.width!;
    const height = metadata.pageHeight ?? metadata.height!;
    const count = metadata.pages ?? 1;
    checkRasterImportSize(width, height, count);
    const frames: PreparedRasterAnimation['frames'] = [];
    for (let page = 0; page < count; page++) {
      const png = await sharp(first.bytes, { page, pages: 1, failOn: 'error' })
        .toColourspace('srgb')
        .ensureAlpha()
        .png()
        .toBuffer();
      frames.push({ png, durationMs: Math.max(1, metadata.delay?.[page] || frameDurationMs) });
    }
    return { format: 'gif', canvas: { width, height }, frames };
  }
  const frames: PreparedRasterAnimation['frames'] = [];
  let canvas: PreparedRasterAnimation['canvas'] | undefined;
  for (const source of sources) {
    if (
      source !== first &&
      (source.bytes.subarray(0, 3).toString() === 'GIF' ||
        (await prepareApng(source.bytes, frameDurationMs)))
    )
      throw new Error('Animated sources cannot be mixed with an image sequence.');
    const image = sharp(source.bytes, {
      failOn: 'error',
      limitInputPixels: MAX_RASTER_IMPORT_PIXELS,
    }).autoOrient();
    const metadata = await image.metadata();
    if ((metadata.pages ?? 1) > 1)
      throw new Error('Only GIF and APNG animated sources are supported.');
    const rotated = (metadata.orientation ?? 1) >= 5;
    checkRasterImportSize(
      rotated ? metadata.height! : metadata.width!,
      rotated ? metadata.width! : metadata.height!,
      sources.length,
    );
    const { data, info } = await image
      .toColourspace('srgb')
      .ensureAlpha()
      .png()
      .toBuffer({ resolveWithObject: true });
    checkRasterImportSize(info.width, info.height, sources.length);
    if (canvas && (canvas.width !== info.width || canvas.height !== info.height))
      throw new Error('Image sequence frames must have equal oriented dimensions.');
    canvas = { width: info.width, height: info.height };
    frames.push({ png: data, durationMs: frameDurationMs });
  }
  return { format: 'image-sequence', canvas: canvas!, frames };
}
