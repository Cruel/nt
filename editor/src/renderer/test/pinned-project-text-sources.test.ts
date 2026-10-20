import { describe, expect, it, vi } from 'vite-plus/test';
import {
  packageOptionsWithPinnedProjectTextSources,
  pinnedShaderSourceOverlays,
  runtimeArtifactPathsWithPinnedSources,
} from '../../cli/pinned-project-text-sources';
import type { PreparedRuntimePackageOptions } from '../../shared/project-schema/prepared-runtime-artifact';

describe('pinned Project text source publication', () => {
  it('replaces live authored package files with pinned generation text', () => {
    const options = {
      fileEntries: [
        { path: '/project/scripts/main.lua', packagePath: 'scripts/main.lua', storage: 'deflate' },
        {
          path: '/project/shaders/effect.sc',
          packagePath: 'shaders/effect.sc',
          storage: 'deflate',
        },
        { path: '/project/assets/image.png', packagePath: 'assets/image.png', storage: 'store' },
        {
          path: '/project/support/LICENSE.txt',
          packagePath: 'licenses/support/LICENSE.txt',
          storage: 'store',
        },
      ],
      textEntries: [{ text: 'existing', packagePath: 'metadata/existing.txt', storage: 'deflate' }],
    } as unknown as PreparedRuntimePackageOptions;

    const pinned = packageOptionsWithPinnedProjectTextSources(options, {
      'scripts/main.lua': { text: 'return "generation-one"\n' },
      'shaders/effect.sc': { text: 'void main() { /* generation-one */ }\n' },
      'support/LICENSE.txt': { text: 'generation-one notice\n' },
    });

    expect(pinned.fileEntries).toEqual([
      { path: '/project/assets/image.png', packagePath: 'assets/image.png', storage: 'store' },
    ]);
    expect(pinned.textEntries).toEqual(
      expect.arrayContaining([
        { text: 'existing', packagePath: 'metadata/existing.txt', storage: 'deflate' },
        {
          text: 'return "generation-one"\n',
          packagePath: 'scripts/main.lua',
          storage: 'deflate',
        },
        {
          text: 'void main() { /* generation-one */ }\n',
          packagePath: 'shaders/effect.sc',
          storage: 'deflate',
        },
        {
          text: 'generation-one notice\n',
          packagePath: 'licenses/support/LICENSE.txt',
          storage: 'store',
        },
      ]),
    );
  });

  it('limits shader overlays to pinned shader sources', () => {
    expect(
      pinnedShaderSourceOverlays({
        'shaders/effect.sc': { text: 'effect' },
        'shaders/includes/common.sc': { text: 'common' },
        'scripts/main.lua': { text: 'lua' },
      }),
    ).toEqual({
      'shaders/effect.sc': 'effect',
      'shaders/includes/common.sc': 'common',
    });
  });

  it('verifies shader include revisions against pinned text without reopening disk', async () => {
    const diskRead = vi.fn(() => {
      throw new Error('must not read live disk');
    });
    const paths = runtimeArtifactPathsWithPinnedSources(
      {
        resolveProjectSource: (_root, source) => source,
        shaderAssetRoot: () => undefined,
        readProjectTextSources: diskRead,
      },
      { 'shaders/include/common.inc': { text: 'pinned contents' } },
    );
    const hash =
      `sha256:${(await import('node:crypto')).createHash('sha256').update('pinned contents').digest('hex')}` as const;
    const entries = [
      {
        assetId: 'a',
        projectRelativePath: 'shaders/include/common.inc',
        expectedContentHash: hash,
      },
      {
        assetId: 'b',
        projectRelativePath: 'shaders/include/missing.inc',
        expectedContentHash: hash,
      },
      {
        assetId: 'c',
        projectRelativePath: 'shaders/include/common.inc',
        expectedContentHash: 'sha256:bad' as typeof hash,
      },
    ];
    const result = await paths.readProjectTextSources!('/unrelated/disk', entries);
    expect(result[0]).toMatchObject({
      status: 'ready',
      text: 'pinned contents',
      contentHash: hash,
    });
    expect(result[1]).toEqual({ status: 'unavailable', assetId: 'b' });
    expect(result[2]).toEqual({ status: 'unavailable', assetId: 'c' });
    expect(diskRead).not.toHaveBeenCalled();
  });
});
