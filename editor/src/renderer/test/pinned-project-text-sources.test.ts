import { describe, expect, it } from 'vite-plus/test';
import {
  packageOptionsWithPinnedProjectTextSources,
  pinnedShaderSourceOverlays,
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
      ],
      textEntries: [{ text: 'existing', packagePath: 'metadata/existing.txt', storage: 'deflate' }],
    } as unknown as PreparedRuntimePackageOptions;

    const pinned = packageOptionsWithPinnedProjectTextSources(options, {
      'scripts/main.lua': { text: 'return "generation-one"\n' },
      'shaders/effect.sc': { text: 'void main() { /* generation-one */ }\n' },
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
});
