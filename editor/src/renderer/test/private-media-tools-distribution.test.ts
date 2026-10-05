import { describe, expect, it } from 'vite-plus/test';
// @ts-expect-error Distribution scripts are Node ESM, not TypeScript modules.
import { mediaArtifactTarget, verifyMediaArchive } from '../../../scripts/private-media-tools.mjs';

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
});
