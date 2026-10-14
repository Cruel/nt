/**
 * Private lossless animated-WebP alpha preparation and #408 integration tracing.
 * The production export adapter reuses these verified alpha bytes; the native
 * player reads the same private sidecar through its WebP alpha session.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  encodeAlphaMasksWithFfmpegFiles,
  inspectAlphaWebp,
  readAlphaMasksFile,
  verifyAlphaWebp,
} from './animated-webp-alpha-encoder';
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

export interface NativeAlphaEncodeRequest {
  executable: string;
  arguments: string[];
  durationsMs: number[];
  width: number;
  height: number;
  outputPath: string;
}

export interface NativeAlphaEncodeResult {
  ok: boolean;
  hasAlpha?: boolean;
  stderr?: string;
  holds?: AlphaHold[];
  frameCount?: number;
  error?: string;
}

export type NativeAlphaEncoder = (
  request: NativeAlphaEncodeRequest,
) => NativeAlphaEncodeResult | Promise<NativeAlphaEncodeResult>;

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
  nativeAlphaEncoder?: NativeAlphaEncoder,
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
    if (nativeAlphaEncoder) {
      // A permanent C++ tool operation streams compressed VP8L pages directly
      // from FFmpeg. QuickJS passes only the request and result metadata.
      const nativeFilter = filter.split(',').slice(0, -1);
      // The native path turns grayscale coverage into white-RGB VP8L pixels
      // without changing the R8 alpha plane or source sampling timeline.
      nativeFilter.push('format=rgba', 'geq=r=255:g=255:b=255:a=r(X\\,Y)', 'showinfo');
      const outputPath = join(temporary, 'alpha.webp');
      const native = await nativeAlphaEncoder({
        executable: tool.executable,
        arguments: [
          '-nostdin',
          '-hide_banner',
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
          nativeFilter.join(','),
          '-fps_mode',
          'passthrough',
          '-c:v',
          'libwebp',
          '-lossless',
          '1',
          '-pix_fmt',
          'bgra',
          '-f',
          'image2pipe',
          'pipe:1',
        ],
        durationsMs: color.frameDurationsMs,
        width,
        height,
        outputPath,
      });
      if (!native.ok) throw new Error(native.error ?? 'Native alpha encoding failed.');
      extractionLog = native.stderr ?? '';
      encoded = {
        alphaWebp: native.hasAlpha ? await readFile(outputPath) : null,
        holds: native.holds ?? [],
        pageHashes: [],
      };
    } else if (run === runVideoMediaToolProcess) {
      // Native production jobs consume FFmpeg's stdout under backpressure:
      // one uncompressed mask in memory, no multi-gigabyte scratch file.
      const { encodeAlphaFromFfmpeg } = await import('./alpha-ffmpeg-stream');
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
      encoded = await encodeAlphaMasksWithFfmpegFiles(
        readAlphaMasksFile(maskPath, width, height, color.frameDurationsMs.length),
        color.frameDurationsMs,
        width,
        height,
        tool.executable,
        run,
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
    if (nativeAlphaEncoder) inspectAlphaWebp(alphaWebp, holds, width, height);
    else await verifyAlphaWebp(alphaWebp, holds, pageHashes, width, height, tool.executable, run);
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
  nativeAlphaEncoder?: NativeAlphaEncoder,
): Promise<OpaqueVideoPreparationResult> {
  const bytes = admittedSourceBytes ?? (await readContainedVideoSource(root, request.sourcePath));
  const color = await prepareOpaqueVideoMotion(root, request, tool, run, bytes);
  const alpha = await prepareOptionalVideoAlpha(
    request,
    color,
    bytes,
    tool,
    run,
    nativeAlphaEncoder,
  );
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
  nativeAlphaEncoder?: NativeAlphaEncoder,
): Promise<TransparentVideoTrace> {
  const sourceBytes = await readContainedVideoSource(root, request.sourcePath);
  const color = await prepareOpaqueVideoMotion(root, request, tool, run, sourceBytes);
  const alpha = await prepareOptionalVideoAlpha(
    request,
    color,
    sourceBytes,
    tool,
    run,
    nativeAlphaEncoder,
  );
  if (!alpha)
    throw new Error('Source decoder discarded alpha or alpha source has no nonopaque coverage.');
  return alpha;
}
