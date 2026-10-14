import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vite-plus/test';
import {
  prepareProductionVideoMotion,
  traceTransparentVideo,
  type NativeAlphaEncodeResult,
} from '../../main/services/transparent-video-tracer';
import {
  invokeNovelTeaNativeOperation,
  resolveNovelTeaCliPath,
} from '../../shared/noveltea-cli-subprocess';
import { WebpAlphaTraceSession } from './support/webp-alpha-trace-session';

const ffmpeg =
  process.env.NOVELTEA_FFMPEG ??
  path.resolve(process.cwd(), '../build/cli/linux/tools/ffmpeg/bin/ffmpeg');
const hasWebpEncoder =
  existsSync(ffmpeg) &&
  /\blibwebp\b/u.test(
    spawnSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? '',
  );

function run(_executable: string, args: readonly string[]) {
  const result = spawnSync(ffmpeg, [...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0)
    throw new Error(result.stderr || result.error?.message || 'FFmpeg failed');
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

it.skipIf(!hasWebpEncoder)(
  'traces ProRes 4444 and VP8/VP9 auxiliary alpha through prepared VP9 color and one timed lossless WebP',
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-alpha-integration-'));
    const tool = { executable: ffmpeg, bundled: !process.env.NOVELTEA_FFMPEG };
    try {
      const width = 32,
        height = 24,
        frames = 4;
      const rgba = Buffer.alloc(width * height * 4 * frames);
      for (let frame = 0; frame < frames; frame += 1) {
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const offset = (frame * width * height + y * width + x) * 4;
            rgba[offset] = frame > 1 ? 30 : 230;
            rgba[offset + 1] = 80;
            rgba[offset + 2] = 160;
            rgba[offset + 3] = frame > 1 ? (x < 16 ? 0 : 201) : x < 16 ? 155 : 0;
          }
        }
      }
      await writeFile(path.join(root, 'frames.rgba'), rgba);
      for (const [input, codec] of [
        [
          'alpha.mov',
          [
            '-c:v',
            'prores_ks',
            '-profile:v',
            '4444',
            '-pix_fmt',
            'yuva444p10le',
            '-alpha_bits',
            '16',
          ],
        ],
        [
          'alpha.webm',
          ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-lossless', '1', '-threads', '1'],
        ],
        [
          'alpha-vp8.webm',
          ['-c:v', 'libvpx', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-threads', '1'],
        ],
      ] as const) {
        run(ffmpeg, [
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
          path.join(root, 'frames.rgba'),
          '-an',
          ...codec,
          path.join(root, input),
        ]);
        const trace = await traceTransparentVideo(
          root,
          {
            animationId: 'alpha-trace',
            motionId: input,
            assetId: input,
            sourcePath: input,
            canvas: { width: 80, height: 48 },
          },
          tool,
          run,
        );
        if (input === 'alpha.mov') {
          const production = await prepareProductionVideoMotion(
            root,
            {
              animationId: 'alpha-production',
              motionId: input,
              assetId: input,
              sourcePath: input,
              canvas: { width: 80, height: 48 },
            },
            tool,
            run,
          );
          expect(production.alphaWebp?.projectRelativePath).toMatch(/\/alpha\.webp$/u);
          expect(production.alphaWebp?.byteSize).toBeGreaterThan(0);
          expect(await readFile(production.alphaWebp!.sourcePath)).toEqual(trace.alphaWebp);
          // Exercise the real FFmpeg pipe, not the injected file-output runner.
          const streamed = await prepareProductionVideoMotion(
            root,
            {
              animationId: 'alpha-production-streamed',
              motionId: input,
              assetId: input,
              sourcePath: input,
              canvas: { width: 80, height: 48 },
            },
            tool,
          );
          expect(streamed.alphaWebp).toBeDefined();
          expect(await readFile(streamed.alphaWebp!.sourcePath)).toEqual(trace.alphaWebp);
        }
        if (existsSync(resolveNovelTeaCliPath())) {
          const native = await traceTransparentVideo(
            root,
            {
              animationId: 'alpha-native-trace',
              motionId: input,
              assetId: input,
              sourcePath: input,
              canvas: { width: 80, height: 48 },
            },
            tool,
            run,
            (request) =>
              invokeNovelTeaNativeOperation(
                'alpha-encode',
                request,
              ) as Promise<NativeAlphaEncodeResult>,
          );
          expect(native.colorDurationsMs).toEqual(trace.colorDurationsMs);
          expect(native.holds).toEqual(trace.holds);
          const nativeSession = new WebpAlphaTraceSession(native.alphaWebp, native.holds, 80, 48);
          const referenceSession = new WebpAlphaTraceSession(trace.alphaWebp, trace.holds, 80, 48);
          for (const hold of trace.holds)
            expect((await nativeSession.sample(hold.startMs)).alpha).toEqual(
              (await referenceSession.sample(hold.startMs)).alpha,
            );
        }
        expect(trace.colorDurationsMs).toEqual([100, 100, 100, 100]);
        expect(trace.holds).toEqual([
          { startMs: 0, durationMs: 200 },
          { startMs: 200, durationMs: 200 },
        ]);
        expect((await sharp(trace.alphaWebp, { animated: true }).metadata()).pages).toBe(2);
        expect((await readFile(trace.colorVideoPath)).length).toBeGreaterThan(0);
        const session = new WebpAlphaTraceSession(trace.alphaWebp, trace.holds, 80, 48);
        const first = await session.sample(100);
        expect(first.page).toBe(0);
        expect((await session.sample(199)).alpha).toBe(first.alpha); // same held GPU/CPU mask
        expect(await session.hit(100, 1, 1)).toBe(false); // transparent padding
        expect(await session.hit(100, 12, 24)).toBe(true);
        expect(await session.hit(100, 50, 24)).toBe(false);
        const second = await session.sample(200);
        expect(second.page).toBe(1);
        expect(second.alpha).not.toBe(first.alpha);
        expect(await session.hit(201, 12, 24)).toBe(false);
        expect(await session.hit(201, 50, 24)).toBe(true);
        expect((await session.sample(399)).alpha).toBe(second.alpha);
        await expect(session.sample(400)).rejects.toThrow('endpoint');
        for (const [name, options, expectedColorDurations, expectedAlphaDurations] of [
          [
            'cfr20',
            { frameSampling: { mode: 'target-fps', fps: { numerator: 20, denominator: 1 } } },
            Array(8).fill(50),
            [200, 200],
          ],
          [
            'retain50',
            { frameSampling: { mode: 'retain-percent', percent: 50 } },
            [300, 100],
            [300, 100],
          ],
          ['range', { sourceRange: { startMs: 50, endMs: 350 } }, [50, 100, 100, 50], [150, 150]],
        ] as const) {
          const variant = await traceTransparentVideo(
            root,
            {
              animationId: 'alpha-trace',
              motionId: name + input,
              assetId: input,
              sourcePath: input,
              canvas: { width: 80, height: 48 },
              ...options,
            },
            tool,
            run,
          );
          expect(variant.colorDurationsMs, name).toEqual(expectedColorDurations);
          expect(
            variant.holds.map((hold) => hold.durationMs),
            name,
          ).toEqual(expectedAlphaDurations);
          const decoded = new WebpAlphaTraceSession(variant.alphaWebp, variant.holds, 80, 48);
          expect((await decoded.sample(variant.holds.at(-1)!.startMs)).page).toBe(1);
        }
        const rational = await traceTransparentVideo(
          root,
          {
            animationId: 'alpha-trace',
            motionId: 'rational-' + input,
            assetId: input,
            sourcePath: input,
            canvas: { width: 80, height: 48 },
            frameSampling: { mode: 'target-fps', fps: { numerator: 30000, denominator: 1001 } },
          },
          tool,
          run,
        );
        expect(rational.colorDurationsMs).toHaveLength(12);
        expect(rational.colorDurationsMs.reduce((sum, duration) => sum + duration, 0)).toBe(400);
        expect(rational.holds.map((hold) => hold.durationMs)).toEqual([200, 200]);
      }
      // Constant nonopaque coverage is a single timed lossless VP8L still,
      // not an ANIM container; it must remain a valid production sidecar.
      const constantRgba = Buffer.from(rgba);
      for (let frame = 1; frame < frames; frame += 1)
        for (let pixel = 0; pixel < width * height; pixel += 1)
          constantRgba[(frame * width * height + pixel) * 4 + 3] = constantRgba[pixel * 4 + 3]!;
      await writeFile(path.join(root, 'constant.rgba'), constantRgba);
      run(ffmpeg, [
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
        path.join(root, 'constant.rgba'),
        '-an',
        '-c:v',
        'libvpx-vp9',
        '-pix_fmt',
        'yuva420p',
        '-lossless',
        '1',
        '-threads',
        '1',
        path.join(root, 'constant.webm'),
      ]);
      const constant = await prepareProductionVideoMotion(
        root,
        {
          animationId: 'alpha-production',
          motionId: 'constant',
          assetId: 'constant',
          sourcePath: 'constant.webm',
          canvas: { width: 80, height: 48 },
        },
        tool,
        run,
      );
      expect(constant.frameDurationsMs).toEqual([100, 100, 100, 100]);
      expect(constant.alphaWebp).toBeDefined();
      expect(
        (await sharp(await readFile(constant.alphaWebp!.sourcePath)).metadata()).pages,
      ).toBeUndefined();
      // A VFR alpha track must keep its original presentation times, not
      // repeat/retime the mask to match an assumed constant frame rate.
      run(ffmpeg, [
        '-y',
        '-c:v',
        'libvpx-vp9',
        '-i',
        path.join(root, 'alpha.webm'),
        '-vf',
        'select=not(eq(n\\,1))',
        '-fps_mode',
        'vfr',
        '-c:v',
        'libvpx-vp9',
        '-pix_fmt',
        'yuva420p',
        '-threads',
        '1',
        path.join(root, 'vfr.webm'),
      ]);
      const vfr = await traceTransparentVideo(
        root,
        {
          animationId: 'alpha-trace',
          motionId: 'vfr',
          assetId: 'vfr',
          sourcePath: 'vfr.webm',
          canvas: { width: 80, height: 48 },
        },
        tool,
        run,
      );
      expect(vfr.colorDurationsMs).toEqual([200, 100, 100]);
      expect(vfr.holds.map((hold) => hold.durationMs)).toEqual([200, 200]);
      if (existsSync(resolveNovelTeaCliPath())) {
        const nativeVfr = await traceTransparentVideo(
          root,
          {
            animationId: 'alpha-native-trace',
            motionId: 'vfr-native',
            assetId: 'vfr',
            sourcePath: 'vfr.webm',
            canvas: { width: 80, height: 48 },
          },
          tool,
          run,
          (request) =>
            invokeNovelTeaNativeOperation(
              'alpha-encode',
              request,
            ) as Promise<NativeAlphaEncodeResult>,
        );
        expect(nativeVfr.colorDurationsMs).toEqual([200, 100, 100]);
        expect(nativeVfr.holds).toEqual(vfr.holds);
        expect(nativeVfr.alphaWebp).toEqual(vfr.alphaWebp);
      }
      // Explicitly detect an FFmpeg decoder that returns an opaque pixel format
      // rather than accepting it as a successful auxiliary-alpha import.
      run(ffmpeg, [
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
        path.join(root, 'frames.rgba'),
        '-an',
        '-c:v',
        'libvpx-vp9',
        '-pix_fmt',
        'yuv420p',
        '-threads',
        '1',
        path.join(root, 'stripped.webm'),
      ]);
      const opaque = await prepareProductionVideoMotion(
        root,
        {
          animationId: 'alpha-production',
          motionId: 'stripped',
          assetId: 'stripped',
          sourcePath: 'stripped.webm',
          canvas: { width: 80, height: 48 },
        },
        tool,
        run,
      );
      expect(opaque.alphaWebp).toBeUndefined();
      await expect(
        traceTransparentVideo(
          root,
          {
            animationId: 'alpha-trace',
            motionId: 'stripped',
            assetId: 'stripped',
            sourcePath: 'stripped.webm',
            canvas: { width: 80, height: 48 },
          },
          tool,
          run,
        ),
      ).rejects.toThrow('discarded alpha');

      // A source revision during the color encode must not let alpha read
      // later, different source bytes and silently publish a mismatched pair.
      const changingPath = path.join(root, 'changing.webm');
      await writeFile(changingPath, await readFile(path.join(root, 'alpha.webm')));
      let replaced = false;
      const matched = await traceTransparentVideo(
        root,
        {
          animationId: 'alpha-trace',
          motionId: 'atomic',
          assetId: 'changing',
          sourcePath: 'changing.webm',
          canvas: { width: 80, height: 48 },
        },
        tool,
        (executable, args) => {
          const result = run(executable, args);
          if (!replaced && args.at(-1)?.endsWith('/opaque.webm')) {
            writeFileSync(changingPath, 'source was replaced during preparation');
            replaced = true;
          }
          return result;
        },
      );
      expect(replaced).toBe(true);
      expect(matched.holds.map((hold) => hold.durationMs)).toEqual([200, 200]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

const nativeSmoke = path.resolve(
  process.cwd(),
  '../build/linux-debug/tests/noveltea_native_video_texture_smoke',
);

it.skipIf(process.platform !== 'linux' || !hasWebpEncoder || !existsSync(nativeSmoke))(
  'feeds an actual lossless-WebP-decoded alpha mask and its matching production VP9 color through WorldVideoStream and bgfx R8',
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-alpha-gpu-trace-'));
    try {
      const width = 32,
        height = 16;
      const rgba = Buffer.alloc(width * height * 4 * 4);
      for (let frame = 0; frame < 4; frame += 1)
        for (let y = 0; y < height; y += 1)
          for (let x = 0; x < width; x += 1) {
            const offset = (frame * width * height + y * width + x) * 4;
            rgba[offset] = frame < 2 ? 255 : 0;
            rgba[offset + 1] = 0;
            rgba[offset + 2] = frame < 2 ? 0 : 255;
            rgba[offset + 3] = x < 8 ? (frame < 2 ? 0 : 255) : x < 16 ? 128 : frame < 2 ? 255 : 0;
          }
      await writeFile(path.join(root, 'frames.rgba'), rgba);
      run(ffmpeg, [
        '-y',
        '-f',
        'rawvideo',
        '-pixel_format',
        'rgba',
        '-video_size',
        '32x16',
        '-framerate',
        '20',
        '-i',
        path.join(root, 'frames.rgba'),
        '-an',
        '-c:v',
        'libvpx-vp9',
        '-pix_fmt',
        'yuva420p',
        '-lossless',
        '1',
        '-threads',
        '1',
        path.join(root, 'source.webm'),
      ]);
      const traced = await traceTransparentVideo(
        root,
        {
          animationId: 'gpu-trace',
          motionId: 'video',
          assetId: 'source',
          sourcePath: 'source.webm',
          canvas: { width, height },
        },
        { executable: ffmpeg, bundled: !process.env.NOVELTEA_FFMPEG },
        run,
      );
      expect(traced.colorDurationsMs).toEqual([50, 50, 50, 50]);
      expect(traced.holds).toEqual([
        { startMs: 0, durationMs: 100 },
        { startMs: 100, durationMs: 100 },
      ]);
      const output = path.join(root, 'gpu');
      await mkdir(output);
      await writeFile(path.join(output, 'opaque-vp9.webm'), await readFile(traced.colorVideoPath));
      const decoder = new WebpAlphaTraceSession(traced.alphaWebp, traced.holds, width, height);
      const firstMask = (await decoder.sample(0)).alpha;
      const secondMask = (await decoder.sample(125)).alpha;
      expect([firstMask[4], firstMask[12], firstMask[24]]).toEqual([0, 129, 255]);
      expect([secondMask[4], secondMask[12], secondMask[24]]).toEqual([255, 129, 0]);
      await writeFile(path.join(output, 'alpha-page0.r8'), firstMask);
      await writeFile(path.join(output, 'alpha-page1.r8'), secondMask);
      await writeFile(path.join(output, 'alpha.webp'), traced.alphaWebp);
      await writeFile(
        path.join(output, 'alpha-probe.json'),
        JSON.stringify({
          width,
          height,
          webp: 'alpha.webp',
          pages: ['alpha-page0.r8', 'alpha-page1.r8'],
          nativeOutputs: ['persistent-alpha-page0.r8', 'persistent-alpha-page1.r8'],
          holds: traced.holds,
          seeks: [0, 99, 100, 199, 50, 175, 0, 100, 199],
        }),
      );
      // The independent libwebp decoder probe is optional on CI machines
      // without test-only libwebpdemux/Python. The native GPU trace itself is
      // not conditional on that external library.
      const persistentAvailable =
        spawnSync('python3', [
          '-c',
          'import ctypes.util; assert ctypes.util.find_library("webpdemux")',
        ]).status === 0;
      if (persistentAvailable) {
        const persistent = spawnSync(
          'python3',
          [
            path.resolve(process.cwd(), '../tests/media/webp_alpha_persistent_probe.py'),
            path.join(output, 'alpha-probe.json'),
          ],
          { encoding: 'utf8', timeout: 30_000 },
        );
        if (persistent.status !== 0)
          throw new Error(
            `Persistent WebP decoder probe failed (${persistent.status}): ${persistent.stderr || persistent.error?.message}\n${persistent.stdout}`,
          );
        expect(JSON.parse(persistent.stdout)).toMatchObject({
          decoder: 'libwebp-animated-persistent',
          pages: 2,
          seeks: 9,
        });
        expect(await readFile(path.join(output, 'persistent-alpha-page0.r8'))).toEqual(firstMask);
        expect(await readFile(path.join(output, 'persistent-alpha-page1.r8'))).toEqual(secondMask);
      } else {
        console.info('Optional persistent libwebp probe unavailable; GPU tracer still runs.');
      }
      const native = spawnSync('xvfb-run', ['-a', nativeSmoke, output], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      if (native.status !== 0)
        throw new Error(
          `Native GPU trace failed (${native.status}): ${native.stderr || native.error?.message}\n${native.stdout}`,
        );
      expect(native.stdout).toContain('NATIVE_VIDEO_WEBP_ALPHA_TRANSPORT_TRACE_PASSED');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

it.skipIf(process.env.NOVELTEA_ALPHA_STRESS !== '1')(
  'measures 1080p and 4K lossless WebP decode/seek and one-mask CPU residency',
  async () => {
    for (const [width, height] of [
      [1920, 1080],
      [3840, 2160],
    ]) {
      const pixels = width! * height!;
      const rgba = Buffer.alloc(pixels * 4 * 2);
      for (let page = 0; page < 2; page += 1)
        for (let pixel = 0; pixel < pixels; pixel += 1) {
          const offset = (page * pixels + pixel) * 4;
          rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = 255;
          rgba[offset + 3] = page === 0 ? (pixel % width! < width! / 2 ? 0 : 128) : 255;
        }
      const before = performance.now();
      const webp = await sharp(rgba, {
        raw: { width: width!, height: height! * 2, channels: 4, pageHeight: height! },
      })
        .webp({ lossless: true, effort: 4, delay: [200, 300], loop: 0 })
        .toBuffer();
      const encodedMs = performance.now() - before;
      const decoder = new WebpAlphaTraceSession(
        webp,
        [
          { startMs: 0, durationMs: 200 },
          { startMs: 200, durationMs: 300 },
        ],
        width!,
        height!,
      );
      const decodeStart = performance.now();
      const first = await decoder.sample(150);
      const second = await decoder.sample(250);
      const third = await decoder.sample(499);
      const decodedMs = performance.now() - decodeStart;
      expect(first.alpha.byteLength).toBe(pixels);
      expect(second.alpha.byteLength).toBe(pixels);
      expect(first.alpha[0]).toBe(0);
      expect(first.alpha[width! - 1]).toBe(128);
      expect(second.alpha[0]).toBe(255);
      expect(second.alpha).toBe(third.alpha);
      console.info(
        `ALPHA_STRESS ${width}x${height} encodedBytes=${webp.length} ` +
          `maskBytes=${pixels} encodeMs=${encodedMs.toFixed(1)} ` +
          `decodeTwoPagesMs=${decodedMs.toFixed(1)} rssMiB=${(process.memoryUsage().rss / 1048576).toFixed(1)}`,
      );
    }
  },
  120_000,
);
