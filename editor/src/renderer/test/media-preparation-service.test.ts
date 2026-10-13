import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vite-plus/test';
import {
  resolveMediaTool,
  inspectMediaTool,
  runMediaPreparation,
} from '../../main/services/media-preparation-service';
import {
  prepareOpaqueVideoMotion,
  probeOpaqueVideoTimeline,
  runVideoMediaToolProcess,
} from '../../main/services/opaque-video-preparation-service';
import { opaqueVideoPreparationResultSchema } from '../../shared/prepared-media';
import { targetFpsDuplicatesSource } from '../../shared/video-fps-duplicates';
import { videoCanvasNotice } from '../../shared/native-video-playback-limits';
import { prepareProjectOpaqueVideo } from '../../main/services/project-video-preparation-service';
import { ActiveProjectSessionService } from '../../main/services/active-project-session-service';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

const version = 'ffmpeg version 9.0.1 Copyright FFmpeg';
const configuration =
  '--disable-gpl --disable-nonfree --disable-version3 --enable-libaom --enable-libvpx --enable-libzimg --disable-network';
const run = (_executable: string, args: readonly string[]) => ({
  stdout: args.includes('-version')
    ? `${version}\nconfiguration: ${configuration}`
    : args.includes('-encoders')
      ? ' V..... libaom-av1\n V..... libvpx-vp9'
      : args.includes('-protocols')
        ? 'Input:\nfile\npipe\nOutput:\nfile\npipe'
        : 'prepared',
  stderr: '',
});

it('detects rational-FPS duplication using actual irregular VFR presentation times', () => {
  expect(
    targetFpsDuplicatesSource([0, 100, 200, 300], 400, { numerator: 10, denominator: 1 }),
  ).toBe(false);
  expect(
    targetFpsDuplicatesSource([0, 100, 200, 300], 400, { numerator: 24, denominator: 1 }),
  ).toBe(true);
  expect(targetFpsDuplicatesSource([0, 25, 50, 950], 1000, { numerator: 4, denominator: 1 })).toBe(
    true,
  );
  expect(targetFpsDuplicatesSource([0, 100, 200, 300], 400, { numerator: 5, denominator: 1 })).toBe(
    false,
  );
  expect(
    targetFpsDuplicatesSource([0, 100, 200, 300], 400, { numerator: 30000, denominator: 1001 }),
  ).toBe(true);
});

it('classifies native video limits separately from potential hardware fallback', () => {
  expect(videoCanvasNotice({ width: 64, height: 64 })).toBe('hardware-may-fallback');
  expect(videoCanvasNotice({ width: 127, height: 128 })).toBe('hardware-may-fallback');
  expect(videoCanvasNotice({ width: 129, height: 128 })).toBe('hardware-may-fallback');
  expect(videoCanvasNotice({ width: 128, height: 128 })).toBeNull();
  expect(videoCanvasNotice({ width: 8192, height: 8192 })).toBeNull();
  expect(videoCanvasNotice({ width: 8193, height: 512 })).toBe('native-limit');
  expect(videoCanvasNotice({ width: 9000, height: 64 })).toBe('native-limit');
});

it('rejects native-incompatible video canvases before invoking the encoder', async () => {
  await expect(
    prepareOpaqueVideoMotion(
      '/nonexistent',
      {
        animationId: 'a',
        motionId: 'v',
        assetId: 'source',
        sourcePath: 'missing.webm',
        canvas: { width: 8193, height: 512 },
      },
      { executable: '/nonexistent/ffmpeg', bundled: true },
      run,
    ),
  ).rejects.toThrow('Native video canvas cannot exceed 8192 pixels per axis.');
});

it('captures multi-megabyte video timeline output without the Node spawnSync default limit', () => {
  const output = runVideoMediaToolProcess(process.execPath, [
    '-e',
    'process.stdout.write("x".repeat(2 * 1024 * 1024))',
  ]);
  expect(output.stdout).toHaveLength(2 * 1024 * 1024);
});

const pinnedFfmpeg = path.resolve(process.cwd(), '../build/cli/linux/tools/ffmpeg/bin/ffmpeg');
it.skipIf(!existsSync(pinnedFfmpeg))(
  'prepares real VFR media with pinned FFmpeg 9.0.1 and keeps native-compatible WebM timestamps',
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-pinned-video-'));
    const binaryRunner = (executable: string, args: readonly string[]) => {
      const result = spawnSync(executable, [...args], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      if (result.status !== 0)
        throw new Error(
          `FFmpeg ${String(result.status)}: ${result.stderr || result.error?.message}`,
        );
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    };
    const tool = { executable: pinnedFfmpeg, bundled: true };
    try {
      const original = path.resolve(process.cwd(), '../tests/web/fixtures/opaque-colors.webm');
      const input = path.join(root, 'source.webm');
      // Remove frames without resetting PTS to construct real VFR intervals.
      binaryRunner(pinnedFfmpeg, [
        '-nostdin',
        '-hide_banner',
        '-y',
        '-i',
        original,
        '-map',
        '0:v:0',
        '-vf',
        'select=not(mod(n\\,7))',
        '-fps_mode',
        'vfr',
        '-c:v',
        'libvpx-vp9',
        '-lossless',
        '1',
        '-threads',
        '1',
        input,
      ]);
      const source = await probeOpaqueVideoTimeline(
        root,
        {
          assetId: 'source',
          sourcePath: 'source.webm',
        },
        tool,
        binaryRunner,
      );
      expect(source.sampleTimesMs.length).toBeGreaterThan(3);
      expect(source.sampleTimesMs.length).toBeLessThan(30);
      const outcomes = [];
      for (const frameSampling of [
        { mode: 'source' as const },
        { mode: 'target-fps' as const, fps: { numerator: 30000, denominator: 1001 } },
        { mode: 'retain-percent' as const, percent: 15 },
      ]) {
        const prepared = await prepareOpaqueVideoMotion(
          root,
          {
            animationId: 'a',
            motionId: 'v',
            assetId: 'source',
            sourcePath: 'source.webm',
            canvas: { width: 96, height: 64 },
            frameSampling,
          },
          tool,
          binaryRunner,
        );
        const output = binaryRunner(pinnedFfmpeg, [
          '-nostdin',
          '-hide_banner',
          '-i',
          prepared.browserVideo.sourcePath,
          '-map',
          '0:v:0',
          '-vf',
          'showinfo',
          '-f',
          'null',
          '-',
        ]);
        const timestamps = [...output.stderr.matchAll(/\bpts_time:\s*([\d.]+)/gu)].map(
          (match) => Number(match[1]) * 1000,
        );
        expect(timestamps).toHaveLength(prepared.frameDurationsMs.length);
        expect(timestamps[0]).toBe(0); // Required by native VP9 admission.
        expect(
          timestamps.every((value, index) => index === 0 || value > timestamps[index - 1]!),
        ).toBe(true);
        expect(prepared.frameDurationsMs.reduce((sum, value) => sum + value, 0)).toBe(
          source.endpointMs,
        );
        outcomes.push({ sampling: frameSampling.mode, times: timestamps, prepared });
      }
      expect(outcomes[0]!.times).toHaveLength(source.sampleTimesMs.length);
      const repeated = await prepareOpaqueVideoMotion(
        root,
        {
          animationId: 'a',
          motionId: 'v',
          assetId: 'source',
          sourcePath: 'source.webm',
          canvas: { width: 96, height: 64 },
          frameSampling: { mode: 'source' },
        },
        tool,
        binaryRunner,
      );
      expect(repeated.browserVideo.contentHash).toBe(
        outcomes[0]!.prepared.browserVideo.contentHash,
      );
      expect(outcomes[1]!.times.length).toBeGreaterThan(source.sampleTimesMs.length);
      expect(outcomes[2]!.times).toHaveLength(1); // 15% of the source preserves a single hold.
      expect(
        targetFpsDuplicatesSource(source.sampleTimesMs, source.endpointMs, {
          numerator: 30000,
          denominator: 1001,
        }),
      ).toBe(true);
      const clipped = await prepareOpaqueVideoMotion(
        root,
        {
          animationId: 'a',
          motionId: 'range',
          assetId: 'source',
          sourcePath: 'source.webm',
          canvas: { width: 96, height: 64 },
          sourceRange: { startMs: 200, endMs: 1200 },
        },
        tool,
        binaryRunner,
      );
      expect(clipped.frameDurationsMs.reduce((sum, value) => sum + value, 0)).toBe(1000);
      const firstAfterStart = source.sampleTimesMs.find((timestamp) => timestamp > 200)!;
      expect(clipped.frameDurationsMs[0]).toBeCloseTo(firstAfterStart - 200, 0);
      // A CFR mapping of a clipped source must not repeat the final selected
      // frame until the original input stream EOF (past the authored endpoint).
      const clippedTarget = await prepareOpaqueVideoMotion(
        root,
        {
          animationId: 'a',
          motionId: 'range-target-fps',
          assetId: 'source',
          sourcePath: 'source.webm',
          canvas: { width: 96, height: 64 },
          sourceRange: { startMs: 200, endMs: 1200 },
          frameSampling: { mode: 'target-fps', fps: { numerator: 30000, denominator: 1001 } },
        },
        tool,
        binaryRunner,
      );
      expect(clippedTarget.frameDurationsMs).toHaveLength(30);
      expect(clippedTarget.frameDurationsMs.reduce((sum, duration) => sum + duration, 0)).toBe(
        1000,
      );
      // A tagged SD matrix requires actual gamut/transfer conversion, not
      // merely tagging the VP9 stream with BT.709 output metadata.
      binaryRunner(pinnedFfmpeg, [
        '-nostdin',
        '-hide_banner',
        '-y',
        '-i',
        original,
        '-map',
        '0:v:0',
        '-vf',
        'scale=out_color_matrix=bt470bg',
        '-c:v',
        'libvpx-vp9',
        '-color_primaries',
        'bt470bg',
        '-color_trc',
        'bt470bg',
        '-colorspace',
        'bt470bg',
        '-threads',
        '1',
        path.join(root, 'sd.webm'),
      ]);
      const sd = await prepareOpaqueVideoMotion(
        root,
        {
          animationId: 'a',
          motionId: 'sd',
          assetId: 'sd',
          sourcePath: 'sd.webm',
          canvas: { width: 96, height: 64 },
        },
        tool,
        binaryRunner,
      );
      const sdOutput = binaryRunner(pinnedFfmpeg, [
        '-nostdin',
        '-hide_banner',
        '-i',
        sd.browserVideo.sourcePath,
        '-vf',
        'showinfo',
        '-f',
        'null',
        '-',
      ]);
      expect(sdOutput.stderr).toContain('color_space:bt709');
      expect(sd.reducedColorPrecision).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);

it.skipIf(!existsSync(pinnedFfmpeg))(
  'tone-maps real PQ and HLG BT.2020 input before encoding SDR VP9',
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-hdr-video-'));
    const tool = { executable: pinnedFfmpeg, bundled: true };
    const preparedFiltergraphs: string[] = [];
    const binaryRunner = (executable: string, args: readonly string[]) => {
      if (args.includes('-progress'))
        preparedFiltergraphs.push(args[args.indexOf('-vf') + 1] ?? '');
      const result = spawnSync(executable, [...args], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      if (result.status !== 0)
        throw new Error(
          `FFmpeg ${String(result.status)}: ${result.stderr || result.error?.message}`,
        );
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    };
    try {
      // A 10-bit HDR-tagged source with a non-black reference level. Convert
      // its actual decoded color samples, not just its stream metadata.
      const frame = Buffer.alloc(64 * 64 * 4);
      for (let offset = 0; offset < frame.length; offset += 2)
        frame.writeUInt16LE(offset < 64 * 64 * 2 ? 360 : 512, offset);
      await writeFile(path.join(root, 'source.yuv'), frame);
      for (const [transfer, primaries] of [
        ['smpte2084', 'bt2020'],
        ['arib-std-b67', 'bt2020'],
      ] as const) {
        const sourcePath = `${transfer}-${primaries}.mov`;
        binaryRunner(pinnedFfmpeg, [
          '-nostdin',
          '-hide_banner',
          '-y',
          '-f',
          'rawvideo',
          '-pixel_format',
          'yuv422p10le',
          '-video_size',
          '64x64',
          '-framerate',
          '1',
          '-i',
          path.join(root, 'source.yuv'),
          '-an',
          '-vf',
          `setparams=color_primaries=${primaries}:color_trc=${transfer}:colorspace=bt2020nc:range=tv`,
          '-c:v',
          'prores_ks',
          '-profile:v',
          '3',
          '-threads',
          '1',
          '-pix_fmt',
          'yuv422p10le',
          '-color_primaries',
          primaries,
          '-color_trc',
          transfer,
          '-colorspace',
          'bt2020nc',
          '-color_range',
          'tv',
          '-movflags',
          '+write_colr',
          path.join(root, sourcePath),
        ]);
        const sourceMetadata = binaryRunner(pinnedFfmpeg, [
          '-nostdin',
          '-hide_banner',
          '-i',
          path.join(root, sourcePath),
          '-vf',
          'showinfo',
          '-f',
          'null',
          '-',
        ]);
        expect(sourceMetadata.stderr).toContain(transfer);
        const request = {
          animationId: 'hdr',
          motionId: sourcePath,
          assetId: sourcePath,
          sourcePath,
          canvas: { width: 64, height: 64 },
        };
        const prepared = await prepareOpaqueVideoMotion(root, request, tool, binaryRunner);
        expect(preparedFiltergraphs.at(-1), sourceMetadata.stderr).toContain(
          'zscale=t=linear:m=gbr:npl=100',
        );
        expect(prepared.reducedColorPrecision).toBe(true);
        expect(prepared.frameDurationsMs).toEqual([1000]);
        const decoded = binaryRunner(pinnedFfmpeg, [
          '-nostdin',
          '-hide_banner',
          '-i',
          prepared.browserVideo.sourcePath,
          '-vf',
          'showinfo',
          '-f',
          'null',
          '-',
        ]);
        expect(decoded.stderr).toContain('fmt:yuv420p');
        expect(decoded.stderr).toContain('color_space:bt709');
      }
      expect(preparedFiltergraphs).toHaveLength(2);
      for (const filters of preparedFiltergraphs) {
        expect(filters).toContain('zscale=t=linear:m=gbr:npl=100');
        expect(filters).toContain('format=gbrpf32le,tonemap=tonemap=hable:desat=0');
        expect(filters).toContain('zscale=p=bt709:t=bt709:m=bt709:r=tv');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);

describe('private media preparation tool', () => {
  it('uses HDR stream metadata when decoded frame tags are unavailable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-video-stream-tags-'));
    try {
      await writeFile(path.join(root, 'source.mov'), 'video');
      const probe =
        'Stream #0:0: Video: hevc (Main 10), yuv420p10le(tv, bt2020nc/bt2020/smpte2084)\n' +
        '[Parsed_showinfo_0] n: 0 pts_time:0 duration_time:1 fmt:yuv420p10le ' +
        'color_space:unknown color_primaries:unknown color_trc:unknown\n';
      const output =
        '[Parsed_showinfo_0] n: 0 pts_time:0 duration_time:1 fmt:yuv420p ' +
        'color_space:bt709 color_primaries:unknown color_trc:unknown\n';
      let encodedFilters = '';
      const prepared = await prepareOpaqueVideoMotion(
        root,
        {
          animationId: 'hdr',
          motionId: 'tagged',
          assetId: 'source',
          sourcePath: 'source.mov',
          canvas: { width: 16, height: 16 },
        },
        { executable: '/test/ffmpeg', bundled: false },
        (exe, args) => {
          if (
            args.includes('-version') ||
            args.includes('-encoders') ||
            args.includes('-protocols')
          )
            return run(exe, args);
          if (args.at(-1) === '-')
            return {
              stdout: '',
              stderr: args[args.indexOf('-i') + 1]?.endsWith('opaque.webm') ? output : probe,
            };
          encodedFilters = args[args.indexOf('-vf') + 1] ?? '';
          writeFileSync(args.at(-1)!, 'VP9 WebM');
          return { stdout: 'frame=1\nprogress=end\n', stderr: output };
        },
      );
      expect(prepared.reducedColorPrecision).toBe(true);
      expect(prepared.frameDurationsMs).toEqual([1000]);
      expect(encodedFilters).toContain('zscale=t=linear:m=gbr:npl=100');
      expect(encodedFilters).toContain('tonemap=tonemap=hable:desat=0');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects HDR sources whose matrix and primaries do not describe a supported conversion', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-video-invalid-hdr-'));
    try {
      await writeFile(path.join(root, 'source.mov'), 'video');
      for (const metadata of [
        'color_space:bt2020nc color_primaries:unknown color_trc:smpte2084',
        'color_space:bt709 color_primaries:bt2020 color_trc:arib-std-b67',
      ]) {
        await expect(
          prepareOpaqueVideoMotion(
            root,
            {
              animationId: 'hdr',
              motionId: metadata,
              assetId: 'source',
              sourcePath: 'source.mov',
              canvas: { width: 16, height: 16 },
            },
            { executable: '/unused/ffmpeg', bundled: false },
            (exe, args) => {
              if (
                args.includes('-version') ||
                args.includes('-encoders') ||
                args.includes('-protocols')
              )
                return run(exe, args);
              if (args.at(-1) === '-')
                return {
                  stdout: '',
                  stderr: `[Parsed_showinfo_0] n: 0 pts_time:0 duration_time:1 fmt:yuv420p10le ${metadata}\n`,
                };
              throw new Error('Unsupported HDR must not reach the encoder.');
            },
          ),
        ).rejects.toThrow('HDR video requires BT.2020');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['linux', 'win32', 'darwin'] as const)(
    'resolves beside the CLI bin directory after relocation on %s',
    (platform) => {
      const executable = path.join(
        '/relocated installation',
        'resources',
        'bin',
        platform === 'win32' ? 'noveltea.exe' : 'noveltea',
      );
      expect(resolveMediaTool({ cliExecutable: executable, platform })).toEqual({
        executable: path.join(
          '/relocated installation',
          'resources',
          'tools',
          'ffmpeg',
          'bin',
          platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
        ),
        bundled: true,
      });
    },
  );

  it('resolves the flat standalone CLI distribution without selecting a PATH executable', () => {
    expect(resolveMediaTool({ cliExecutable: '/relocated cli/noveltea' }).executable).toBe(
      '/relocated cli/tools/ffmpeg/bin/ffmpeg',
    );
  });

  it('accepts only an explicit absolute external override, never ambient PATH', () => {
    expect(() =>
      resolveMediaTool({ cliExecutable: '/install/bin/noveltea', override: 'ffmpeg' }),
    ).toThrow('absolute');
    expect(
      resolveMediaTool({
        cliExecutable: '/install/bin/noveltea',
        override: '/distro tools/ffmpeg',
      }),
    ).toEqual({ executable: '/distro tools/ffmpeg', bundled: false });
  });

  it('checks pinned identity and preparation capabilities before invoking a job', () => {
    const tool = { executable: '/install/tools/ffmpeg/bin/ffmpeg', bundled: true };
    expect(inspectMediaTool(tool, run)).toMatchObject({ version: '9.0.1', bundled: true });
    expect(
      runMediaPreparation(tool, ['-i', '/source with spaces.mov', '/output.webm'], run).stdout,
    ).toBe('prepared');
    expect(() =>
      inspectMediaTool(tool, () => ({ stdout: 'ffmpeg version 7.1', stderr: '' })),
    ).toThrow('9.0.1');
    expect(() =>
      inspectMediaTool(tool, (_exe, args) =>
        args.includes('-encoders') ? { stdout: '', stderr: '' } : run(_exe, args),
      ),
    ).toThrow('libaom-av1');
    expect(() =>
      inspectMediaTool(tool, (_exe, args) =>
        args.includes('-protocols') ? { stdout: 'http', stderr: '' } : run(_exe, args),
      ),
    ).toThrow('file');
    expect(() =>
      inspectMediaTool(tool, (_exe, args) =>
        args.includes('-version') ? { stdout: version, stderr: '' } : run(_exe, args),
      ),
    ).toThrow('configuration');
    expect(
      inspectMediaTool({ ...tool, bundled: false }, (_exe, args) =>
        args.includes('-version') ? { stdout: 'ffmpeg version 10.0', stderr: '' } : run(_exe, args),
      ),
    ).toMatchObject({ version: '10.0', release: null });
  });

  it('admits video by active Asset identity and decodes the admitted snapshot', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-video-session-'));
    const sessions = new ActiveProjectSessionService();
    try {
      await writeFile(path.join(root, 'project.json'), '{}');
      await mkdir(path.join(root, 'assets/video'), { recursive: true });
      const bytes = Buffer.from('admitted video');
      await writeFile(path.join(root, 'assets/video/source.mov'), bytes);
      const project = createAuthoringProject();
      project.assets.source = {
        id: 'source',
        label: 'Source',
        data: {
          kind: 'video',
          source: { type: 'project-file', path: 'assets/video/source.mov' },
          aliases: [],
          imageMetadata: null,
        },
      };
      const session = await sessions.activateProjectFile(
        path.join(root, 'project.json'),
        undefined,
        project,
      );
      const request = {
        animationId: 'a',
        motionId: 'idle',
        assetId: 'source',
        sourcePath: 'assets/video/source.mov',
        canvas: { width: 16, height: 16 },
      };
      const tool = { executable: '/unused/ffmpeg', bundled: false };
      await expect(
        prepareProjectOpaqueVideo(sessions, session, { ...request, assetId: 'unknown' }, tool, run),
      ).rejects.toThrow();
      await expect(
        prepareProjectOpaqueVideo(
          sessions,
          session,
          { ...request, sourcePath: 'assets/video/private.mov' },
          tool,
          run,
        ),
      ).rejects.toThrow('match');
      const result = await prepareProjectOpaqueVideo(
        sessions,
        session,
        request,
        tool,
        (_exe, args) => {
          if (args.at(-1) === '-')
            return {
              stdout: '',
              stderr: '[Parsed_showinfo_0] n: 0 pts_time:0 duration_time:0.0333333\n',
            };
          if (args.at(-1)?.endsWith('.webm')) {
            expect(readFileSync(args[args.indexOf('-i') + 1]!)).toEqual(bytes);
            writeFileSync(args.at(-1)!, 'browser video');
            return {
              stdout: 'frame=1\nprogress=end\n',
              stderr: '[Parsed_showinfo_0] n: 0 pts_time:0 duration_time:0.0333333\n',
            };
          }
          return run(_exe, args);
        },
      );
      expect(result.frameDurationsMs).toEqual([33]);
      sessions.closeActiveProject();
      await expect(
        prepareProjectOpaqueVideo(sessions, session, request, tool, run),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects lexical and symlink source escapes before invoking FFmpeg', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-video-contained-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'noveltea-video-outside-'));
    try {
      await writeFile(path.join(outside, 'private.mov'), 'private source');
      await symlink(path.join(outside, 'private.mov'), path.join(root, 'source.mov'));
      for (const sourcePath of [
        path.relative(root, path.join(outside, 'private.mov')),
        'source.mov',
      ]) {
        let invoked = false;
        await expect(
          prepareOpaqueVideoMotion(
            root,
            {
              animationId: 'a',
              motionId: 'idle',
              assetId: 'source',
              sourcePath,
              canvas: { width: 16, height: 16 },
            },
            { executable: '/unused/ffmpeg', bundled: false },
            () => {
              invoked = true;
              throw new Error('Unexpected invocation');
            },
          ),
        ).rejects.toThrow(/contained|relative/u);
        expect(invoked).toBe(false);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('prepares deterministic opaque Animation WebM without PNGs and strips embedded audio', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-video-preparation-'));
    try {
      await writeFile(path.join(root, 'source.mov'), Buffer.from('creator source bytes'));
      const calls: string[][] = [];
      const runner = (_executable: string, args: readonly string[]) => {
        calls.push([...args]);
        if (args.includes('-version')) return run(_executable, args);
        if (args.includes('-encoders')) return run(_executable, args);
        if (args.includes('-protocols')) return run(_executable, args);
        const video = args.at(-1)!;
        const timing =
          '[Parsed_showinfo_0] n: 0 pts_time:0 duration_time:0.25\n' +
          '[Parsed_showinfo_0] n: 1 pts_time:0.25 duration_time:0.75\n';
        if (video === '-')
          return { stdout: '', stderr: 'Stream #0:1[0x2](und): Audio: opus\n' + timing };
        expect(video).toMatch(/opaque\.webm$/u);
        writeFileSync(video, Buffer.from('browser video'));
        return { stdout: 'frame=1\nprogress=continue\nframe=2\nprogress=end\n', stderr: timing };
      };
      const result = await prepareOpaqueVideoMotion(
        root,
        {
          animationId: 'portrait',
          motionId: 'idle',
          assetId: 'source',
          sourcePath: 'source.mov',
          canvas: { width: 320, height: 180 },
          sourceRange: { startMs: 0, endMs: 1000 },
        },
        { executable: '/install/tools/ffmpeg/bin/ffmpeg', bundled: true },
        runner,
      );

      expect(result.hadAudio).toBe(true);
      expect(result).toMatchObject({
        browserVideo: {
          sourcePath: expect.stringMatching(/opaque\.webm$/u),
          projectRelativePath: expect.stringMatching(/opaque\.webm$/u),
          contentHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
          byteSize: expect.any(Number),
          width: 320,
          height: 180,
        },
      });
      expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/u);
      expect(result.frameDurationsMs).toEqual([250, 750]);
      expect(result.frameDurationsMs.reduce((total, duration) => total + duration, 0)).toBe(1000);
      const job = calls.find((args) => args.at(-1)?.endsWith('.webm'));
      expect(job).toEqual(expect.arrayContaining(['-map', '0:v:0', '-an']));
      expect(job?.join(' ')).toContain("select='between(n");
      expect(job?.join(' ')).not.toContain('fps=30');
      expect(job?.join(' ')).toContain('-fps_mode vfr');
      expect(job?.join(' ')).toContain('scale=320:180');
      expect(job).toContain('pipe:1');
      expect(calls.filter((args) => args.at(-1)?.endsWith('.webm'))).toHaveLength(1);
      expect(opaqueVideoPreparationResultSchema.parse(result)).toEqual(result);

      const staleFrame = path.join(
        path.dirname(result.browserVideo.sourcePath),
        'frame-999999.png',
      );
      writeFileSync(staleFrame, Buffer.from('stale frame'));
      const repeated = await prepareOpaqueVideoMotion(
        root,
        {
          animationId: 'portrait',
          motionId: 'idle',
          assetId: 'source',
          sourcePath: 'source.mov',
          canvas: { width: 320, height: 180 },
          sourceRange: { startMs: 0, endMs: 1000 },
        },
        { executable: '/install/tools/ffmpeg/bin/ffmpeg', bundled: true },
        runner,
      );
      expect(repeated).toEqual(result);
      expect(existsSync(staleFrame)).toBe(false);
      expect(
        existsSync(path.join(path.dirname(result.browserVideo.sourcePath), 'frame-000000.png')),
      ).toBe(false);

      // Source updates and authored sampling changes must not reuse the same
      // prepared media. Unrelated locale changes do not affect this identity.
      const retainedOriginal = readFileSync(result.browserVideo.sourcePath);
      const retainedSource = readFileSync(path.join(root, 'source.mov'));
      await writeFile(path.join(root, 'source.mov'), 'changed creator source bytes');
      const changed = await prepareOpaqueVideoMotion(
        root,
        {
          animationId: 'portrait',
          motionId: 'idle',
          assetId: 'source',
          sourcePath: 'source.mov',
          canvas: { width: 320, height: 180 },
          sourceRange: { startMs: 0, endMs: 1000 },
        },
        { executable: '/install/tools/ffmpeg/bin/ffmpeg', bundled: true },
        runner,
      );
      expect(changed.contentHash).not.toBe(result.contentHash);
      expect(changed.browserVideo.sourcePath).not.toBe(result.browserVideo.sourcePath);
      expect(readFileSync(result.browserVideo.sourcePath)).toEqual(retainedOriginal);
      await writeFile(path.join(root, 'source.mov'), retainedSource);
      const differentlySampled = await prepareOpaqueVideoMotion(
        root,
        {
          animationId: 'portrait',
          motionId: 'idle',
          assetId: 'source',
          sourcePath: 'source.mov',
          canvas: { width: 320, height: 180 },
          sourceRange: { startMs: 0, endMs: 1000 },
          frameSampling: { mode: 'retain-percent', percent: 50 },
        },
        { executable: '/install/tools/ffmpeg/bin/ffmpeg', bundled: true },
        runner,
      );
      expect(differentlySampled.contentHash).not.toBe(result.contentHash);
      expect(differentlySampled.contentHash).not.toBe(changed.contentHash);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves VFR presentation timing and endpoints across source, rational FPS and retain modes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-video-vfr-'));
    try {
      await writeFile(path.join(root, 'source.mov'), 'source video bytes');
      const sourceTimes = [0, 80, 220, 500, 900];
      const log = (times: number[]) =>
        times
          .map(
            (time, index) =>
              `[Parsed_showinfo_0] n: ${index} pts_time:${time / 1000} duration_time:0.05`,
          )
          .join('\n');
      const source = log(sourceTimes);
      const cases = [
        {
          sampling: { mode: 'source' as const },
          outputTimes: sourceTimes,
          filter: "setpts=PTS-STARTPTS,select='between(n",
          durations: [80, 140, 280, 400, 100],
        },
        {
          sampling: {
            mode: 'target-fps' as const,
            fps: { numerator: 30000, denominator: 1001 },
          },
          outputTimes: Array.from({ length: 30 }, (_, index) => (index * 1001) / 30),
          filter: 'fps=fps=30000/1001:round=near',
          durations: null,
        },
        {
          sampling: { mode: 'retain-percent' as const, percent: 40 },
          outputTimes: [0, 900],
          filter: "select='eq(n",
          durations: [900, 100],
        },
      ];
      const hashes = new Set<string>();
      for (const entry of cases) {
        let encodedArgs: readonly string[] = [];
        const result = await prepareOpaqueVideoMotion(
          root,
          {
            animationId: 'video',
            motionId: 'idle',
            assetId: 'source',
            sourcePath: 'source.mov',
            canvas: { width: 32, height: 16 },
            sourceRange: { startMs: 0, endMs: 1000 },
            frameSampling: entry.sampling,
          },
          { executable: '/test/ffmpeg', bundled: false },
          (exe, args) => {
            if (
              args.includes('-version') ||
              args.includes('-encoders') ||
              args.includes('-protocols')
            )
              return run(exe, args);
            if (args.at(-1) === '-') {
              const input = args[args.indexOf('-i') + 1] ?? '';
              return {
                stdout: '',
                stderr: input.endsWith('.webm') ? log(entry.outputTimes) : source,
              };
            }
            encodedArgs = args;
            writeFileSync(args.at(-1)!, 'VP9 WebM');
            return {
              stdout: `frame=${entry.outputTimes.length}\nprogress=end\n`,
              stderr: log(entry.outputTimes),
            };
          },
        );
        hashes.add(result.contentHash);
        expect(encodedArgs.join(' ')).toContain(entry.filter);
        expect(result.frameDurationsMs.reduce((sum, ms) => sum + ms, 0)).toBe(1000);
        if (entry.durations) expect(result.frameDurationsMs).toEqual(entry.durations);
        expect(opaqueVideoPreparationResultSchema.parse(result)).toEqual(result);
      }
      expect(hashes.size).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
