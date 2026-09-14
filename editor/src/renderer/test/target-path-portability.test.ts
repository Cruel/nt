import { describe, expect, it } from 'vite-plus/test';
import {
  targetPathProjectValidationDiagnostic,
  validateTargetPaths,
} from '../../shared/project-schema/target-path-portability';
const portabilityFixtureEntries = [
  { sourceId: 'case-a', targetPath: 'Assets/Hero.png' },
  { sourceId: 'case-b', targetPath: 'assets/hero.png' },
  { sourceId: 'unicode-a', targetPath: 'text/café.txt' },
  { sourceId: 'unicode-b', targetPath: 'text/cafe\u0301.txt' },
  { sourceId: 'reserved', targetPath: 'data/CON.json' },
  { sourceId: 'long', targetPath: `assets/${'x'.repeat(260)}.png` },
  { sourceId: 'absolute', targetPath: '/etc/passwd' },
  { sourceId: 'traversal', targetPath: 'assets/../secret.txt' },
] as const;

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
