/** Exact-timeline, bounded-memory lossless WebP alpha assembly and encoding. */
import { createHash } from 'node:crypto';
import { mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaToolRunner } from './media-preparation-service';

export interface EncodedAlphaHold {
  startMs: number;
  durationMs: number;
}

export interface EncodedAlphaMotion {
  alphaWebp: Buffer | null;
  holds: EncodedAlphaHold[];
  pageHashes: string[];
}

export const maxEncodedBytes = 128 * 1024 * 1024;
export const maxCanvasPixels = 16 * 1024 * 1024;
export const maxFrames = 65_536;
const maxWebpDurationMs = 0xffffff;
const maxRawBatchBytes = 96 * 1024 * 1024;

function chunk(tag: string, payload: Buffer): Buffer {
  const value = Buffer.allocUnsafe(8 + payload.length + (payload.length & 1));
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

export function vp8lPage(webp: Buffer): Buffer {
  if (
    webp.length < 20 ||
    webp.toString('ascii', 0, 4) !== 'RIFF' ||
    webp.toString('ascii', 8, 12) !== 'WEBP' ||
    webp.readUInt32LE(4) + 8 !== webp.length ||
    webp.toString('ascii', 12, 16) !== 'VP8L' ||
    webp.readUInt32LE(16) + 20 + (webp.readUInt32LE(16) & 1) !== webp.length
  )
    throw new Error('FFmpeg did not return one lossless VP8L WebP page.');
  return Buffer.from(webp.subarray(12));
}

export function muxAnimatedWebp(
  pages: readonly Buffer[],
  holds: readonly EncodedAlphaHold[],
  width: number,
  height: number,
): Buffer {
  if (pages.length !== holds.length || !pages.length)
    throw new Error('WebP alpha pages and holds must match.');
  if (holds.length > 1 && holds.some((hold) => hold.durationMs > maxWebpDurationMs))
    throw new Error('An animated-WebP alpha hold exceeds 24-bit millisecond duration.');
  if (pages.length === 1) {
    const riff = Buffer.allocUnsafe(12 + pages[0]!.length);
    riff.write('RIFF', 0, 4, 'ascii');
    riff.writeUInt32LE(riff.length - 8, 4);
    riff.write('WEBP', 8, 4, 'ascii');
    pages[0]!.copy(riff, 12);
    return riff;
  }
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x12;
  u24(vp8x, 4, width - 1);
  u24(vp8x, 7, height - 1);
  const parts = [chunk('VP8X', vp8x), chunk('ANIM', Buffer.alloc(6))];
  for (let index = 0; index < pages.length; index += 1) {
    const header = Buffer.alloc(16);
    u24(header, 6, width - 1);
    u24(header, 9, height - 1);
    u24(header, 12, holds[index]!.durationMs);
    header[15] = 2; // Replace full canvas, no disposal.
    parts.push(chunk('ANMF', Buffer.concat([header, pages[index]!])));
  }
  const total = 12 + parts.reduce((sum, item) => sum + item.length, 0);
  if (total > maxEncodedBytes || total - 8 > 0xffffffff)
    throw new Error('Prepared WebP exceeds the compressed alpha source budget.');
  const riff = Buffer.allocUnsafe(total);
  riff.write('RIFF', 0, 4, 'ascii');
  riff.writeUInt32LE(total - 8, 4);
  riff.write('WEBP', 8, 4, 'ascii');
  let at = 12;
  for (const item of parts) {
    item.copy(riff, at);
    at += item.length;
  }
  return riff;
}

/** Verify our restricted WebP format without loading a Node-specific image library. */
export function inspectAlphaWebp(
  webp: Buffer,
  holds: readonly EncodedAlphaHold[],
  width: number,
  height: number,
): void {
  if (
    webp.length < 20 ||
    webp.toString('ascii', 0, 4) !== 'RIFF' ||
    webp.readUInt32LE(4) + 8 !== webp.length ||
    webp.toString('ascii', 8, 12) !== 'WEBP'
  )
    throw new Error('Invalid prepared alpha WebP RIFF.');
  if (holds.length === 1 && webp.toString('ascii', 12, 16) === 'VP8L') {
    vp8lPage(webp);
    return;
  }
  let offset = 12;
  let frame = 0;
  let elapsed = 0;
  let canvas = false;
  let animation = false;
  while (offset < webp.length) {
    if (offset + 8 > webp.length) throw new Error('Truncated alpha WebP chunk.');
    const tag = webp.toString('ascii', offset, offset + 4);
    const size = webp.readUInt32LE(offset + 4);
    const next = offset + 8 + size + (size & 1);
    if (next > webp.length) throw new Error('Invalid alpha WebP chunk length.');
    if (tag === 'VP8X' && offset === 12 && size === 10) {
      canvas =
        webp.readUIntLE(offset + 12, 3) + 1 === width &&
        webp.readUIntLE(offset + 15, 3) + 1 === height &&
        (webp[offset + 8]! & 0x02) !== 0;
    } else if (tag === 'ANIM' && canvas && size === 6 && !animation) {
      animation = true;
    } else if (tag === 'ANMF' && animation && frame < holds.length && size >= 24) {
      const data = offset + 8;
      const x = webp.readUIntLE(data, 3) * 2;
      const y = webp.readUIntLE(data + 3, 3) * 2;
      const frameWidth = webp.readUIntLE(data + 6, 3) + 1;
      const frameHeight = webp.readUIntLE(data + 9, 3) + 1;
      const duration = webp.readUIntLE(data + 12, 3);
      const flags = webp[data + 15]!;
      const inner = data + 16;
      if (inner + 8 > offset + 8 + size) throw new Error('Truncated animated WebP lossless frame.');
      const innerSize = webp.readUInt32LE(inner + 4);
      if (
        x + frameWidth > width ||
        y + frameHeight > height ||
        !duration ||
        (flags & ~0x03) !== 0 ||
        elapsed !== holds[frame]!.startMs ||
        duration !== holds[frame]!.durationMs ||
        webp.toString('ascii', inner, inner + 4) !== 'VP8L' ||
        inner + 8 + innerSize + (innerSize & 1) !== offset + 8 + size
      )
        throw new Error('Animated WebP is incompatible with NovelTea alpha decoder.');
      elapsed += duration;
      frame += 1;
    } else {
      throw new Error('Unexpected prepared alpha WebP chunk.');
    }
    offset = next;
  }
  if (!canvas || !animation || frame !== holds.length)
    throw new Error('WebP animation did not retain exact page durations and canvas.');
}

export async function* readAlphaMasksFile(
  filePath: string,
  width: number,
  height: number,
  frameCount: number,
): AsyncGenerator<Buffer> {
  const pixels = width * height;
  const expected = pixels * frameCount;
  if (!Number.isSafeInteger(expected) || (await stat(filePath)).size !== expected)
    throw new Error('Alpha extraction produced an incomplete or differently-sized canvas.');
  const input = await open(filePath, 'r');
  try {
    for (let i = 0; i < frameCount; i += 1) {
      const mask = Buffer.allocUnsafe(pixels);
      await readExact(input, mask, i * pixels);
      yield mask;
    }
  } finally {
    await input.close();
  }
}

type ReadableFile = Awaited<ReturnType<typeof open>>;
async function readExact(file: ReadableFile, target: Buffer, position: number): Promise<void> {
  let done = 0;
  while (done < target.length) {
    const { bytesRead } = await file.read(target, done, target.length - done, position + done);
    if (!bytesRead) throw new Error('Unexpected end of FFmpeg output.');
    done += bytesRead;
  }
}
async function writeExact(file: ReadableFile, buffer: Buffer): Promise<void> {
  let done = 0;
  while (done < buffer.length) {
    const { bytesWritten } = await file.write(buffer, done, buffer.length - done);
    if (!bytesWritten) throw new Error('Could not write an alpha mask to scratch storage.');
    done += bytesWritten;
  }
}

/** Native and injected runners use bounded scratch files and FFmpeg invocation.
 * At most 96 MiB of uncompressed BGRA pages are staged, independent of video length.
 */
export async function encodeAlphaMasksWithFfmpegFiles(
  masks: AsyncIterable<Buffer>,
  durations: readonly number[],
  width: number,
  height: number,
  executable: string,
  run: MediaToolRunner,
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

  const scratch = await mkdtemp(join(tmpdir(), 'noveltea-alpha-vp8l-'));
  const inputPath = join(scratch, 'batch.bgra');
  const outputPath = join(scratch, 'pages.webp');
  const pages: Buffer[] = [];
  const pageHashes: string[] = [];
  const holds: EncodedAlphaHold[] = [];
  let lastMask: Buffer | null = null;
  let elapsed = 0;
  let hasNonopaqueCoverage = false;
  let encodedBytes = 0;
  let count = 0;
  let batchCount = 0;
  let batchBytes = 0;
  let writer: ReadableFile | null = null;

  const encodeBatch = async () => {
    if (!batchCount) return;
    await writer!.close();
    writer = null;
    run(executable, [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'rawvideo',
      '-pixel_format',
      'bgra',
      '-video_size',
      `${width}x${height}`,
      '-framerate',
      '1',
      '-i',
      inputPath,
      '-an',
      '-c:v',
      'libwebp',
      '-lossless',
      '1',
      '-pix_fmt',
      'bgra',
      '-frames:v',
      String(batchCount),
      '-f',
      'image2pipe',
      outputPath,
    ]);
    const reader = await open(outputPath, 'r');
    try {
      const total = (await reader.stat()).size;
      let at = 0;
      for (let index = 0; index < batchCount; index += 1) {
        const header = Buffer.alloc(12);
        await readExact(reader, header, at);
        const length = header.readUInt32LE(4) + 8;
        if (length < 20 || length > maxEncodedBytes || at + length > total)
          throw new Error('FFmpeg produced an invalid WebP image stream.');
        const page = Buffer.alloc(length);
        await readExact(reader, page, at);
        pages.push(vp8lPage(page));
        encodedBytes += length + 64;
        if (encodedBytes > maxEncodedBytes)
          throw new Error('Prepared WebP exceeds the compressed alpha source budget.');
        at += length;
      }
      if (at !== total) throw new Error('FFmpeg emitted unexpected WebP image data.');
    } finally {
      await reader.close();
    }
    batchCount = 0;
    batchBytes = 0;
    writer = await open(inputPath, 'w');
  };

  try {
    writer = await open(inputPath, 'w');
    for await (const mask of masks) {
      if (count >= durations.length || mask.length !== pixels)
        throw new Error('Alpha extraction produced incomplete or extra frame data.');
      const duration = durations[count]!;
      if (!Number.isSafeInteger(duration) || duration <= 0)
        throw new Error('Prepared video contains an invalid alpha hold duration.');
      if (!hasNonopaqueCoverage && mask.some((value) => value !== 255)) hasNonopaqueCoverage = true;
      if (lastMask && Buffer.compare(lastMask, mask) === 0) {
        holds[holds.length - 1]!.durationMs += duration;
      } else {
        if (batchCount && batchBytes + pixels * 4 > maxRawBatchBytes) await encodeBatch();
        holds.push({ startMs: elapsed, durationMs: duration });
        pageHashes.push(createHash('sha256').update(mask).digest('hex'));
        lastMask = Buffer.from(mask);
        const bgra = Buffer.allocUnsafe(pixels * 4);
        for (let pixel = 0; pixel < pixels; pixel += 1) {
          const at = pixel * 4;
          bgra[at] = bgra[at + 1] = bgra[at + 2] = 255;
          bgra[at + 3] = mask[pixel]!;
        }
        await writeExact(writer!, bgra);
        batchCount += 1;
        batchBytes += bgra.length;
      }
      elapsed += duration;
      count += 1;
    }
    if (count !== durations.length)
      throw new Error('Alpha extraction produced fewer frames than the color timeline.');
    await encodeBatch();
    if (pages.length !== holds.length) throw new Error('FFmpeg encoded wrong alpha page count.');
    if (!hasNonopaqueCoverage) return { alphaWebp: null, holds: [], pageHashes: [] };
    return { alphaWebp: muxAnimatedWebp(pages, holds, width, height), holds, pageHashes };
  } finally {
    await writer?.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Byte-exact decoder verification uses FFmpeg and bounded file reads, not Sharp. */
export async function verifyAlphaWebp(
  webp: Buffer,
  holds: readonly EncodedAlphaHold[],
  expectedHashes: readonly string[],
  width: number,
  height: number,
  executable: string,
  run: MediaToolRunner,
): Promise<void> {
  inspectAlphaWebp(webp, holds, width, height);
  if (holds.length !== expectedHashes.length)
    throw new Error('Prepared WebP alpha hash count is inconsistent.');
  // The full compressed source can contain thousands of distinct pages.
  // Build short self-contained animations to avoid materializing an entire
  // decoded BGRA atlas even on the ScriptC file-backed process boundary.
  const pages: Buffer[] = [];
  if (holds.length === 1) {
    pages.push(Buffer.from(webp.subarray(12)));
  } else {
    let at = 12;
    while (at < webp.length) {
      const size = webp.readUInt32LE(at + 4);
      if (webp.toString('ascii', at, at + 4) === 'ANMF')
        pages.push(Buffer.from(webp.subarray(at + 24, at + 8 + size)));
      at += 8 + size + (size & 1);
    }
  }
  if (pages.length !== holds.length)
    throw new Error('Prepared WebP has an invalid number of alpha pages.');

  const pixels = width * height;
  const bytesPerFrame = pixels * 4;
  const framesPerBatch = Math.max(1, Math.floor(maxRawBatchBytes / bytesPerFrame));
  const scratch = await mkdtemp(join(tmpdir(), 'noveltea-alpha-verify-'));
  try {
    const source = join(scratch, 'alpha.webp');
    const decoded = join(scratch, 'decoded.bgra');
    for (let first = 0; first < pages.length; first += framesPerBatch) {
      const end = Math.min(first + framesPerBatch, pages.length);
      await writeFile(
        source,
        muxAnimatedWebp(pages.slice(first, end), holds.slice(first, end), width, height),
      );
      run(executable, [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        source,
        '-fps_mode',
        'passthrough',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'bgra',
        decoded,
      ]);
      const file = await open(decoded, 'r');
      try {
        if ((await file.stat()).size !== (end - first) * bytesPerFrame)
          throw new Error('FFmpeg decoded an unexpected WebP alpha frame count.');
        const canvas = Buffer.allocUnsafe(bytesPerFrame);
        const mask = Buffer.allocUnsafe(pixels);
        for (let page = first; page < end; page += 1) {
          await readExact(file, canvas, (page - first) * bytesPerFrame);
          for (let pixel = 0; pixel < pixels; pixel += 1) mask[pixel] = canvas[pixel * 4 + 3]!;
          if (createHash('sha256').update(mask).digest('hex') !== expectedHashes[page])
            throw new Error(`Lossless WebP mask differs at page ${page}.`);
        }
      } finally {
        await file.close();
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
