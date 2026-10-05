import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  resolveMediaTool,
  inspectMediaTool,
  runMediaPreparation,
} from '../../main/services/media-preparation-service';

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
});
