import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync, rmSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import pin from '../../shared/media-tool-pin.json';
import {
  OPAQUE_VIDEO_FRAME_RATE,
  type OpaqueVideoPreparationRequest,
  type OpaqueVideoPreparationResult,
} from '../../shared/prepared-media-contracts';

export interface MediaTool {
  readonly executable: string;
  readonly bundled: boolean;
}

export type MediaToolRunner = (
  executable: string,
  args: readonly string[],
) => { stdout: string; stderr: string };

export function resolveMediaTool(options: {
  cliExecutable: string;
  platform?: string;
  override?: string;
}): MediaTool {
  if (options.override !== undefined) {
    if (!isAbsolute(options.override))
      throw new Error('NOVELTEA_FFMPEG must name an absolute executable path.');
    return { executable: options.override, bundled: false };
  }
  const directory = dirname(options.cliExecutable);
  const installation = basename(directory) === 'bin' ? dirname(directory) : directory;
  return {
    executable: join(
      installation,
      'tools',
      'ffmpeg',
      'bin',
      (options.platform ?? process.platform) === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
    ),
    bundled: true,
  };
}

export function installedMediaTool(cliExecutable = process.execPath): MediaTool {
  return resolveMediaTool({
    // Public CLI links must resolve against the installation, not /usr/bin.
    cliExecutable: realpathSync(cliExecutable),
    override: process.env.NOVELTEA_FFMPEG,
  });
}

export const runMediaToolProcess: MediaToolRunner = (executable, args) => {
  const result = spawnSync(executable, [...args], {
    encoding: 'utf8',
    stdio: 'pipe',
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

export function inspectMediaTool(tool: MediaTool, run: MediaToolRunner = runMediaToolProcess) {
  const identity = run(tool.executable, ['-version']);
  const text = identity.stdout + identity.stderr;
  const version = /^ffmpeg version (\S+)/m.exec(text)?.[1];
  if (!version || (tool.bundled && version !== pin.version))
    throw new Error(
      `Media tool '${tool.executable}' has wrong identity; expected FFmpeg ${tool.bundled ? pin.version : '(external build)'}.`,
    );
  if (tool.bundled) {
    for (const flag of [
      '--disable-gpl',
      '--disable-nonfree',
      '--disable-version3',
      '--disable-network',
      '--enable-libaom',
      '--enable-libvpx',
    ]) {
      if (!text.split(/\s+/).includes(flag))
        throw new Error(`Bundled FFmpeg ${pin.release} is missing configuration ${flag}.`);
    }
  }
  const encoders = run(tool.executable, ['-hide_banner', '-encoders']);
  for (const encoder of ['libaom-av1', 'libvpx-vp9']) {
    if (!(encoders.stdout + encoders.stderr).split(/\s+/).includes(encoder))
      throw new Error(`Media tool '${tool.executable}' is missing encoder ${encoder}.`);
  }
  const protocols = run(tool.executable, ['-hide_banner', '-protocols']);
  for (const protocol of ['file', 'pipe']) {
    if (!(protocols.stdout + protocols.stderr).split(/\s+/).includes(protocol))
      throw new Error(`Media tool '${tool.executable}' is missing protocol ${protocol}.`);
  }
  return { ...tool, version, release: tool.bundled ? pin.release : null };
}

/** Trusted host jobs only; authored data never supplies arbitrary process arguments. */
export function runMediaPreparation(
  tool: MediaTool,
  args: readonly string[],
  run: MediaToolRunner = runMediaToolProcess,
) {
  inspectMediaTool(tool, run);
  return run(tool.executable, ['-nostdin', '-hide_banner', ...args]);
}

function seconds(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(6).replace(/0+$/u, '').replace(/\.$/u, '');
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

/**
 * Canonical tracer preparation for generic opaque Animation video. The generated frame sequence is
 * deliberately private runtime-artifact data; authored/compiled Animation semantics never name it.
 */
export async function prepareOpaqueVideoMotion(
  projectRoot: string,
  request: OpaqueVideoPreparationRequest,
  tool: MediaTool = installedMediaTool(),
  run: MediaToolRunner = runMediaToolProcess,
): Promise<OpaqueVideoPreparationResult> {
  const source = join(projectRoot, request.sourcePath);
  const sourceBytes = await readFile(source);
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
  const directory = join(projectRoot, '.noveltea', 'build', 'prepared-media', key);
  const pattern = join(directory, 'frame-%06d.png');
  // ScriptC's static host supports recursive removal through rmSync, not async rm options.
  rmSync(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });

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
  const result = runMediaPreparation(tool, args, run);
  const frameNames = (await readdir(directory))
    .filter((name) => /^frame-\d{6}\.png$/u.test(name))
    .sort((left, right) => left.localeCompare(right));
  if (frameNames.length === 0)
    throw new Error(`Video preparation produced no frames for Animation '${request.animationId}'.`);
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
    hadAudio: /Stream #\d+:\d+(?:\([^)]*\))?: Audio:/u.test(result.stderr),
    frames,
  };
}
