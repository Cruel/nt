import { writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { installedMediaTool } from '../../main/services/media-preparation-service';
import { createNodeRuntimeArtifactPaths } from '../../main/services/node-runtime-artifact-adapters';

describe('runtime video media-tool discovery', () => {
  it('accepts an explicit absolute override without resolving a virtual scriptc executable', async () => {
    const previous = process.env.NOVELTEA_FFMPEG;
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-video-override-'));
    try {
      process.env.NOVELTEA_FFMPEG = path.resolve('/private/tools/ffmpeg');
      expect(installedMediaTool('scriptc')).toEqual({
        executable: path.resolve('/private/tools/ffmpeg'),
        bundled: false,
      });
      const paths = createNodeRuntimeArtifactPaths(() => {
        throw new Error('CLI executable lookup must be skipped with an explicit FFmpeg override');
      });
      await expect(
        paths.prepareOpaqueVideo!(root, {
          animationId: 'video',
          motionId: 'colors',
          assetId: 'source',
          sourcePath: 'missing.mp4',
          canvas: { width: 16, height: 16 },
        }),
      ).rejects.not.toThrow('CLI executable lookup must be skipped');
    } finally {
      if (previous === undefined) delete process.env.NOVELTEA_FFMPEG;
      else process.env.NOVELTEA_FFMPEG = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the supplied NovelTea executable rather than the Node or ScriptC runtime for preparation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-video-cli-'));
    const previous = process.env.NOVELTEA_FFMPEG;
    delete process.env.NOVELTEA_FFMPEG;
    try {
      const installation = path.join(root, 'installation');
      const cli = path.join(
        installation,
        process.platform === 'win32' ? 'noveltea.exe' : 'noveltea',
      );
      await mkdir(installation, { recursive: true });
      await writeFile(cli, 'test executable identity');
      const project = path.join(root, 'project');
      await mkdir(project);
      await writeFile(path.join(project, 'source.mp4'), 'test video data');
      const paths = createNodeRuntimeArtifactPaths(() => cli);
      const ffmpeg = path.join(
        installation,
        'tools',
        'ffmpeg',
        'bin',
        process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
      );
      await expect(
        paths.prepareOpaqueVideo!(project, {
          animationId: 'video',
          motionId: 'colors',
          assetId: 'source',
          sourcePath: 'source.mp4',
          canvas: { width: 16, height: 16 },
        }),
      ).rejects.toThrow(`Cannot execute media tool '${ffmpeg}'`);
    } finally {
      if (previous === undefined) delete process.env.NOVELTEA_FFMPEG;
      else process.env.NOVELTEA_FFMPEG = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs canonical video preparation through an injected host process boundary', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-video-host-runner-'));
    const previous = process.env.NOVELTEA_FFMPEG;
    delete process.env.NOVELTEA_FFMPEG;
    try {
      const installation = path.join(root, 'installation');
      const cli = path.join(
        installation,
        process.platform === 'win32' ? 'noveltea.exe' : 'noveltea',
      );
      await mkdir(installation);
      await writeFile(cli, 'cli');
      const project = path.join(root, 'project');
      await mkdir(project);
      await writeFile(path.join(project, 'source.mp4'), 'video');
      const calls: string[] = [];
      const paths = createNodeRuntimeArtifactPaths(
        () => cli,
        (executable, args) => {
          calls.push(executable);
          if (args.includes('-version'))
            return {
              stdout:
                'ffmpeg version 9.0.1\nconfiguration: --disable-gpl --disable-nonfree --disable-version3 --disable-network --enable-libaom --enable-libvpx',
              stderr: '',
            };
          if (args.includes('-encoders')) return { stdout: 'libaom-av1 libvpx-vp9', stderr: '' };
          if (args.includes('-protocols')) return { stdout: 'file pipe', stderr: '' };
          const output = args.at(-1)!;
          if (output.endsWith('.webm')) writeFileSync(output, 'browser video');
          else writeFileSync(output.replace('%06d', '000000'), 'frame');
          return { stdout: '', stderr: '' };
        },
      );
      const result = await paths.prepareOpaqueVideo!(project, {
        animationId: 'video',
        motionId: 'colors',
        assetId: 'source',
        sourcePath: 'source.mp4',
        canvas: { width: 16, height: 16 },
      });
      expect(result.frames).toHaveLength(1);
      expect(calls).toHaveLength(4);
      expect(new Set(calls)).toEqual(
        new Set([
          path.join(
            installation,
            'tools',
            'ffmpeg',
            'bin',
            process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
          ),
        ]),
      );
    } finally {
      if (previous === undefined) delete process.env.NOVELTEA_FFMPEG;
      else process.env.NOVELTEA_FFMPEG = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});
