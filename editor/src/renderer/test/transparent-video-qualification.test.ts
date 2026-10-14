/**
 * Optional #408 high-resolution media qualification. Creates a source with
 * moving detailed color and antialiased irregular alpha edges, runs the real
 * FFmpeg -> prepared VP9 + lossless WebP path, verifies byte-identical
 * production streaming export preparation, and exercises Sharp and persistent
 * libwebp reference decoders. Player/device qualification is separate.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vite-plus/test';
import {
  prepareProductionVideoMotion,
  traceTransparentVideo,
  WebpAlphaTraceSession,
} from '../../main/services/transparent-video-tracer';

const ffmpeg = path.resolve(process.cwd(), '../build/cli/linux/tools/ffmpeg/bin/ffmpeg');
const probe = path.resolve(process.cwd(), '../tests/media/webp_alpha_persistent_probe.py');
const persistentAvailable =
  spawnSync('python3', ['-c', 'import ctypes.util; assert ctypes.util.find_library("webpdemux")'])
    .status === 0;
const enabled =
  process.env.NOVELTEA_ALPHA_QUALIFY === '1' &&
  process.platform === 'linux' &&
  existsSync(ffmpeg) &&
  existsSync(probe) &&
  persistentAvailable;

function ffmpegRun(_executable: string, args: readonly string[]) {
  const result = spawnSync(ffmpeg, [...args], {
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(`FFmpeg failed: ${result.stderr || result.error?.message}`);
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function detailedSource(width: number, height: number): Buffer {
  const pixels = width * height;
  const input = Buffer.allocUnsafe(pixels * 4 * 3);
  for (let frame = 0; frame < 3; frame += 1) {
    for (let y = 0; y < height; y += 1) {
      const edge =
        Math.round(width * 0.48 + Math.sin(y / 57) * width * 0.09) +
        (frame === 2 ? Math.round(width * 0.11) : 0);
      for (let x = 0; x < width; x += 1) {
        const pixel = (frame * pixels + y * width + x) * 4;
        // Textured/gradient motion: unlike the earlier constant-color stress,
        // this exercises spatial detail, moving color, and irregular coverage.
        input[pixel] = (Math.floor((x * 255) / width) + frame * 13) % 256;
        input[pixel + 1] = Math.floor((y * 255) / height);
        input[pixel + 2] = (((x >> 4) ^ (y >> 4)) * 9 + frame * 23) % 256;
        const leftEdge = Math.max(0, Math.min(255, (x - edge + 8) * 16));
        const hole = ((x >> 6) + (y >> 6)) % 11 === 0 ? 0 : 255;
        input[pixel + 3] = Math.min(leftEdge, hole);
      }
    }
  }
  return input;
}

it.skipIf(!enabled)(
  'qualifies 1080p/4K original-like ProRes alpha sources through production VP9, WebP, and persistent replay',
  async () => {
    for (const [width, height] of [
      [1920, 1080],
      [3840, 2160],
    ]) {
      const root = await mkdtemp(path.join(tmpdir(), 'noveltea-alpha-qualification-'));
      try {
        await writeFile(path.join(root, 'source.rgba'), detailedSource(width!, height!));
        ffmpegRun(ffmpeg, [
          '-y',
          '-f',
          'rawvideo',
          '-pixel_format',
          'rgba',
          '-video_size',
          `${width}x${height}`,
          '-framerate',
          '10',
          '-i',
          path.join(root, 'source.rgba'),
          '-an',
          '-c:v',
          'prores_ks',
          '-profile:v',
          '4444',
          '-pix_fmt',
          'yuva444p10le',
          '-alpha_bits',
          '16',
          '-threads',
          '2',
          path.join(root, 'source.mov'),
        ]);
        const start = performance.now();
        const prepared = await traceTransparentVideo(
          root,
          {
            animationId: 'qualification',
            motionId: 'color-alpha',
            assetId: 'source',
            sourcePath: 'source.mov',
            canvas: { width: width!, height: height! },
          },
          { executable: ffmpeg, bundled: true },
          ffmpegRun,
        );
        const prepareMs = performance.now() - start;
        // Production export takes the streaming FFmpeg pipe path, independently
        // from the test-runner-file tracer, even for full 4K original media.
        const exported = await prepareProductionVideoMotion(
          root,
          {
            animationId: 'qualification',
            motionId: 'streamed',
            assetId: 'source',
            sourcePath: 'source.mov',
            canvas: { width: width!, height: height! },
          },
          { executable: ffmpeg, bundled: true },
        );
        expect(exported.alphaWebp).toBeDefined();
        expect(await readFile(exported.alphaWebp!.sourcePath)).toEqual(prepared.alphaWebp);
        expect(prepared.colorDurationsMs).toEqual([100, 100, 100]);
        expect(prepared.holds).toEqual([
          { startMs: 0, durationMs: 200 },
          { startMs: 200, durationMs: 100 },
        ]);
        const meta = await sharp(prepared.alphaWebp, { animated: true }).metadata();
        expect(meta.pages).toBe(2);
        expect(meta.delay).toEqual([200, 100]);

        const decoder = new WebpAlphaTraceSession(
          prepared.alphaWebp,
          prepared.holds,
          width!,
          height!,
        );
        const decodeStart = performance.now();
        const first = (await decoder.sample(0)).alpha;
        expect((await decoder.sample(199)).alpha).toBe(first);
        const second = (await decoder.sample(200)).alpha;
        expect((await decoder.sample(299)).alpha).toBe(second);
        expect(second).not.toEqual(first);
        expect((await decoder.sample(0)).alpha).toEqual(first);
        expect(await decoder.hit(0, 0, 0)).toBe(false);
        expect(await decoder.hit(250, width! - 1, height! - 1)).toBe(true);
        await expect(decoder.sample(300)).rejects.toThrow('endpoint');
        const decodeMs = performance.now() - decodeStart;

        await writeFile(path.join(root, 'alpha.webp'), prepared.alphaWebp);
        await writeFile(path.join(root, 'page0.r8'), first);
        await writeFile(path.join(root, 'page1.r8'), second);
        await writeFile(
          path.join(root, 'probe.json'),
          JSON.stringify({
            width,
            height,
            webp: 'alpha.webp',
            pages: ['page0.r8', 'page1.r8'],
            holds: prepared.holds,
            seeks: [0, 199, 200, 299, 100, 250, 0, 299],
          }),
        );
        const persistent = spawnSync('python3', [probe, path.join(root, 'probe.json')], {
          encoding: 'utf8',
          timeout: 120_000,
        });
        if (persistent.status !== 0)
          throw new Error(
            `Persistent libwebp qualification failed: ${persistent.stderr || persistent.error?.message}`,
          );
        const evidence = JSON.parse(persistent.stdout);
        expect(evidence).toMatchObject({
          decoder: 'libwebp-animated-persistent',
          width,
          height,
          pages: 2,
          seeks: 8,
        });
        console.info(
          `ALPHA_QUALIFY ${width}x${height} preparedMs=${prepareMs.toFixed(1)} ` +
            `traceDecodeMs=${decodeMs.toFixed(1)} encodedWebpBytes=${prepared.alphaWebp.length} ` +
            `oneMaskBytes=${width! * height!} residentWebpDecoderPeakKiB=${evidence.maxRssKiB} ` +
            `rssHistoryKiB=${evidence.rssSamplesKiB.join(',')} ` +
            `processRssMiB=${(process.memoryUsage().rss / 1048576).toFixed(1)}`,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  },
  480_000,
);
