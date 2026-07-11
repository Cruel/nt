import { describe, expect, it } from 'vitest';
import { validateTargetPaths } from '../../shared/project-schema/target-path-portability';
import { portabilityFixtureEntries } from './fixtures/platform-export-acceptance';

describe('target path portability', () => {
  it('reports stable diagnostics for the canonical hostile paths', () => {
    const diagnostics = validateTargetPaths([...portabilityFixtureEntries], 'windows', { maximumPathLength: 240 });
    expect(diagnostics.map(({ code }) => code)).toEqual(expect.arrayContaining(['absolute-path', 'archive-traversal', 'case-collision', 'unicode-collision', 'windows-reserved-name', 'path-too-long']));
    expect(diagnostics.find(({ code }) => code === 'case-collision')).toMatchObject({ sourceIds: ['case-a', 'case-b'], targetPaths: ['Assets/Hero.png', 'assets/hero.png'] });
  });
  it('does not impose Windows naming rules on Linux', () => {
    expect(validateTargetPaths([{ sourceId: 'reserved', targetPath: 'data/CON.json' }], 'linux')).toEqual([]);
  });
});
