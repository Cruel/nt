/**
 * #408 integration tracer, deliberately NOT a package representation or player decoder.
 * It consumes the production VP9 preparation and emits independent, single lossless
 * animated-WebP alpha bytes for validation before #409 adds the runtime contract.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { OpaqueVideoPreparationRequest } from '../../shared/prepared-media-contracts';
import type { MediaTool, MediaToolRunner } from './media-preparation-service';
import { installedMediaTool, runMediaPreparation } from './media-preparation-service';
import {
  frameDurations,
  prepareOpaqueVideoMotion,
  readContainedVideoSource,
  readSampleTimes,
  runVideoMediaToolProcess,
  samplingFilter,
  sourceTimeline,
} from './opaque-video-preparation-service';

export interface AlphaHold {
  startMs: number;
  durationMs: number;
}

export interface TransparentVideoTrace {
  colorVideoPath: string;
  colorDurationsMs: number[];
  alphaWebp: Buffer;
  holds: AlphaHold[];
  width: number;
  height: number;
  alphaSha256: string;
}

function sourceHasAlpha(log: string): boolean {
  // Examine decoded frames BEFORE format conversion. 'format=rgba' would add
  // an opaque channel to stripped VP9, hiding an incompatible FFmpeg decoder.
  const decodedFormats = [...log.matchAll(/\bfmt:(\w+)/gu)].map((match) => match[1]!);
  return (
    decodedFormats.length > 0 &&
    decodedFormats.every((format) =>
      /^(?:yuva\w+|gbrap\w*|rgba|bgra|argb|abgr|ya\d*|pal8)$/u.test(format),
    )
  );
}

function alphaSourceDecoder(
  source: string,
  sourcePath: string,
  tool: MediaTool,
  run: MediaToolRunner,
): string[] {
  if (!sourcePath.toLowerCase().endsWith('.webm')) return [];
  const header = runMediaPreparation(
    tool,
    ['-i', source, '-map', '0:v:0', '-frames:v', '0', '-f', 'null', '-'],
    run,
  ).stderr;
  const codec = /Stream #\d+:\d+[^\n]*Video: (vp8|vp9)\b/u.exec(header)?.[1];
  if (codec !== 'vp8' && codec !== 'vp9')
    throw new Error('Transparent WebM source must contain a supported VP8 or VP9 video stream.');
  // FFmpeg's default VPx decoders may omit the WebM auxiliary alpha plane.
  return ['-c:v', codec === 'vp8' ? 'libvpx' : 'libvpx-vp9'];
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.compare(a, b) === 0;
}

/** Decode a single page into a bounded, reusable 8-bit CPU mask for tracing hit coverage. */
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

/**
 * Check a source with the real color preparation, then normalize/decode its
 * alpha with the same source-range, sampling, scale and centered padding.
 * This is trace evidence, not a second authoring or export route.
 */
export async function traceTransparentVideo(
  root: string,
  request: OpaqueVideoPreparationRequest,
  tool: MediaTool = installedMediaTool(),
  run: MediaToolRunner = runVideoMediaToolProcess,
): Promise<TransparentVideoTrace> {
  const sourceBytes = await readContainedVideoSource(root, request.sourcePath);
  const color = await prepareOpaqueVideoMotion(root, request, tool, run, sourceBytes);
  const temporary = await mkdtemp(join(tmpdir(), 'noveltea-alpha-trace-'));
  try {
    // Both color and alpha must derive from one admitted source snapshot,
    // even if the original Asset changes while FFmpeg is processing.
    const source = join(temporary, 'source.snapshot');
    await writeFile(source, sourceBytes);
    const decoderOptions = alphaSourceDecoder(source, request.sourcePath, tool, run);
    const probe = runMediaPreparation(
      tool,
      [
        ...decoderOptions,
        '-i',
        source,
        '-map',
        '0:v:0',
        '-an',
        '-sn',
        '-dn',
        '-vf',
        'setpts=PTS-STARTPTS,showinfo',
        '-fps_mode',
        'passthrough',
        '-f',
        'null',
        '-',
      ],
      run,
    );
    if (!sourceHasAlpha(probe.stderr))
      throw new Error(
        'Source decoder discarded alpha (decoded frames do not carry an alpha plane).',
      );
    const timeline = sourceTimeline(request, readSampleTimes(probe.stderr), probe.stderr);
    const sampling = samplingFilter(
      request.frameSampling ?? { mode: 'source' },
      timeline.samples.length,
    );
    const { width, height } = request.canvas;
    const maskPath = join(temporary, 'mask.gray');
    const filter = [
      timeline.filter,
      ...(sampling ? [sampling] : []),
      ...(request.frameSampling?.mode === 'target-fps'
        ? [`trim=end=${(timeline.endpointMs / 1000).toFixed(6)}`]
        : []),
      'format=rgba',
      'alphaextract',
      `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=bicubic`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      'format=gray',
      'showinfo',
    ].join(',');
    const extracted = runMediaPreparation(
      tool,
      [
        '-y',
        ...decoderOptions,
        '-i',
        source,
        '-map',
        '0:v:0',
        '-an',
        '-sn',
        '-dn',
        '-vf',
        filter,
        '-fps_mode',
        'passthrough',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'gray',
        maskPath,
      ],
      run,
    );
    const samples = readSampleTimes(extracted.stderr);
    const durations = frameDurations(samples, timeline.endpointMs);
    if (
      durations.length !== color.frameDurationsMs.length ||
      durations.some((duration, index) => duration !== color.frameDurationsMs[index])
    )
      throw new Error('Prepared alpha and VP9 color disagree on sample timestamps or endpoint.');
    const pixels = width * height;
    const expectedBytes = pixels * durations.length;
    // The validation tracer materializes raw frames for comparison; #409's
    // production decoder must stream them. Never permit unbounded allocations.
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes > 64 * 1024 * 1024)
      throw new Error('Alpha tracer exceeds its 64 MiB decoded-frame budget.');
    if ((await stat(maskPath)).size !== expectedBytes)
      throw new Error('Alpha extraction produced an incomplete or differently-sized canvas.');
    const decoded = await readFile(maskPath);
    if (decoded.every((value) => value === 255))
      throw new Error(
        'Alpha source has no nonopaque coverage; cannot prove auxiliary alpha decoding.',
      );

    // Consecutive identical masks become a single timed WebP page. The GPU can
    // therefore keep one R8 upload across multiple independently timed color frames.
    const masks: Buffer[] = [];
    const holds: AlphaHold[] = [];
    let startMs = 0;
    for (let frame = 0; frame < durations.length; frame += 1) {
      const mask = decoded.subarray(frame * pixels, (frame + 1) * pixels);
      if (masks.length && equalBytes(masks.at(-1)!, mask)) {
        holds.at(-1)!.durationMs += durations[frame]!;
      } else {
        masks.push(Buffer.from(mask));
        holds.push({ startMs, durationMs: durations[frame]! });
      }
      startMs += durations[frame]!;
    }
    // Sharp/libwebp accepts animation frame delays as integer milliseconds;
    // no synthetic output frames are needed to represent a long alpha hold.
    const rgba = Buffer.alloc(masks.length * pixels * 4);
    masks.forEach((mask, page) => {
      for (let pixel = 0; pixel < pixels; pixel += 1) {
        const offset = (page * pixels + pixel) * 4;
        rgba[offset] = 255;
        rgba[offset + 1] = 255;
        rgba[offset + 2] = 255;
        rgba[offset + 3] = mask[pixel]!;
      }
    });
    const alphaWebp = await sharp(rgba, {
      raw: { width, height: height * masks.length, channels: 4, pageHeight: height },
    })
      .webp({ lossless: true, effort: 4, loop: 0, delay: holds.map((hold) => hold.durationMs) })
      .toBuffer();
    const metadata = await sharp(alphaWebp, { animated: true }).metadata();
    if (
      metadata.pages !== masks.length ||
      metadata.width !== width ||
      metadata.pageHeight !== height ||
      JSON.stringify(metadata.delay ?? []) !== JSON.stringify(holds.map((hold) => hold.durationMs))
    )
      throw new Error('WebP animation did not retain exact page durations and canvas.');
    const decoder = new WebpAlphaTraceSession(alphaWebp, holds, width, height);
    for (let page = 0; page < masks.length; page += 1) {
      const decodedPage = (await decoder.sample(holds[page]!.startMs)).alpha;
      if (!equalBytes(decodedPage, masks[page]!))
        throw new Error(`Lossless WebP mask differs at page ${page}.`);
    }
    return {
      colorVideoPath: color.browserVideo.sourcePath,
      colorDurationsMs: color.frameDurationsMs,
      alphaWebp,
      holds,
      width,
      height,
      alphaSha256: createHash('sha256').update(alphaWebp).digest('hex'),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
