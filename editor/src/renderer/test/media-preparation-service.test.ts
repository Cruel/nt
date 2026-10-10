import path from 'node:path';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vite-plus/test';
import {
  resolveMediaTool,
  inspectMediaTool,
  runMediaPreparation,
} from '../../main/services/media-preparation-service';
import { prepareOpaqueVideoMotion } from '../../main/services/opaque-video-preparation-service';
import { opaqueVideoPreparationResultSchema } from '../../shared/prepared-media';
import { prepareProjectOpaqueVideo } from '../../main/services/project-video-preparation-service';
import { ActiveProjectSessionService } from '../../main/services/active-project-session-service';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

const version = 'ffmpeg version 9.0.1 Copyright FFmpeg';
const configuration =
  '--disable-gpl --disable-nonfree --disable-version3 --enable-libaom --enable-libvpx --disable-network';
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

describe('private media preparation tool', () => {
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
          if (args.at(-1)?.endsWith('.webm')) {
            expect(readFileSync(args[args.indexOf('-i') + 1]!)).toEqual(bytes);
            writeFileSync(args.at(-1)!, 'browser video');
            return { stdout: 'frame=1\nprogress=end\n', stderr: '' };
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
        expect(video).toMatch(/opaque\.webm$/u);
        writeFileSync(video, Buffer.from('browser video'));
        return {
          stdout: 'frame=1\nprogress=continue\nframe=2\nprogress=end\n',
          stderr: 'Stream #0:0[0x1](und): Video: vp9\nStream #0:1[0x2](und): Audio: opus',
        };
      };
      const result = await prepareOpaqueVideoMotion(
        root,
        {
          animationId: 'portrait',
          motionId: 'idle',
          assetId: 'source',
          sourcePath: 'source.mov',
          canvas: { width: 320, height: 180 },
          sourceRange: { startMs: 250, endMs: 1250 },
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
      expect(result.frameDurationsMs).toEqual([33, 967]);
      expect(result.frameDurationsMs.reduce((total, duration) => total + duration, 0)).toBe(1000);
      const job = calls.find((args) => args.includes('-an') && args.includes('-vf'));
      expect(job).toEqual(
        expect.arrayContaining(['-map', '0:v:0', '-an', '-ss', '0.25', '-t', '1']),
      );
      expect(job?.join(' ')).toContain('fps=30');
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
          sourceRange: { startMs: 250, endMs: 1250 },
        },
        { executable: '/install/tools/ffmpeg/bin/ffmpeg', bundled: true },
        runner,
      );
      expect(repeated).toEqual(result);
      expect(existsSync(staleFrame)).toBe(false);
      expect(
        existsSync(path.join(path.dirname(result.browserVideo.sourcePath), 'frame-000000.png')),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
