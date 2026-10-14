import sharp from 'sharp';
import { describe, expect, it } from 'vite-plus/test';
import { encodeAlphaMasks } from '../../main/services/animated-webp-alpha-encoder';

async function* masks(...values: Buffer[]) {
  for (const mask of values) yield mask;
}

describe('bounded production alpha WebP encoding', () => {
  it('encodes lossless timed holds without duplicating raw pages', async () => {
    const a = Buffer.from([0, 80, 255, 128]);
    const b = Buffer.from([255, 80, 0, 128]);
    const result = await encodeAlphaMasks(masks(a, a, b), [100, 100, 200], 2, 2);
    expect(result.holds).toEqual([
      { startMs: 0, durationMs: 200 },
      { startMs: 200, durationMs: 200 },
    ]);
    const bytes = result.alphaWebp!;
    const metadata = await sharp(bytes, { animated: true }).metadata();
    expect(metadata.pages).toBe(2);
    expect(metadata.delay).toEqual([200, 200]);
    const first = await sharp(bytes, { page: 0, pages: 1 }).ensureAlpha().raw().toBuffer();
    const second = await sharp(bytes, { page: 1, pages: 1 }).ensureAlpha().raw().toBuffer();
    expect([first[3], first[7], first[11], first[15]]).toEqual([0, 80, 255, 128]);
    expect([second[3], second[7], second[11], second[15]]).toEqual([255, 80, 0, 128]);
  });

  it('retains a single nonopaque frame as a still VP8L with motion-level duration', async () => {
    const result = await encodeAlphaMasks(masks(Buffer.from([0, 128])), [120_000], 2, 1);
    expect(result.holds).toEqual([{ startMs: 0, durationMs: 120_000 }]);
    expect(result.alphaWebp?.toString('ascii', 12, 16)).toBe('VP8L');
    expect((await sharp(result.alphaWebp!).metadata()).hasAlpha).toBe(true);
  });

  it('omits the alpha resource for fully opaque input', async () => {
    const result = await encodeAlphaMasks(
      masks(Buffer.from([255, 255]), Buffer.from([255, 255])),
      [100, 100],
      2,
      1,
    );
    expect(result.alphaWebp).toBeNull();
    expect(result.holds).toEqual([]);
  });

  it('rejects malformed or incompatible frame streams', async () => {
    await expect(encodeAlphaMasks(masks(Buffer.alloc(3)), [100], 2, 2)).rejects.toThrow(
      'incomplete or extra',
    );
    await expect(encodeAlphaMasks(masks(Buffer.alloc(4)), [0], 2, 2)).rejects.toThrow(
      'invalid alpha hold',
    );
    await expect(encodeAlphaMasks(masks(Buffer.alloc(4)), [100, 100], 2, 2)).rejects.toThrow(
      'fewer frames',
    );
    await expect(
      encodeAlphaMasks(masks(Buffer.alloc(4), Buffer.alloc(4)), [100], 2, 2),
    ).rejects.toThrow('extra frame');
  });

  it('streams over 64 MiB of raw alpha without retaining a decoded-frame atlas', async () => {
    // 36 * 1920 * 1080 = 71 MiB, larger than the previous raw-buffer limit.
    // Only one nonopaque page is stored in the compressed WebP.
    const same = Buffer.alloc(1920 * 1080, 128);
    const frames = async function* () {
      for (let i = 0; i < 36; i += 1) yield same;
    };
    const result = await encodeAlphaMasks(frames(), Array(36).fill(100), 1920, 1080);
    expect(result.holds).toEqual([{ startMs: 0, durationMs: 3_600 }]);
    expect(result.alphaWebp).toBeTruthy();
    expect(result.alphaWebp!.length).toBeLessThan(10_000);
  }, 60_000);
});
