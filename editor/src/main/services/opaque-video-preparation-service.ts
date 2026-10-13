import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import pin from '../../shared/media-tool-pin.json';
import {
  type OpaqueVideoPreparationRequest,
  type OpaqueVideoPreparationResult,
  type VideoFrameSampling,
  type VideoSourceTimingRequest,
  type VideoSourceTimingResult,
} from '../../shared/prepared-media-contracts';
import {
  installedMediaTool,
  runMediaPreparation,
  type MediaTool,
  type MediaToolRunner,
} from './media-preparation-service';

// showinfo output grows with source frame count. Keep the enlarged capture
// in the Node-only video service; ScriptC cannot lower spawnSync.maxBuffer.
export const runVideoMediaToolProcess: MediaToolRunner = (executable, args) => {
  const result = spawnSync(executable, [...args], {
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error)
    throw new Error(`Cannot execute media tool '${executable}': ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(
      `Media tool '${executable}' failed (${String(result.status)}): ${result.stderr || result.stdout || 'no diagnostics'}`,
    );
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

function seconds(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(6).replace(/0+$/u, '').replace(/\.$/u, '');
}

export async function readContainedVideoSource(
  projectRoot: string,
  sourcePath: string,
): Promise<Buffer> {
  if (
    isAbsolute(sourcePath) ||
    sourcePath.includes('\\') ||
    sourcePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  )
    throw new Error('Video source must be a safe Project-relative path.');
  const root = await realpath(projectRoot);
  const source = await realpath(resolve(root, sourcePath));
  const contained = relative(root, source);
  if (contained.startsWith('..') || isAbsolute(contained))
    throw new Error('Video source must be contained in the Project.');
  const info = await stat(source);
  if (!info.isFile() || info.size > 512 * 1024 * 1024)
    throw new Error('Video source must be a regular file no larger than 512 MiB.');
  return readFile(source);
}

interface VideoSample {
  timeMs: number;
  durationMs: number | null;
}

// showinfo reports actual presentation timestamps after filtergraph transformations.
// Never reconstruct VFR timing from frame count, average FPS, or encoder progress.
export function readSampleTimes(log: string): VideoSample[] {
  const samples: VideoSample[] = [];
  for (const line of log.split(/\r?\n/u)) {
    if (!line.includes('Parsed_showinfo_') || !line.includes('pts_time:')) continue;
    const match = /\bpts_time:\s*([-+\d.eE]+)/u.exec(line);
    if (!match) throw new Error('FFmpeg reported a frame with an unknown presentation timestamp.');
    const timeMs = Number(match[1]) * 1000;
    const duration = /\bduration_time:\s*([-+\d.eE]+)/u.exec(line);
    const durationMs = duration ? Number(duration[1]) * 1000 : null;
    if (
      !Number.isFinite(timeMs) ||
      (durationMs !== null && (!Number.isFinite(durationMs) || durationMs < 0)) ||
      (samples.length > 0 && timeMs <= samples[samples.length - 1]!.timeMs)
    )
      throw new Error('Prepared video contains non-monotonic or invalid presentation timestamps.');
    samples.push({ timeMs, durationMs });
    if (samples.length > 65_536)
      throw new Error('Prepared video exceeds the native decoder sample limit.');
  }
  if (!samples.length) throw new Error('FFmpeg did not report video presentation timestamps.');
  // Do not silently normalize decoded output PTS: the native WebM reader requires
  // the first *muxed* sample to start at time zero, not merely a relative timeline.
  return samples;
}

function sourceDurationMs(samples: VideoSample[], log: string): number {
  const last = samples.at(-1)!;
  let duration = last.timeMs + (last.durationMs ?? 0);
  if (samples.length > 1 && (!last.durationMs || last.durationMs <= 0))
    duration = last.timeMs + last.timeMs - samples[samples.length - 2]!.timeMs;
  const header = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/u.exec(log);
  if (header && !last.durationMs && samples.length === 1) {
    const headerMs = (Number(header[1]) * 3600 + Number(header[2]) * 60 + Number(header[3])) * 1000;
    // Container durations can include trailing presentation hold time.
    if (headerMs > duration) duration = headerMs;
  }
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error('Cannot determine the video motion endpoint.');
  return Math.round(duration);
}

export function frameDurations(samples: VideoSample[], endpointMs: number): number[] {
  const durations: number[] = [];
  for (let index = 0; index < samples.length; index += 1) {
    const start = Math.round(samples[index]!.timeMs);
    const end = index + 1 < samples.length ? Math.round(samples[index + 1]!.timeMs) : endpointMs;
    if (end <= start)
      throw new Error(
        `Prepared video sample at ${start} ms extends past its ${end} ms endpoint (motion ${endpointMs} ms).`,
      );
    durations.push(end - start);
  }
  return durations;
}

function encodedFrameCount(progress: string): number {
  const reports = [...progress.matchAll(/^frame=(\d+)\r?$/gmu)];
  if (!/^progress=end\r?$/mu.test(progress) || reports.length === 0)
    throw new Error('Video preparation did not report a completed frame count.');
  const count = Number(reports.at(-1)![1]);
  if (!Number.isSafeInteger(count) || count <= 0 || count > 65_536)
    throw new Error('Video preparation produced an invalid number of frames.');
  return count;
}

function retainFilter(sourceFrames: number, percent: number): string | null {
  const kept = Math.min(sourceFrames, Math.max(1, Math.round((sourceFrames * percent) / 100)));
  if (kept >= sourceFrames) return null;
  // A one-sample representation holds the first sample until the original endpoint.
  // Insisting on both boundary frames would violate the requested retention percentage.
  if (kept === 1) return "select='eq(n\\,0)'";
  // Quantile mapping samples from the source presentation order and always retains
  // both endpoints. select does not reset PTS, so dropped frames do not speed playback.
  const last = sourceFrames - 1;
  const intervals = kept - 1;
  return `select='eq(n\\,0)+eq(n\\,${last})+gt(floor(n*${intervals}/${last})\\,floor((n-1)*${intervals}/${last}))'`;
}

export function samplingFilter(mode: VideoFrameSampling, sourceFrames: number): string | null {
  if (mode.mode === 'source') return null;
  if (mode.mode === 'retain-percent') return retainFilter(sourceFrames, mode.percent);
  return `fps=fps=${mode.fps.numerator}/${mode.fps.denominator}:round=near`;
}

function sourceColorConversion(log: string): { filters: string[]; reducedPrecision: boolean } {
  // Frame tags take precedence, but several decoders expose color metadata
  // only on the video stream. Fall back to the input stream's matrix/primaries/
  // transfer triplet rather than treating tagged HDR frames as ordinary SDR.
  const metadata = /color_space:(\S+)\s+color_primaries:(\S+)\s+color_trc:(\S+)/u.exec(log);
  const videoHeader = log.split(/\r?\n/u).find((line) => /Stream #\d+:\d+.*: Video:/u.test(line));
  const streamMetadata = /\b(?:tv|pc),\s*([^/,\s]+)\/([^/,\s]+)\/([^,\s)]+)/u.exec(
    videoHeader ?? '',
  );
  const colorTag = (index: number) => {
    const value = metadata?.[index];
    return value && value !== 'unknown' && value !== 'unspecified'
      ? value
      : streamMetadata?.[index];
  };
  const matrix = colorTag(1);
  const primaries = colorTag(2);
  const transfer = colorTag(3);
  const fmt = /\bfmt:(\S+)/u.exec(log)?.[1] ?? '';
  const hdr = transfer === 'smpte2084' || transfer === 'arib-std-b67';
  const reducedPrecision =
    hdr ||
    /(?:p0?1[026]|p1[026]|p0?9|p0?1[24]|10le|12le|16le)/iu.test(fmt) ||
    /(?:smpte2084|arib-std-b67|p010le|p016le|yuv\w*p1[02-6]le)/iu.test(log);
  // Tone mapping must operate in linear-light float RGB before conversion to
  // display-referred BT.709. Refuse incomplete HDR tags rather than silently
  // interpreting BT.2020/PQ/HLG pixels as ordinary SDR.
  if (hdr) {
    if (matrix !== 'bt2020nc' || primaries !== 'bt2020')
      throw new Error(
        'HDR video requires BT.2020 primaries and a BT.2020 non-constant-luminance matrix.',
      );
    return {
      filters: [
        'zscale=t=linear:m=gbr:npl=100',
        'format=gbrpf32le',
        'tonemap=tonemap=hable:desat=0',
        'zscale=p=bt709:t=bt709:m=bt709:r=tv',
        'format=yuv420p',
      ],
      reducedPrecision: true,
    };
  }
  // Standard-definition matrix/gamut changes require both chroma-matrix and
  // primaries/transfer conversion, not just an out_color_matrix scaler flag.
  const input =
    !hdr && matrix === 'smpte170m'
      ? 'smpte170m'
      : !hdr && matrix === 'bt470bg'
        ? 'bt470bg'
        : !hdr && matrix === 'smpte240m'
          ? 'smpte240m'
          : !hdr && matrix === 'bt2020nc' && transfer === 'bt2020-10'
            ? 'bt2020'
            : null;
  return {
    filters: input ? [`colorspace=iall=${input}:all=bt709:format=yuv420p:dither=fsb`] : [],
    reducedPrecision,
  };
}

export function sourceTimeline(
  request: VideoSourceTimingRequest,
  sourceSamples: readonly VideoSample[],
  sourceLog: string,
): { filter: string; samples: VideoSample[]; endpointMs: number } {
  if (!request.sourceRange)
    return {
      filter: 'setpts=PTS-STARTPTS',
      samples: [...sourceSamples],
      endpointMs: sourceDurationMs([...sourceSamples], sourceLog),
    };
  const { startMs, endMs } = request.sourceRange;
  let first = 0;
  while (first + 1 < sourceSamples.length && sourceSamples[first + 1]!.timeMs <= startMs)
    first += 1;
  let end = first + 1;
  while (end < sourceSamples.length && sourceSamples[end]!.timeMs < endMs) end += 1;
  const samples = sourceSamples.slice(first, end).map((sample, index) => ({
    ...sample,
    timeMs: index === 0 ? 0 : sample.timeMs - startMs,
  }));
  // Keep the sample already covering the range start, including if it began
  // before that boundary. Later PTS remain relative to the actual range start.
  // An output-level -ss/-t would trim only after the timestamp probe.
  const filter = `setpts=PTS-STARTPTS,select='between(n\\,${first}\\,${end - 1})',setpts='if(eq(N\\,0)\\,0\\,PTS-${seconds(startMs)}/TB)'`;
  return { filter, samples, endpointMs: endMs - startMs };
}

/** Read actual presentation samples for authoring-time rational FPS duplication decisions. */
export async function probeOpaqueVideoTimeline(
  projectRoot: string,
  request: VideoSourceTimingRequest,
  tool: MediaTool = installedMediaTool(),
  run: MediaToolRunner = runVideoMediaToolProcess,
  admittedSourceBytes?: Uint8Array,
): Promise<VideoSourceTimingResult> {
  const sourceBytes =
    admittedSourceBytes ?? (await readContainedVideoSource(projectRoot, request.sourcePath));
  const parent = join(projectRoot, '.noveltea', 'build', 'prepared-media');
  await mkdir(parent, { recursive: true });
  const contained = relative(await realpath(projectRoot), await realpath(parent));
  if (contained.startsWith('..') || isAbsolute(contained))
    throw new Error('Video probe output must be contained in the Project.');
  const directory = await mkdtemp(join(parent, 'probe-'));
  try {
    const source = join(directory, 'source.snapshot');
    await writeFile(source, sourceBytes);
    const probe = runMediaPreparation(
      tool,
      [
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
    const timeline = sourceTimeline(request, readSampleTimes(probe.stderr), probe.stderr);
    frameDurations(timeline.samples, timeline.endpointMs);
    return {
      sampleTimesMs: timeline.samples.map((sample) => sample.timeMs),
      endpointMs: timeline.endpointMs,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const pendingVideoPreparations = new Map<string, Promise<OpaqueVideoPreparationResult>>();

/** Canonical private VP9 preparation; authored/compiled Animation semantics never name it. */
export async function prepareOpaqueVideoMotion(
  projectRoot: string,
  request: OpaqueVideoPreparationRequest,
  tool: MediaTool = installedMediaTool(),
  run: MediaToolRunner = runVideoMediaToolProcess,
  admittedSourceBytes?: Uint8Array,
): Promise<OpaqueVideoPreparationResult> {
  const sourceBytes =
    admittedSourceBytes ?? (await readContainedVideoSource(projectRoot, request.sourcePath));
  const sampling = request.frameSampling ?? { mode: 'source' };
  const key = createHash('sha256')
    .update(sourceBytes)
    .update('\0')
    .update(
      JSON.stringify({
        animationId: request.animationId,
        motionId: request.motionId,
        canvas: request.canvas,
        sourceRange: request.sourceRange ?? null,
        sampling,
        representationVersion: 5,
        toolRelease: pin.release,
      }),
    )
    .digest('hex');
  const jobKey = `${resolve(projectRoot)}\0${key}`;
  const pending = pendingVideoPreparations.get(jobKey);
  if (pending) return pending;
  const job = (async () => {
    const parent = join(projectRoot, '.noveltea', 'build', 'prepared-media');
    await mkdir(parent, { recursive: true });
    const parentRelative = relative(await realpath(projectRoot), await realpath(parent));
    if (parentRelative.startsWith('..') || isAbsolute(parentRelative))
      throw new Error('Prepared video output must be contained in the Project.');
    const directory = join(parent, key);
    const videoPath = join(directory, 'opaque.webm');
    rmSync(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const source = join(directory, 'source.snapshot');
    await writeFile(source, sourceBytes);
    try {
      const probe = runMediaPreparation(
        tool,
        [
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
      const timeline = sourceTimeline(request, readSampleTimes(probe.stderr), probe.stderr);
      const sourceSamples = timeline.samples;
      const endpointMs = timeline.endpointMs;
      const filter = samplingFilter(sampling, sourceSamples.length);
      const color = sourceColorConversion(probe.stderr);
      const { width, height } = request.canvas;
      const filters = [
        timeline.filter,
        ...(filter ? [filter] : []),
        // FFmpeg fps can repeat its last selected frame until the original
        // stream EOF, which may outlive a clipped source range. Enforce the
        // authored motion endpoint after CFR mapping, without altering VFR
        // Source/Retain sample timestamps or their terminal hold.
        ...(sampling.mode === 'target-fps' ? [`trim=end=${seconds(endpointMs)}`] : []),
        ...color.filters,
        `scale=${width}:${height}:force_original_aspect_ratio=decrease:out_color_matrix=bt709`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
        'format=yuv420p',
        'showinfo',
      ];
      const result = runMediaPreparation(
        tool,
        [
          '-y',
          '-i',
          source,
          '-map',
          '0:v:0',
          '-an',
          '-sn',
          '-dn',
          '-vf',
          filters.join(','),
          '-map_metadata',
          '-1',
          '-c:v',
          'libvpx-vp9',
          '-pix_fmt',
          'yuv420p',
          '-color_primaries',
          'bt709',
          '-color_trc',
          'bt709',
          '-colorspace',
          'bt709',
          '-color_range',
          'tv',
          '-lossless',
          '1',
          '-threads',
          '1',
          '-row-mt',
          '0',
          '-lag-in-frames',
          '0',
          '-auto-alt-ref',
          '0',
          '-g',
          '30',
          '-fps_mode',
          'vfr',
          '-enc_time_base',
          'filter',
          '-flags:v',
          '+bitexact',
          '-fflags',
          '+bitexact',
          '-progress',
          'pipe:1',
          videoPath,
        ],
        run,
      );
      // Filtering precedes encoder reordering and muxing. Verify the decoded packets
      // in the actual packaged WebM; encoder progress and filter PTS are not sufficient
      // evidence of what native libwebm and the browser will later present.
      const encodedCount = encodedFrameCount(result.stdout);
      const verified = runMediaPreparation(
        tool,
        [
          '-i',
          videoPath,
          '-map',
          '0:v:0',
          '-an',
          '-sn',
          '-dn',
          '-vf',
          'showinfo',
          '-fps_mode',
          'passthrough',
          '-f',
          'null',
          '-',
        ],
        run,
      );
      const samples = readSampleTimes(verified.stderr);
      if (samples.length !== encodedCount || samples[0]!.timeMs !== 0)
        throw new Error('Packaged video does not expose the encoded samples starting at PTS zero.');
      if (sampling.mode === 'source' && samples.length !== sourceSamples.length)
        throw new Error(
          `Source sampling lost samples: source ${sourceSamples.map((s) => s.timeMs).join(',')}, output ${samples.map((s) => s.timeMs).join(',')} (endpoint ${endpointMs}).`,
        );
      const durations = frameDurations(samples, endpointMs);
      const browserBytes = await readFile(videoPath);
      if (browserBytes.length === 0)
        throw new Error('Browser video preparation produced no media.');
      const sourceLog = probe.stderr;
      return {
        contentHash: key,
        browserVideo: {
          sourcePath: videoPath,
          projectRelativePath: `.noveltea/build/prepared-media/${key}/opaque.webm`,
          contentHash: createHash('sha256').update(browserBytes).digest('hex'),
          byteSize: browserBytes.length,
          width,
          height,
        },
        hadAudio: /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: Audio:/u.test(sourceLog),
        reducedColorPrecision: color.reducedPrecision,
        frameDurationsMs: durations,
      };
    } finally {
      await unlink(source);
    }
  })();
  pendingVideoPreparations.set(jobKey, job);
  try {
    return await job;
  } finally {
    pendingVideoPreparations.delete(jobKey);
  }
}
