import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import pin from '../../shared/media-tool-pin.json';
import {
  OPAQUE_VIDEO_FRAME_RATE,
  type OpaqueVideoPreparationRequest,
  type OpaqueVideoPreparationResult,
} from '../../shared/prepared-media-contracts';
import {
  installedMediaTool,
  runMediaPreparation,
  runMediaToolProcess,
  type MediaTool,
  type MediaToolRunner,
} from './media-preparation-service';

function seconds(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(6).replace(/0+$/u, '').replace(/\.$/u, '');
}

async function readContainedVideoSource(projectRoot: string, sourcePath: string): Promise<Buffer> {
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

function frameDurations(frameCount: number, authoredDurationMs?: number): number[] {
  const durations: number[] = [];
  for (let index = 0; index < frameCount; index += 1) {
    const start = Math.round((index * 1000) / OPAQUE_VIDEO_FRAME_RATE);
    const end =
      index === frameCount - 1 && authoredDurationMs !== undefined
        ? authoredDurationMs
        : Math.round(((index + 1) * 1000) / OPAQUE_VIDEO_FRAME_RATE);
    if (end <= start)
      throw new Error('Prepared video frames extend beyond the authored source range.');
    durations.push(end - start);
  }
  return durations;
}

function encodedFrameCount(progress: string): number {
  // FFmpeg -progress produces machine-readable reports, including the final
  // number of encoded frames. Never infer the count from an estimated duration:
  // short sources and source-range trims may yield fewer samples.
  const reports = [...progress.matchAll(/^frame=(\d+)\r?$/gmu)];
  if (!/^progress=end\r?$/mu.test(progress) || reports.length === 0)
    throw new Error('Video preparation did not report a completed frame count.');
  const count = Number(reports.at(-1)![1]);
  if (!Number.isSafeInteger(count) || count <= 0 || count > 1_000_000)
    throw new Error('Video preparation produced an invalid number of frames.');
  return count;
}

const pendingVideoPreparations = new Map<string, Promise<OpaqueVideoPreparationResult>>();

/** Canonical private VP9 preparation; authored/compiled Animation semantics never name it. */
export async function prepareOpaqueVideoMotion(
  projectRoot: string,
  request: OpaqueVideoPreparationRequest,
  tool: MediaTool = installedMediaTool(),
  run: MediaToolRunner = runMediaToolProcess,
  admittedSourceBytes?: Uint8Array,
): Promise<OpaqueVideoPreparationResult> {
  const sourceBytes =
    admittedSourceBytes ?? (await readContainedVideoSource(projectRoot, request.sourcePath));
  const key = createHash('sha256')
    .update(sourceBytes)
    .update('\0')
    .update(
      JSON.stringify({
        animationId: request.animationId,
        motionId: request.motionId,
        canvas: request.canvas,
        sourceRange: request.sourceRange ?? null,
        frameRate: OPAQUE_VIDEO_FRAME_RATE,
        representationVersion: 2,
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
    // Decode the hashed snapshot, not a pathname that can change after Asset admission.
    const source = join(directory, 'source.snapshot');
    await writeFile(source, sourceBytes);
    const args: string[] = ['-y', '-i', source];
    if (request.sourceRange) {
      args.push('-ss', seconds(request.sourceRange.startMs));
      args.push('-t', seconds(request.sourceRange.endMs - request.sourceRange.startMs));
    }
    const { width, height } = request.canvas;
    args.push(
      '-map',
      '0:v:0',
      '-an',
      '-sn',
      '-dn',
      '-vf',
      `fps=${OPAQUE_VIDEO_FRAME_RATE},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,format=rgb24`,
      '-map_metadata',
      '-1',
      '-c:v',
      'libvpx-vp9',
      '-pix_fmt',
      'yuv420p',
      '-lossless',
      '1',
      '-threads',
      '1',
      '-row-mt',
      '0',
      '-g',
      '30',
      '-flags:v',
      '+bitexact',
      '-progress',
      'pipe:1',
      videoPath,
    );
    let result: ReturnType<MediaToolRunner>;
    try {
      result = runMediaPreparation(tool, args, run);
    } finally {
      await unlink(source);
    }
    const frameCount = encodedFrameCount(result.stdout);
    const authoredDurationMs = request.sourceRange
      ? request.sourceRange.endMs - request.sourceRange.startMs
      : undefined;
    const durations = frameDurations(frameCount, authoredDurationMs);
    const browserBytes = await readFile(videoPath);
    if (browserBytes.length === 0) throw new Error('Browser video preparation produced no media.');
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
      hadAudio: /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: Audio:/u.test(result.stderr),
      frameDurationsMs: durations,
    };
  })();
  pendingVideoPreparations.set(jobKey, job);
  try {
    return await job;
  } finally {
    pendingVideoPreparations.delete(jobKey);
  }
}
