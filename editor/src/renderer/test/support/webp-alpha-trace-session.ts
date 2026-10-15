/** Test-only Sharp reference decoder for independent alpha-hit verification. */
import sharp from 'sharp';
import type { AlphaHold } from '../../../main/services/transparent-video-tracer';

export class WebpAlphaTraceSession {
  private page = -1;
  private mask: Buffer | null = null;

  constructor(
    private readonly webp: Buffer,
    private readonly holds: readonly AlphaHold[],
    private readonly width: number,
    private readonly height: number,
  ) {}

  async sample(timeMs: number): Promise<{ page: number; alpha: Buffer }> {
    if (!Number.isFinite(timeMs) || timeMs < 0) throw new Error('Invalid alpha sample time.');
    const page = this.holds.findIndex((hold) => timeMs < hold.startMs + hold.durationMs);
    if (page < 0) throw new Error('Alpha sample is outside the motion endpoint.');
    if (page !== this.page) {
      const { data, info } = await sharp(this.webp, { page, pages: 1 })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      if (info.width !== this.width || info.height !== this.height || info.channels !== 4)
        throw new Error('Decoded WebP mask dimensions differ from the prepared canvas.');
      const alpha = Buffer.alloc(this.width * this.height);
      for (let pixel = 0; pixel < alpha.length; pixel += 1) alpha[pixel] = data[pixel * 4 + 3]!;
      this.mask = alpha;
      this.page = page;
    }
    return { page, alpha: this.mask! };
  }

  hit(timeMs: number, x: number, y: number): Promise<boolean> {
    return this.sample(timeMs).then(
      ({ alpha }) =>
        x >= 0 &&
        y >= 0 &&
        x < this.width &&
        y < this.height &&
        alpha[Math.floor(y) * this.width + Math.floor(x)]! > 0,
    );
  }
}
