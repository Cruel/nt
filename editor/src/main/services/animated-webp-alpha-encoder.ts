/** Bounded-memory lossless WebP alpha encoder for timed video coverage. */
import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import sharp from 'sharp';

export interface EncodedAlphaHold {
  startMs: number;
  durationMs: number;
}

export interface EncodedAlphaMotion {
  alphaWebp: Buffer | null;
  holds: EncodedAlphaHold[];
  pageHashes: string[];
}

const maxEncodedBytes = 128 * 1024 * 1024;
const maxCanvasPixels = 16 * 1024 * 1024;
const maxFrames = 65_536;
const maxWebpDurationMs = 0xffffff;

function chunk(tag: string, payload: Buffer): Buffer {
  const padded = payload.length + (payload.length & 1);
  const value = Buffer.allocUnsafe(8 + padded);
  value.write(tag, 0, 4, 'ascii');
  value.writeUInt32LE(payload.length, 4);
  payload.copy(value, 8);
  if (payload.length & 1) value[value.length - 1] = 0;
  return value;
}

function u24(bytes: Buffer, offset: number, value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffff)
    throw new Error('Animated-WebP alpha field exceeds its 24-bit representation.');
  bytes[offset] = value & 255;
  bytes[offset + 1] = (value >> 8) & 255;
  bytes[offset + 2] = (value >> 16) & 255;
}

async function encodeLosslessPage(mask: Buffer, width: number, height: number): Promise<Buffer> {
  const rgba = Buffer.allocUnsafe(mask.length * 4);
  for (let i = 0; i < mask.length; i += 1) {
    const offset = i * 4;
    rgba[offset] = 255;
    rgba[offset + 1] = 255;
    rgba[offset + 2] = 255;
    rgba[offset + 3] = mask[i]!;
  }
  const webp = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .webp({ lossless: true, effort: 4 })
    .toBuffer();
  if (
    webp.length < 20 ||
    webp.toString('ascii', 0, 4) !== 'RIFF' ||
    webp.toString('ascii', 8, 12) !== 'WEBP' ||
    webp.readUInt32LE(4) + 8 !== webp.length ||
    webp.toString('ascii', 12, 16) !== 'VP8L' ||
    webp.readUInt32LE(16) + 20 + (webp.readUInt32LE(16) & 1) !== webp.length
  )
    throw new Error('Sharp did not return one lossless VP8L WebP page.');
  return webp.subarray(12);
}

function muxAnimatedWebp(
  pages: readonly Buffer[],
  holds: readonly EncodedAlphaHold[],
  width: number,
  height: number,
): Buffer {
  if (pages.length === 1) {
    const payload = pages[0]!;
    const riff = Buffer.allocUnsafe(12 + payload.length);
    riff.write('RIFF', 0, 4, 'ascii');
    riff.writeUInt32LE(riff.length - 8, 4);
    riff.write('WEBP', 8, 4, 'ascii');
    payload.copy(riff, 12);
    return riff;
  }
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x12; // alpha and animation flags
  u24(vp8x, 4, width - 1);
  u24(vp8x, 7, height - 1);
  const chunks = [chunk('VP8X', vp8x), chunk('ANIM', Buffer.alloc(6))];
  for (let page = 0; page < pages.length; page += 1) {
    const header = Buffer.alloc(16);
    u24(header, 6, width - 1);
    u24(header, 9, height - 1);
    u24(header, 12, holds[page]!.durationMs);
    header[15] = 2; // replace entire canvas, do not blend or dispose
    chunks.push(chunk('ANMF', Buffer.concat([header, pages[page]!])));
  }
  const total = 12 + chunks.reduce((sum, value) => sum + value.length, 0);
  if (total > maxEncodedBytes || total - 8 > 0xffffffff)
    throw new Error('Prepared WebP exceeds the compressed alpha source budget.');
  const riff = Buffer.allocUnsafe(total);
  riff.write('RIFF', 0, 4, 'ascii');
  riff.writeUInt32LE(total - 8, 4);
  riff.write('WEBP', 8, 4, 'ascii');
  let offset = 12;
  for (const item of chunks) {
    item.copy(riff, offset);
    offset += item.length;
  }
  return riff;
}

/** Encode one R8 canvas at a time. No array of raw video frames is retained. */
export async function encodeAlphaMasks(
  masks: AsyncIterable<Buffer>,
  durations: readonly number[],
  width: number,
  height: number,
): Promise<EncodedAlphaMotion> {
  const pixels = width * height;
  if (
    !Number.isSafeInteger(pixels) ||
    pixels < 1 ||
    pixels > maxCanvasPixels ||
    durations.length < 1 ||
    durations.length > maxFrames
  )
    throw new Error('Invalid video-alpha canvas or excessive frame count.');
  const pages: Buffer[] = [];
  const holds: EncodedAlphaHold[] = [];
  const pageHashes: string[] = [];
  let lastMask: Buffer | null = null;
  let frameIndex = 0;
  let elapsed = 0;
  let hasNonopaqueCoverage = false;
  let encodedBytes = 0;
  for await (const mask of masks) {
    if (frameIndex >= durations.length || mask.length !== pixels)
      throw new Error('Alpha extraction produced incomplete or extra frame data.');
    const duration = durations[frameIndex]!;
    if (!Number.isSafeInteger(duration) || duration <= 0)
      throw new Error('Prepared video contains an invalid alpha hold duration.');
    if (!hasNonopaqueCoverage && mask.some((value) => value !== 255)) hasNonopaqueCoverage = true;
    if (lastMask && Buffer.compare(lastMask, mask) === 0) {
      holds[holds.length - 1]!.durationMs += duration;
    } else {
      holds.push({ startMs: elapsed, durationMs: duration });
      const page = await encodeLosslessPage(mask, width, height);
      encodedBytes += page.byteLength + 64;
      if (encodedBytes > maxEncodedBytes)
        throw new Error('Prepared WebP exceeds the compressed alpha source budget.');
      pages.push(page);
      pageHashes.push(createHash('sha256').update(mask).digest('hex'));
      lastMask = Buffer.from(mask);
    }
    elapsed += duration;
    frameIndex += 1;
  }
  if (frameIndex !== durations.length)
    throw new Error('Alpha extraction produced fewer frames than the color timeline.');
  if (!hasNonopaqueCoverage) return { alphaWebp: null, holds: [], pageHashes: [] };
  if (holds.length > 1 && holds.some((hold) => hold.durationMs > maxWebpDurationMs))
    throw new Error('An animated-WebP alpha hold exceeds 24-bit millisecond duration.');
  const encodedEstimate = pages.reduce((sum, value) => sum + value.length + 64, 0);
  if (encodedEstimate > maxEncodedBytes)
    throw new Error('Prepared WebP exceeds the compressed alpha source budget.');
  return {
    alphaWebp: muxAnimatedWebp(pages, holds, width, height),
    holds,
    pageHashes,
  };
}

/** The fallback runner writes a temporary raw gray stream; read it by canvas, not in bulk. */
export async function* readAlphaMasksFile(
  filePath: string,
  width: number,
  height: number,
  frameCount: number,
): AsyncGenerator<Buffer> {
  const pixels = width * height;
  const size = pixels * frameCount;
  if (!Number.isSafeInteger(size) || (await stat(filePath)).size !== size)
    throw new Error('Alpha extraction produced an incomplete or differently-sized canvas.');
  const file = await open(filePath, 'r');
  try {
    for (let i = 0; i < frameCount; i += 1) {
      const mask = Buffer.allocUnsafe(pixels);
      let offset = 0;
      while (offset < pixels) {
        const { bytesRead } = await file.read(mask, offset, pixels - offset);
        if (!bytesRead) throw new Error('Alpha extraction ended mid-frame.');
        offset += bytesRead;
      }
      yield mask;
    }
  } finally {
    await file.close();
  }
}
