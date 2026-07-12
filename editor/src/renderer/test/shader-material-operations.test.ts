import { describe, expect, it } from 'vitest';
import { createInitialCommandHistoryState, executeCommand } from '@/commands/command-bus';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import { defaultShaderData } from '../../shared/project-schema/authoring-shaders';

describe('shader/material command operations', () => {
  it('replaces shader data through the command bus', () => {
    const project = createAuthoringProject();
    project.shaders.noise = { id: 'noise', label: 'Noise', data: defaultShaderData('Noise') };
    const next = { ...defaultShaderData('Noise'), roles: ['rmlui-decorator' as const] };
    const result = executeCommand(
      { document: project as never, history: createInitialCommandHistoryState() },
      { type: 'shader.replaceData', label: 'Update shader', payload: { shaderId: 'noise', data: next } },
    );
    expect(result.ok).toBe(true);
    expect((result.document as never as { shaders: Record<string, { data: unknown }> }).shaders.noise?.data).toMatchObject({ roles: ['rmlui-decorator'] });
  });

  it('applies compiled outputs to shader stages through an undoable patch', () => {
    const project = createAuthoringProject();
    project.shaders.noise = {
      id: 'noise',
      label: 'Noise',
            data: { ...defaultShaderData('Noise'), stages: [{ stage: 'fragment', sourceMode: 'inline', sourceText: 'void main() {}', compiled: {} }] },
    };
    const result = executeCommand(
      { document: project as never, history: createInitialCommandHistoryState() },
      {
        type: 'shader.applyCompiledOutputs',
        label: 'Apply outputs',
        payload: { outputs: [{ shader: 'noise', stage: 'fragment', variant: 'glsl-120', runtimePath: 'project:/shaders/bgfx/glsl-120/noise.fs.bin' }] },
      },
    );
    expect(result.ok).toBe(true);
    expect((result.document as never as { shaders: Record<string, { data: { stages: Array<{ compiled?: Record<string, string> }> } }> }).shaders.noise?.data.stages[0]?.compiled).toEqual({ 'glsl-120': 'project:/shaders/bgfx/glsl-120/noise.fs.bin' });
  });

  it('sets explicit material inheritance without restoring generic record inheritance', () => {
    const project = createAuthoringProject();
    project.materials.base = { id: 'base', label: 'Base', data: defaultMaterialData('Base') };
    project.materials.child = { id: 'child', label: 'Child', data: defaultMaterialData('Child') };
    const result = executeCommand(
      { document: project as never, history: createInitialCommandHistoryState() },
      { type: 'material.setBase', payload: { materialId: 'child', baseMaterialId: 'base' } },
    );
    expect(result.ok).toBe(true);
    expect((result.document as never as { materials: Record<string, { data: { baseMaterialId: string | null } }> }).materials.child?.data.baseMaterialId).toBe('base');
    expect((result.document as never as { materials: Record<string, unknown> }).materials.child).not.toHaveProperty('inherits');
  });
});
