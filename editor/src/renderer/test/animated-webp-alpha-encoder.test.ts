import sharp from 'sharp';
import { describe, expect, it } from 'vite-plus/test';
import {
  encodeAlphaMasksWithFfmpegFiles,
  verifyAlphaWebp,
} from '../../main/services/animated-webp-alpha-encoder';
import { runVideoMediaToolProcess } from '../../main/services/opaque-video-preparation-service';

async function* masks(...values: Buffer[]) {
  for (const mask of values) yield mask;
}

const encode = (
  source: AsyncIterable<Buffer>,
  durations: number[],
  width: number,
  height: number,
) =>
  encodeAlphaMasksWithFfmpegFiles(
    source,
    durations,
    width,
    height,
    process.env.NOVELTEA_FFMPEG!,
    runVideoMediaToolProcess,
  );

describe.skipIf(!process.env.NOVELTEA_FFMPEG)('bounded FFmpeg alpha WebP encoding', () => {
  it('encodes exact VFR holds and unmodified alpha bytes', async () => {
    const a = Buffer.from([0, 1, 127, 128, 254, 255]);
    const b = Buffer.from([255, 254, 128, 127, 1, 0]);
    const c = Buffer.from([0, 0, 128, 255, 0, 255]);
    const result = await encode(masks(a, a, b, c), [73, 127, 550, 50], 3, 2);
    expect(result.holds).toEqual([
      { startMs: 0, durationMs: 200 },
      { startMs: 200, durationMs: 550 },
      { startMs: 750, durationMs: 50 },
    ]);
    const metadata = await sharp(result.alphaWebp!, { animated: true }).metadata();
    expect(metadata.pages).toBe(3);
    expect(metadata.delay).toEqual([200, 550, 50]);
    for (const [index, expected] of [a, b, c].entries()) {
      const decoded = await sharp(result.alphaWebp!, { page: index, pages: 1 })
        .ensureAlpha()
        .raw()
        .toBuffer();
      expect(Buffer.from(decoded.filter((_, offset) => offset % 4 === 3))).toEqual(expected);
    }
  });

  it('retains a single frame as a still VP8L', async () => {
    const result = await encode(masks(Buffer.from([0, 128])), [120_000], 2, 1);
    expect(result.holds).toEqual([{ startMs: 0, durationMs: 120_000 }]);
    expect(result.alphaWebp?.toString('ascii', 12, 16)).toBe('VP8L');
  });

  it('omits fully opaque alpha resources', async () => {
    const result = await encode(
      masks(Buffer.from([255, 255]), Buffer.from([255, 255])),
      [100, 100],
      2,
      1,
    );
    expect(result).toEqual({ alphaWebp: null, holds: [], pageHashes: [] });
  });

  it('rejects invalid frame counts, sizes and timing', async () => {
    await expect(encode(masks(Buffer.alloc(3)), [100], 2, 2)).rejects.toThrow(
      'incomplete or extra',
    );
    await expect(encode(masks(Buffer.alloc(4)), [0], 2, 2)).rejects.toThrow('invalid alpha hold');
    await expect(encode(masks(Buffer.alloc(4)), [100, 100], 2, 2)).rejects.toThrow('fewer frames');
    await expect(encode(masks(Buffer.alloc(4), Buffer.alloc(4)), [100], 2, 2)).rejects.toThrow(
      'extra frame',
    );
  });

  it('batches many distinct masks without a whole-video raw atlas', async () => {
    const width = 1024;
    const height = 1024;
    const frames = async function* () {
      for (let index = 0; index < 25; index += 1) yield Buffer.alloc(width * height, index);
    };
    // 25 distinct BGRA canvases exceed the 96 MiB scratch-batch budget.
    const result = await encode(frames(), Array(25).fill(40), width, height);
    expect(result.holds).toHaveLength(25);
    await verifyAlphaWebp(
      result.alphaWebp!,
      result.holds,
      result.pageHashes,
      width,
      height,
      process.env.NOVELTEA_FFMPEG!,
      runVideoMediaToolProcess,
    );
  }, 60_000);

  it('bounds scratch memory and disk for over 64 MiB of R8 alpha', async () => {
    const same = Buffer.alloc(1920 * 1080, 128);
    const frames = async function* () {
      for (let index = 0; index < 36; index += 1) yield same;
    };
    const result = await encode(frames(), Array(36).fill(100), 1920, 1080);
    expect(result.holds).toEqual([{ startMs: 0, durationMs: 3_600 }]);
    expect(result.alphaWebp).toBeTruthy();
    expect(result.alphaWebp!.length).toBeLessThan(10_000);
  }, 60_000);
});
