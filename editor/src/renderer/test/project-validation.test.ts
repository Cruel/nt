import { describe, expect, it } from 'vite-plus/test';
import {
  classifyProjectValidationDiagnostic,
  collectProjectValidationDiagnostics,
  createProjectValidationDiagnostic,
  normalizeProjectValidationBoundaries,
  projectValidationBlocksBoundary,
  projectValidationBoundariesForAuthoringPath,
  projectValidationBoundariesForCompilerDiagnostic,
} from '../../shared/project-schema/project-validation';

describe('project validation diagnostic contract', () => {
  it('normalizes runtime-package blockers to also block platform export', () => {
    expect(normalizeProjectValidationBoundaries(['runtime-package'])).toEqual([
      'runtime-package',
      'platform-export',
    ]);
  });

  it('classifies authoring diagnostics by canonical path without reading display text', () => {
    const first = classifyProjectValidationDiagnostic(
      {
        severity: 'error',
        path: '/rooms/room-a/data/background/asset/$ref',
        message: 'First localized message',
        category: 'Rooms',
      },
      { producer: 'authoring' },
    );
    const second = classifyProjectValidationDiagnostic(
      {
        severity: 'error',
        path: '/rooms/room-b/data/background/asset/$ref',
        message: 'Completely different display text',
        category: 'Rooms',
      },
      { producer: 'authoring' },
    );

    expect(first.code).toBe('authoring.rooms.rooms.record.data.background.asset.ref');
    expect(second.code).toBe(first.code);
    expect(first.boundaries).toEqual(['authoring', 'runtime-package', 'platform-export']);
    expect(first.ownerPaths).toEqual(['/rooms/room-a/data/background/asset/$ref']);
  });

  it('keeps tests and editor metadata authoring-only while app identity is platform-only beyond save', () => {
    expect(projectValidationBoundariesForAuthoringPath('/tests/smoke/data')).toEqual(['authoring']);
    expect(projectValidationBoundariesForAuthoringPath('/editor/recordMetadata')).toEqual([
      'authoring',
    ]);
    expect(projectValidationBoundariesForAuthoringPath('/settings/app/applicationId')).toEqual([
      'authoring',
      'platform-export',
    ]);
    expect(
      projectValidationBoundariesForCompilerDiagnostic(
        'AUTHORING_AUTHORING_PROJECT_NAME_REQUIRED',
        '/project/name',
      ),
    ).toEqual(['authoring', 'platform-export']);
    expect(
      projectValidationBoundariesForCompilerDiagnostic(
        'COMPILER_RESOURCE_ASSET_MISSING',
        '/resources/assets',
      ),
    ).toEqual(['authoring', 'runtime-package', 'platform-export']);
  });

  it('deduplicates by contract fields and returns deterministic code/path order', () => {
    const duplicateA = createProjectValidationDiagnostic({
      code: 'z.code',
      severity: 'error',
      path: '/rooms/b',
      message: 'First message wins after deterministic sorting.',
      boundaries: ['runtime-package'],
      ownerPaths: ['/rooms/b'],
    });
    const duplicateB = createProjectValidationDiagnostic({
      ...duplicateA,
      message: 'Different display text does not create a second diagnostic.',
    });
    const earlier = createProjectValidationDiagnostic({
      code: 'a.code',
      severity: 'warning',
      path: '/project/version',
      message: 'Version warning',
      boundaries: ['platform-export'],
      ownerPaths: ['/project/version'],
    });

    const collected = collectProjectValidationDiagnostics([duplicateB, earlier, duplicateA]);
    expect(collected).toHaveLength(2);
    expect(collected.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: 'a.code', path: '/project/version' },
      { code: 'z.code', path: '/rooms/b' },
    ]);
    expect(collected[1]?.boundaries).toEqual(['runtime-package', 'platform-export']);
  });

  it('normalizes every collected diagnostic before ordering and deduplication', () => {
    const collected = collectProjectValidationDiagnostics([
      {
        code: 'runtime.asset.missing',
        severity: 'error',
        path: 'assets/missing',
        message: 'Missing asset',
        boundaries: ['runtime-package'],
        ownerPaths: ['/rooms/b', 'rooms/a', '/rooms/b'],
      },
    ]);

    expect(collected).toEqual([
      expect.objectContaining({
        code: 'runtime.asset.missing',
        path: '/assets/missing',
        boundaries: ['runtime-package', 'platform-export'],
        ownerPaths: ['/rooms/a', '/rooms/b'],
      }),
    ]);
  });

  it('blocks only error diagnostics assigned to the requested boundary', () => {
    const diagnostic = createProjectValidationDiagnostic({
      code: 'platform.identity.invalid',
      severity: 'error',
      path: '/settings/app/applicationId',
      message: 'Invalid application ID',
      boundaries: ['platform-export'],
      ownerPaths: ['/settings/app/applicationId'],
    });
    expect(projectValidationBlocksBoundary(diagnostic, 'platform-export')).toBe(true);
    expect(projectValidationBlocksBoundary(diagnostic, 'runtime-package')).toBe(false);
  });
});
