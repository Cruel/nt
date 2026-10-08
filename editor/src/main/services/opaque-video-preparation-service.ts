import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
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

function frameDurations(frameCount: number): number[] {
  const durations: number[] = [];
  for (let index = 0; index < frameCount; index += 1) {
    const start = Math.round((index * 1000) / OPAQUE_VIDEO_FRAME_RATE);
    const end = Math.round(((index + 1) * 1000) / OPAQUE_VIDEO_FRAME_RATE);
    durations.push(Math.max(1, end - start));
  }
  return durations;
}

const pendingVideoPreparations = new Map<string, Promise<OpaqueVideoPreparationResult>>();

/** Canonical private raster preparation; authored/compiled Animation semantics never name it. */
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
    const pattern = join(directory, 'frame-%06d.png');
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
      '-start_number',
      '0',
      pattern,
    );
    let result: ReturnType<MediaToolRunner>;
    try {
      result = runMediaPreparation(tool, args, run);
    } finally {
      await unlink(source);
    }
    const frameNames = (await readdir(directory))
      .filter((name) => /^frame-\d{6}\.png$/u.test(name))
      .sort((left, right) => left.localeCompare(right));
    if (frameNames.length === 0)
      throw new Error(
        `Video preparation produced no frames for Animation '${request.animationId}'.`,
      );
    const durations = frameDurations(frameNames.length);
    const frames = await Promise.all(
      frameNames.map(async (name, index) => {
        const sourcePath = join(directory, name);
        const bytes = await readFile(sourcePath);
        return {
          sourcePath,
          projectRelativePath: `.noveltea/build/prepared-media/${key}/${name}`,
          contentHash: createHash('sha256').update(bytes).digest('hex'),
          byteSize: bytes.byteLength,
          durationMs: durations[index]!,
        };
      }),
    );
    return {
      contentHash: key,
      hadAudio: /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: Audio:/u.test(result.stderr),
      frames,
    };
  })();
  pendingVideoPreparations.set(jobKey, job);
  try {
    return await job;
  } finally {
    pendingVideoPreparations.delete(jobKey);
  }
}
