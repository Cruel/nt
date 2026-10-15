import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vite-plus/test';
import {
  invokeNovelTeaNativeOperation,
  resolveNovelTeaCliPath,
} from '../../shared/noveltea-cli-subprocess';
import type {
  NativeAlphaEncodeRequest,
  NativeAlphaEncodeResult,
} from '../../main/services/transparent-video-tracer';

const ffmpeg = process.env.NOVELTEA_FFMPEG;
const available =
  !!ffmpeg &&
  existsSync(ffmpeg) &&
  existsSync(resolveNovelTeaCliPath()) &&
  /\blibwebp\b/u.test(spawnSync(ffmpeg, ['-encoders'], { encoding: 'utf8' }).stdout ?? '');

function request(ffmpegPath: string, input: string, outputPath: string, durationsMs: number[]) {
  return {
    executable: ffmpegPath,
    arguments: [
      '-nostdin',
      '-hide_banner',
      '-y',
      '-f',
      'rawvideo',
      '-pixel_format',
      'bgra',
      '-video_size',
      '6x1',
      '-framerate',
      '10',
      '-i',
      input,
      '-vf',
      'format=rgba,alphaextract,format=gray,format=rgba,geq=r=255:g=255:b=255:a=r(X\\,Y)',
      '-fps_mode',
      'passthrough',
      '-enc_time_base',
      '1:1000',
      '-c:v',
      'libwebp_anim',
      '-lossless',
      '1',
      '-pix_fmt',
      'bgra',
      '-f',
      'webp',
      'pipe:1',
    ],
    durationsMs,
    width: 6,
    height: 1,
    outputPath,
  } satisfies NativeAlphaEncodeRequest;
}

const nativeEncode = (input: NativeAlphaEncodeRequest) =>
  invokeNovelTeaNativeOperation('alpha-encode', input) as Promise<NativeAlphaEncodeResult>;

it.skipIf(!available)(
  'native FFmpeg animation preserves every 8-bit alpha value, exact holds and deduplication',
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'noveltea-native-alpha-'));
    try {
      const masks = [
        Buffer.from([0, 1, 127, 128, 254, 255]),
        Buffer.from([0, 1, 127, 128, 254, 255]),
        Buffer.from([255, 254, 128, 127, 1, 0]),
        Buffer.from([0, 127, 255, 128, 1, 254]),
      ];
      const input = path.join(directory, 'raw.bgra');
      await writeFile(
        input,
        Buffer.concat(
          masks.flatMap((mask) => Array.from(mask, (value) => Buffer.from([234, 43, 84, value]))),
        ),
      );
      const output = path.join(directory, 'alpha.webp');
      const result = await nativeEncode(request(ffmpeg!, input, output, [100, 100, 100, 100]));
      expect(result.ok, result.error).toBe(true);
      expect(result.hasAlpha).toBe(true);
      expect(result.frameCount).toBe(4);
      expect(result.holds).toEqual([
        { startMs: 0, durationMs: 200 },
        { startMs: 200, durationMs: 100 },
        { startMs: 300, durationMs: 100 },
      ]);
      const webp = await readFile(output);
      const metadata = await sharp(webp, { animated: true }).metadata();
      expect(metadata.pages).toBe(3);
      expect(metadata.delay).toEqual([200, 100, 100]);
      for (const [index, mask] of [masks[0]!, masks[2]!, masks[3]!].entries()) {
        const rgba = await sharp(webp, { page: index, pages: 1 }).ensureAlpha().raw().toBuffer();
        expect(Buffer.from(rgba.filter((_, at) => at % 4 === 3))).toEqual(mask);
      }
      expect(webp.length).toBeLessThan(2000);
      expect(createHash('sha256').update(webp).digest('hex')).toHaveLength(64);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

it.skipIf(!available)(
  'native FFmpeg encoder omits opaque masks, rejects malformed requests and cleans up',
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'noveltea-native-alpha-opaque-'));
    try {
      const input = path.join(directory, 'opaque.bgra');
      await writeFile(input, Buffer.alloc(6 * 4 * 3, 255));
      const output = path.join(directory, 'alpha.webp');
      const base = request(ffmpeg!, input, output, [50, 100, 150]);
      const result = await nativeEncode(base);
      expect(result.ok, result.error).toBe(true);
      expect(result.hasAlpha).toBe(false);
      expect(result.holds).toEqual([]);
      await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });

      const failed = await nativeEncode({ ...base, executable: path.join(directory, 'no-ffmpeg') });
      expect(failed.ok).toBe(false);
      expect(failed.error).toMatch(/cannot launch/i);
      const invalid = await nativeEncode({ ...base, durationsMs: [0, 100, 150] });
      expect(invalid.ok).toBe(false);
      expect(invalid.error).toMatch(/duration/i);
      await expect(stat(path.join(directory, 'alpha.webp.partial'))).rejects.toMatchObject({
        code: 'ENOENT',
      });

      // Native capture probes pure operations twice. A side-effecting encoder
      // must reject that path rather than running the subprocess twice.
      const bridge = path.resolve(
        process.cwd(),
        '../build/linux-authoring-release/tools/editor_tool/noveltea-tooling-bridge',
      );
      if (existsSync(bridge)) {
        const requestPath = path.join(directory, 'request.json');
        const responsePath = path.join(directory, 'response.json');
        await writeFile(requestPath, JSON.stringify(base));
        const captured = spawnSync(bridge, ['capture:alpha-encode', requestPath, responsePath]);
        expect(captured.status).toBe(0);
        expect(JSON.parse(await readFile(responsePath, 'utf8'))).toEqual({
          ok: false,
          error: 'alpha-encode does not support capture mode',
        });
        await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

it.skipIf(!available)(
  'matches FFmpeg compressed animation and 480p/1080p sparse-mask size budgets',
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'noveltea-alpha-size-'));
    try {
      for (const [width, height, expectedBytes] of [
        [854, 480, 1498],
        [1920, 1080, 1842],
      ] as const) {
        const input = path.join(directory, 'sparse-' + width + '.gray');
        const writer = await open(input, 'w');
        try {
          const blockWidth = Math.floor(width / 6);
          const blockHeight = Math.floor(height / 5);
          for (let frame = 0; frame < 36; frame++) {
            const step = frame < 9 ? 0 : frame < 24 ? frame - 8 : 15;
            const x = Math.floor(width / 5) + Math.floor((step * width) / 85);
            const y = Math.floor(height / 3) + Math.floor((step * height) / 130);
            const mask = Buffer.alloc(width * height);
            for (let row = 0; row < blockHeight; row++) {
              const value =
                row === 0 || row === blockHeight - 1
                  ? 2
                  : row === 1 || row === blockHeight - 2
                    ? 128
                    : 255;
              const start = (y + row) * width + x;
              mask.fill(value, start, start + blockWidth);
            }
            await writer.write(mask);
          }
        } finally {
          await writer.close();
        }
        const encoded = path.join(directory, 'alpha.webp');
        const reference = path.join(directory, 'reference-' + width + '.webp');
        const args = [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'rawvideo',
          '-pixel_format',
          'gray',
          '-video_size',
          width + 'x' + height,
          '-framerate',
          '20',
          '-i',
          input,
          '-vf',
          'format=rgba,geq=r=255:g=255:b=255:a=r(X\\,Y)',
          '-fps_mode',
          'passthrough',
          '-enc_time_base',
          '1:1000',
          '-lossless',
          '1',
          '-pix_fmt',
          'bgra',
          '-c:v',
          'libwebp_anim',
        ];
        const result = await nativeEncode({
          executable: ffmpeg!,
          arguments: [...args, '-f', 'webp', 'pipe:1'],
          durationsMs: Array(36).fill(50),
          width,
          height,
          outputPath: encoded,
        });
        expect(result.ok, result.error).toBe(true);
        expect(result.hasAlpha).toBe(true);
        const direct = spawnSync(ffmpeg!, [...args, '-f', 'webp', reference], {
          encoding: 'utf8',
          timeout: 30_000,
        });
        expect(direct.status, direct.stderr).toBe(0);
        const actual = await readFile(encoded);
        const ffmpegDirect = await readFile(reference);
        expect(actual.byteLength).toBeLessThanOrEqual(expectedBytes);
        // FFmpeg uses a different animation loop count for piped output
        // than for a seekable file. Ignore only that playback-policy field;
        // compressed rectangles, durations and pixels must remain identical.
        const withoutLoopCount = (bytes: Buffer) => {
          const normalized = Buffer.from(bytes);
          const anim = normalized.indexOf('ANIM');
          expect(anim).toBeGreaterThan(0);
          normalized.writeUInt16LE(0, anim + 12);
          return normalized;
        };
        expect(withoutLoopCount(actual)).toEqual(withoutLoopCount(ffmpegDirect));
        const last = result.holds!.at(-1)!;
        expect(last.startMs + last.durationMs).toBe(1_800);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
