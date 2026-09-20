import { describe, expect, it } from 'vite-plus/test';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { createInitialCommandHistoryState, executeCommand } from './command-test-utils';

describe('Material command operations', () => {
  it('replaces canonical Material data through the command bus', () => {
    const project = createAuthoringProject();
    project.materials.panel = {
      id: 'panel',
      label: 'Panel',
      data: defaultMaterialData('Panel', 'engine-2d'),
    };
    const next = {
      ...defaultMaterialData('Panel', 'postprocess-tint'),
      parameters: { u_tint: { value: [0.25, 0.5, 0.75, 1] as [number, number, number, number] } },
    };

    const result = executeCommand(
      {
        document: project as never,
        savedDocument: project as never,
        history: createInitialCommandHistoryState(),
      },
      {
        type: 'material.replaceData',
        label: 'Update material',
        payload: { materialId: 'panel', data: next },
      },
    );

    expect(result.ok).toBe(true);
    expect(
      (result.document as never as { materials: Record<string, { data: unknown }> }).materials.panel
        ?.data,
    ).toMatchObject({
      base: { kind: 'preset', preset: 'postprocess-tint' },
      parameters: { u_tint: { value: [0.25, 0.5, 0.75, 1] } },
    });
  });

  it('stores single-parent Material inheritance in canonical Material data', () => {
    const project = createAuthoringProject();
    project.materials.base = {
      id: 'base',
      label: 'Base',
      data: defaultMaterialData('Base', 'engine-2d'),
    };
    project.materials.child = {
      id: 'child',
      label: 'Child',
      data: defaultMaterialData('Child', 'engine-2d'),
    };
    const next = {
      kind: 'material' as const,
      base: {
        kind: 'material' as const,
        material: { $ref: { collection: 'materials' as const, id: 'base' } },
      },
      parameters: {},
      textures: {},
    };

    const result = executeCommand(
      {
        document: project as never,
        savedDocument: project as never,
        history: createInitialCommandHistoryState(),
      },
      {
        type: 'material.replaceData',
        label: 'Set base material',
        payload: { materialId: 'child', data: next },
      },
    );

    expect(result.ok).toBe(true);
    expect(
      (result.document as never as { materials: Record<string, { data: unknown }> }).materials.child
        ?.data,
    ).toMatchObject({
      base: { kind: 'material', material: { $ref: { collection: 'materials', id: 'base' } } },
    });
  });
});
