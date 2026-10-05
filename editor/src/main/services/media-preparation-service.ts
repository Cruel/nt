import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import pin from '../../shared/media-tool-pin.json';

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
