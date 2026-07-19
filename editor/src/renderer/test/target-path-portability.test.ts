import { describe, expect, it } from 'vite-plus/test';
import {
  targetPathProjectValidationDiagnostic,
  validateTargetPaths,
} from '../../shared/project-schema/target-path-portability';
import { portabilityFixtureEntries } from '../../shared/project-schema/platform-export-acceptance-fixture';

describe('target path portability', () => {
  it('reports stable diagnostics for the canonical hostile paths', () => {
    const diagnostics = validateTargetPaths([...portabilityFixtureEntries], 'windows', {
      maximumPathLength: 240,
    });
    expect(diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'absolute-path',
        'archive-traversal',
        'case-collision',
        'unicode-collision',
        'windows-reserved-name',
        'path-too-long',
      ]),
    );
    expect(diagnostics.find(({ code }) => code === 'case-collision')).toMatchObject({
      sourceIds: ['case-a', 'case-b'],
      targetPaths: ['Assets/Hero.png', 'assets/hero.png'],
    });
    expect(
      targetPathProjectValidationDiagnostic(
        diagnostics.find(({ code }) => code === 'case-collision')!,
      ),
    ).toMatchObject({
      code: 'case-collision',
      path: '/staging/targets/Assets~1Hero.png',
      ownerPaths: ['/staging/targets/Assets~1Hero.png', '/staging/targets/assets~1hero.png'],
      boundaries: ['platform-export'],
    });
  });
  it('does not impose Windows naming rules on Linux', () => {
    expect(
      validateTargetPaths([{ sourceId: 'reserved', targetPath: 'data/CON.json' }], 'linux'),
    ).toEqual([]);
  });
});
