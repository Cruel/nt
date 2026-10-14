/**
 * Private lossless animated-WebP alpha preparation and #408 integration tracing.
 * The production export adapter reuses these verified alpha bytes; the native
 * player reads the same private sidecar through its WebP alpha session.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { encodeAlphaMasks, readAlphaMasksFile } from './animated-webp-alpha-encoder';
import { encodeAlphaFromFfmpeg } from './alpha-ffmpeg-stream';
import type {
  OpaqueVideoPreparationRequest,
  OpaqueVideoPreparationResult,
} from '../../shared/prepared-media-contracts';
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
export async function prepareOptionalVideoAlpha(
  request: OpaqueVideoPreparationRequest,
  color: { browserVideo: { sourcePath: string }; frameDurationsMs: number[] },
  sourceBytes: Uint8Array,
  tool: MediaTool = installedMediaTool(),
  run: MediaToolRunner = runVideoMediaToolProcess,
): Promise<TransparentVideoTrace | null> {
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
    if (!sourceHasAlpha(probe.stderr)) {
      // A source that advertises auxiliary alpha must fail closed if its decoder drops it.
      // Ordinary opaque sources have no WebP sidecar.
      if (/alpha_mode\s*:\s*1\b/u.test(probe.stderr))
        throw new Error(
          'Source decoder discarded alpha (decoded frames do not carry an alpha plane).',
        );
      return null;
    }
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
    const extractArguments = [
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
    ];
    let extractionLog: string;
    let encoded;
    if (run === runVideoMediaToolProcess) {
      // Native production jobs consume FFmpeg's stdout under backpressure:
      // one uncompressed mask in memory, no multi-gigabyte scratch file.
      const streamed = await encodeAlphaFromFfmpeg(
        tool.executable,
        ['-nostdin', '-hide_banner', ...extractArguments, '-'],
        color.frameDurationsMs,
        width,
        height,
      );
      extractionLog = streamed.stderr;
      encoded = streamed.result;
    } else {
      // Injected test runners can write their declared output file without
      // being replaced by an unmockable host child process.
      const extracted = runMediaPreparation(tool, [...extractArguments, maskPath], run);
      extractionLog = extracted.stderr;
      encoded = await encodeAlphaMasks(
        readAlphaMasksFile(maskPath, width, height, color.frameDurationsMs.length),
        color.frameDurationsMs,
        width,
        height,
      );
    }
    const samples = readSampleTimes(extractionLog);
    const durations = frameDurations(samples, timeline.endpointMs);
    if (
      durations.length !== color.frameDurationsMs.length ||
      durations.some((duration, index) => duration !== color.frameDurationsMs[index])
    )
      throw new Error('Prepared alpha and VP9 color disagree on sample timestamps or endpoint.');
    const { alphaWebp, holds, pageHashes } = encoded;
    if (!alphaWebp) return null;
    const metadata = await sharp(alphaWebp, { animated: true }).metadata();
    if (
      (metadata.pages ?? 1) !== holds.length ||
      metadata.width !== width ||
      (metadata.pageHeight ?? metadata.height) !== height ||
      (holds.length > 1 &&
        JSON.stringify(metadata.delay ?? []) !==
          JSON.stringify(holds.map((hold) => hold.durationMs)))
    )
      throw new Error('WebP animation did not retain exact page durations and canvas.');
    const decoder = new WebpAlphaTraceSession(alphaWebp, holds, width, height);
    for (let page = 0; page < holds.length; page += 1) {
      const decodedPage = (await decoder.sample(holds[page]!.startMs)).alpha;
      if (createHash('sha256').update(decodedPage).digest('hex') !== pageHashes[page])
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

/** Production preparation shares the immutable input snapshot and color timeline with WebP. */
export async function prepareProductionVideoMotion(
  root: string,
  request: OpaqueVideoPreparationRequest,
  tool: MediaTool = installedMediaTool(),
  run: MediaToolRunner = runVideoMediaToolProcess,
  admittedSourceBytes?: Uint8Array,
): Promise<OpaqueVideoPreparationResult> {
  const bytes = admittedSourceBytes ?? (await readContainedVideoSource(root, request.sourcePath));
  const color = await prepareOpaqueVideoMotion(root, request, tool, run, bytes);
  const alpha = await prepareOptionalVideoAlpha(request, color, bytes, tool, run);
  if (!alpha) return color;
  const sourcePath = join(dirname(color.browserVideo.sourcePath), 'alpha.webp');
  await writeFile(sourcePath, alpha.alphaWebp);
  return {
    ...color,
    alphaWebp: {
      sourcePath,
      projectRelativePath: join(
        dirname(color.browserVideo.projectRelativePath),
        'alpha.webp',
      ).replaceAll('\\', '/'),
      contentHash: alpha.alphaSha256,
      byteSize: alpha.alphaWebp.byteLength,
      width: alpha.width,
      height: alpha.height,
    },
  };
}

/** Strict proof helper: opaque input is not a valid transparent-video trace. */
export async function traceTransparentVideo(
  root: string,
  request: OpaqueVideoPreparationRequest,
  tool: MediaTool = installedMediaTool(),
  run: MediaToolRunner = runVideoMediaToolProcess,
): Promise<TransparentVideoTrace> {
  const sourceBytes = await readContainedVideoSource(root, request.sourcePath);
  const color = await prepareOpaqueVideoMotion(root, request, tool, run, sourceBytes);
  const alpha = await prepareOptionalVideoAlpha(request, color, sourceBytes, tool, run);
  if (!alpha)
    throw new Error('Source decoder discarded alpha or alpha source has no nonopaque coverage.');
  return alpha;
}
