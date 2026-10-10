import { spawn } from 'node:child_process';
import { resolveNovelTeaCliPath } from '../../shared/noveltea-cli-subprocess';
import { installedMediaTool, type MediaTool } from './media-preparation-service';

const PROBE_TIMEOUT_MS = 20_000;
const MAX_DIAGNOSTIC_BYTES = 32 * 1024;

type ProbeOutput = { stdout: string; stderr: string };
export type MediaImportProbeRunner = (
  executable: string,
  args: readonly string[],
) => Promise<ProbeOutput>;

/** One bounded decode, not a full-file transcode. Never use the shell with authored paths. */
export const runMediaImportProbe: MediaImportProbeRunner = (executable, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let failure: Error | null = null;
    const fail = (error: Error) => {
      failure ??= error;
      child.kill();
    };
    const timer = setTimeout(() => {
      fail(new Error('Media import validation timed out.'));
    }, PROBE_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (Buffer.byteLength(stdout) > MAX_DIAGNOSTIC_BYTES)
        fail(new Error('Media import probe produced too much output.'));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (Buffer.byteLength(stderr) > MAX_DIAGNOSTIC_BYTES)
        fail(new Error('Media import probe produced too much diagnostic output.'));
    });
    child.on('error', (error) => {
      failure ??= error;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(new Error(stderr.trim() || `FFmpeg exited with code ${String(code)}.`));
      else resolve({ stdout, stderr });
    });
  });

/**
 * Decode the first audio sample block / video frame using the same private FFmpeg tool
 * as media preparation. A framehash record proves that a decoder actually produced
 * media; successful container probing alone is insufficient.
 *
 * This is intentionally NOT exhaustive corruption detection or export transcoding.
 */
export async function validateImportedAudioVideo(
  absolutePath: string,
  kind: 'audio' | 'video',
  options: { tool?: MediaTool; run?: MediaImportProbeRunner } = {},
): Promise<void> {
  const tool = options.tool ?? installedMediaTool(resolveNovelTeaCliPath());
  const stream = kind === 'audio' ? 'a' : 'v';
  const args = [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-xerror',
    '-i',
    absolutePath,
    '-map',
    `0:${stream}:0`,
    `-frames:${stream}`,
    '1',
    '-f',
    'framehash',
    'pipe:1',
  ];
  let result: ProbeOutput;
  try {
    result = await (options.run ?? runMediaImportProbe)(tool.executable, args);
  } catch (error) {
    throw new Error(
      `Cannot import ${kind}: FFmpeg could not decode the first ${kind === 'audio' ? 'audio block' : 'video frame'} (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  if (!/^\s*0\s*,/mu.test(result.stdout))
    throw new Error(
      `Cannot import ${kind}: FFmpeg produced no decoded ${kind === 'audio' ? 'audio samples' : 'video frames'}.`,
    );
}
