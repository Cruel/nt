import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
// @ts-expect-error Distribution scripts are Node ESM, not TypeScript modules.
import * as privateMediaTools from '../../../scripts/private-media-tools.mjs';

const { mediaArtifactTarget, verifyMediaArchive, verifyPrivateMediaTools } = privateMediaTools;

describe('pinned private FFmpeg distributions', () => {
  it.each([
    ['linux', 'x64', 'linux-x64'],
    ['win32', 'x64', 'windows-x64'],
    ['darwin', 'arm64', 'macos-arm64'],
  ])('selects the release-admitted host for %s/%s', (platform, arch, target) => {
    expect(mediaArtifactTarget(platform, arch)).toBe(target);
    expect(() => verifyMediaArchive(Buffer.from('tampered archive'), target)).toThrow('checksum');
  });
  it('rejects unsupported hosts rather than falling back to system FFmpeg', () => {
    expect(() => mediaArtifactTarget('linux', 'arm64')).toThrow('Unsupported');
  });

  it('accepts only the trimmed installed FFmpeg closure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-ffmpeg-test-'));
    try {
      await mkdir(path.join(root, 'bin'), { recursive: true });
      await mkdir(path.join(root, 'licenses', 'ffmpeg'), { recursive: true });
      await writeFile(path.join(root, 'bin', 'ffmpeg'), 'binary');
      await writeFile(path.join(root, 'licenses', 'ffmpeg', 'LICENSE.md'), 'license');
      await writeFile(path.join(root, 'NOTICE.txt'), 'notice');
      await writeFile(
        path.join(root, 'PROVENANCE.json'),
        JSON.stringify({
          platform: 'linux-x64',
          release_tag: 'ffmpeg-r1',
          components: { ffmpeg: { version: '9.0.1' } },
        }),
      );

      await expect(verifyPrivateMediaTools(root, 'linux-x64')).resolves.toBeUndefined();

      await mkdir(path.join(root, 'sources'));
      await writeFile(path.join(root, 'sources', 'ffmpeg.tar.xz'), 'source');
      await expect(verifyPrivateMediaTools(root, 'linux-x64')).rejects.toThrow(
        'non-runtime build/source payloads',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
