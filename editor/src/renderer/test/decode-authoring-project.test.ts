import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  AUTHORING_ENUM_REPAIR_POLICIES,
  decodeAuthoringProject,
} from '../../shared/project-schema/decode-authoring-project';
import { stripEditorProjectState } from '../../shared/project-schema/editor-project-state';

describe('decodeAuthoringProject', () => {
  it('opens structurally valid projects with semantic diagnostics', () => {
    const project = createAuthoringProject();
    project.project.name = '';

    const decoded = decodeAuthoringProject(stripEditorProjectState(project));

    expect(decoded.project).not.toBeNull();
    expect(decoded.structuralDiagnostics).toEqual([]);
    expect(decoded.semanticDiagnostics).toContainEqual(
      expect.objectContaining({ severity: 'error', path: '/project/name' }),
    );
  });

  it('repairs only explicitly registered leaf enum paths', () => {
    const project = createAuthoringProject();
    project.settings.presentation.roomNavigationTransition = {
      ...project.settings.presentation.roomNavigationTransition,
      kind: 'unknown' as never,
    };

    const decoded = decodeAuthoringProject(stripEditorProjectState(project));

    expect(decoded.project?.settings.presentation.roomNavigationTransition.kind).toBe('cut');
    expect(decoded.repairs).toEqual([
      expect.objectContaining({
        path: '/settings/presentation/roomNavigationTransition/kind',
        invalidValue: 'unknown',
        replacement: 'cut',
      }),
    ]);
    expect(decoded.differsFromDisk).toBe(true);
    expect(decoded.semanticDiagnostics).toContainEqual(
      expect.objectContaining({
        code: 'authoring.repair.room-navigation-transition-kind',
        severity: 'warning',
      }),
    );
  });

  it('preserves invalid present world raster policy values for settings recovery', () => {
    const project = createAuthoringProject();
    project.settings.display.worldRasterPolicy = 'future-policy' as never;

    const decoded = decodeAuthoringProject(stripEditorProjectState(project));

    expect(decoded.project?.settings.display.worldRasterPolicy).toBe('future-policy');
    expect(decoded.repairs).toEqual([]);
    expect(decoded.differsFromDisk).toBe(false);
    expect(decoded.semanticDiagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        path: '/settings/display/worldRasterPolicy',
      }),
    );
  });

  it('rejects structural corruption without inventing a generic fallback', () => {
    const project = createAuthoringProject() as unknown as Record<string, unknown>;
    project.settings = [];

    const decoded = decodeAuthoringProject(project);

    expect(decoded.project).toBeNull();
    expect(decoded.repairs).toEqual([]);
    expect(decoded.structuralDiagnostics).toContainEqual(
      expect.objectContaining({ severity: 'error', path: '/settings' }),
    );
  });

  it('keeps unknown schema versions and structural discriminants fatal', () => {
    const project = stripEditorProjectState(createAuthoringProject()) as Record<string, unknown>;
    expect(decodeAuthoringProject({ ...project, schemaVersion: 3 }).project).toBeNull();
    expect(
      decodeAuthoringProject({
        ...project,
        entrypoint: { kind: 'unknown', id: 'start' },
      }).project,
    ).toBeNull();
  });

  it('documents every enum repair with accepted values, safe default, code, and fixture', () => {
    expect(AUTHORING_ENUM_REPAIR_POLICIES.length).toBeGreaterThan(0);
    for (const policy of AUTHORING_ENUM_REPAIR_POLICIES) {
      expect(policy.acceptedValues).toContain(policy.safeDefault);
      expect(policy.diagnosticCode).toMatch(/^authoring\.repair\./);
      expect(policy.pointerPattern).toMatch(/^\//);
      expect(policy.testFixture).not.toBe('');
    }
  });
});
