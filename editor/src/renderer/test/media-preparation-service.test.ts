import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vite-plus/test';
import {
  prepareOpaqueVideoMotion,
  resolveMediaTool,
  inspectMediaTool,
  runMediaPreparation,
} from '../../main/services/media-preparation-service';
import { opaqueVideoPreparationResultSchema } from '../../shared/prepared-media';

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

  it('prepares deterministic opaque Animation frames and strips embedded audio', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-video-preparation-'));
    try {
      await writeFile(path.join(root, 'source.mov'), Buffer.from('creator source bytes'));
      const calls: string[][] = [];
      const runner = (_executable: string, args: readonly string[]) => {
        calls.push([...args]);
        if (args.includes('-version')) return run(_executable, args);
        if (args.includes('-encoders')) return run(_executable, args);
        if (args.includes('-protocols')) return run(_executable, args);
        const pattern = args.at(-1)!;
        writeFileSync(pattern.replace('%06d', '000000'), Buffer.from('frame one'));
        writeFileSync(pattern.replace('%06d', '000001'), Buffer.from('frame two'));
        return {
          stdout: '',
          stderr: 'Stream #0:0: Video: vp9\nStream #0:1: Audio: opus',
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
      expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/u);
      expect(result.frames.map((frame) => frame.durationMs)).toEqual([33, 34]);
      expect(
        result.frames.every((frame) => frame.projectRelativePath.includes(result.contentHash)),
      ).toBe(true);
      const job = calls.find((args) => args.includes('-an') && args.includes('-vf'));
      expect(job).toEqual(
        expect.arrayContaining(['-map', '0:v:0', '-an', '-ss', '0.25', '-t', '1']),
      );
      expect(job?.join(' ')).toContain('fps=30');
      expect(job?.join(' ')).toContain('scale=320:180');
      expect(opaqueVideoPreparationResultSchema.parse(result)).toEqual(result);

      const staleFrame = path.join(path.dirname(result.frames[0]!.sourcePath), 'frame-999999.png');
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
