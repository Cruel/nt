import { describe, expect, it } from 'vite-plus/test';
import { unchangedValidationContributionInputs } from '../../shared/project-schema/authoring-validation-input-equivalence';
import type { AuthoringValidationContribution } from '../../shared/project-schema/authoring-validation-contributions';

describe('shared authoring contribution input equivalence', () => {
  const contribution = (
    key: string,
    inputPaths: string[],
    unresolvedInputs = false,
  ): AuthoringValidationContribution => ({
    key,
    inputPaths,
    sourceRevisions: [{ path: key, contentHash: 'sha256:admitted' }],
    diagnostics: [],
    ...(unresolvedInputs ? { unresolvedInputs: true as const } : {}),
  });

  it('reuses unchanged inputs and conservatively rejects changed or unresolved paths', () => {
    const original = {
      project: { name: 'Before' },
      settings: { display: { size: [1280, 720] } },
      rooms: { foyer: { label: 'Foyer' } },
    };
    const normalized = {
      ...original,
      project: { name: 'After' },
      rooms: { foyer: { label: 'Foyer' } },
    };
    const contributions = [
      contribution('room', ['/rooms/foyer']),
      contribution('settings', ['/settings/display']),
      contribution('name', ['/project/name']),
      contribution('root', ['/']),
      contribution('missing', ['/rooms/missing']),
      contribution('unresolved', ['/rooms/foyer'], true),
    ];
    const matches = unchangedValidationContributionInputs(original, normalized, contributions);
    expect(matches.has(JSON.stringify(['/rooms/foyer']))).toBe(true);
    expect(matches.has(JSON.stringify(['/settings/display']))).toBe(true);
    expect(matches.has(JSON.stringify(['/project/name']))).toBe(false);
    expect(matches.has(JSON.stringify(['/']))).toBe(false);
    expect(matches.has(JSON.stringify(['/rooms/missing']))).toBe(true);
    expect(matches.size).toBe(3);
  });

  it('invalidates an existing record when it disappears or an array changes', () => {
    const before = { rooms: { foyer: { label: 'Foyer' } }, values: [1, 2] };
    const after = { rooms: {}, values: [2, 1] };
    const matches = unchangedValidationContributionInputs(before, after, [
      contribution('room', ['/rooms/foyer']),
      contribution('array', ['/values']),
    ]);
    expect(matches.size).toBe(0);
  });
});
