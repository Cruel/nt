/** Streams FFmpeg's gray alpha plane through one R8 canvas of Node memory. */
import { spawn } from 'node:child_process';
import { encodeAlphaMasks, type EncodedAlphaMotion } from './animated-webp-alpha-encoder';

export interface StreamedAlphaMotion {
  result: EncodedAlphaMotion;
  stderr: string;
}

export async function encodeAlphaFromFfmpeg(
  executable: string,
  arguments_: readonly string[],
  durations: readonly number[],
  width: number,
  height: number,
): Promise<StreamedAlphaMotion> {
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels < 1)
    throw new Error('Invalid FFmpeg R8 alpha extent.');
  const child = spawn(executable, [...arguments_], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const diagnostics: Buffer[] = [];
  let diagnosticBytes = 0;
  let logOverflow = false;
  child.stderr.on('data', (piece: Buffer) => {
    diagnosticBytes += piece.length;
    if (diagnosticBytes > 64 * 1024 * 1024) {
      logOverflow = true;
      child.kill();
    } else diagnostics.push(piece);
  });
  // Attach this listener immediately; the tool may exit before the
  // streaming iterator consumes its final byte.
  const exit = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? -1));
  });

  const frames = async function* (): AsyncGenerator<Buffer> {
    let frame = Buffer.allocUnsafe(pixels);
    let offset = 0;
    let received = 0;
    for await (const part of child.stdout) {
      const chunk: Buffer = Buffer.isBuffer(part) ? part : Buffer.from(part);
      let at = 0;
      while (at < chunk.length) {
        if (received >= durations.length)
          throw new Error('FFmpeg emitted more alpha pages than prepared color samples.');
        const length = Math.min(pixels - offset, chunk.length - at);
        chunk.copy(frame, offset, at, at + length);
        offset += length;
        at += length;
        if (offset === pixels) {
          received += 1;
          yield frame;
          frame = Buffer.allocUnsafe(pixels);
          offset = 0;
        }
      }
    }
    if (offset !== 0 || received !== durations.length)
      throw new Error('FFmpeg alpha stream ended without matching the color frame count.');
  };

  try {
    const result = await encodeAlphaMasks(frames(), durations, width, height);
    const code = await exit;
    if (logOverflow)
      throw new Error('FFmpeg emitted more than 64 MiB of alpha timeline diagnostics.');
    if (code !== 0)
      throw new Error(
        `FFmpeg alpha extraction failed (${code}): ${Buffer.concat(diagnostics).toString('utf8')}`,
      );
    return { result, stderr: Buffer.concat(diagnostics).toString('utf8') };
  } catch (error) {
    child.kill();
    await exit.catch(() => undefined);
    throw error;
  }
}
