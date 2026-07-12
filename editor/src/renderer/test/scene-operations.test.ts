import { describe, expect, it } from 'vitest';
import { createInitialCommandBusState, executeCommand, undoCommand } from '@/commands/command-bus';
import { toJsonValue } from '@/project/json-value';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultSceneData, defaultSceneStep, sceneDialogueRef } from '../../shared/project-schema/authoring-scenes';

describe('scene commands', () => {
  it('creates typed scene data through entity.createRecord', () => {
    const project = createAuthoringProject();
    const state = createInitialCommandBusState(toJsonValue(project));

    const result = executeCommand(state, {
      type: 'entity.createRecord',
      payload: { collection: 'scenes', entityId: 'opening', label: 'Opening' },
    });

    expect(result.ok).toBe(true);
    expect(result.document).toMatchObject({
      scenes: { opening: { data: { kind: 'scene', displayName: 'Opening', steps: [{ id: 'start', type: 'comment' }] } } },
    });
  });

  it('patches valid scene data and rejects error diagnostics', () => {
    const project = createAuthoringProject();
    project.scenes.opening = { id: 'opening', label: 'Opening', data: defaultSceneData('Opening') };
    let state = createInitialCommandBusState(toJsonValue(project));

    const invalidData = defaultSceneData('Opening');
    invalidData.steps = [{ ...defaultSceneStep('dialogue'), id: 'dialogue', label: 'Dialogue', dialogue: { ...defaultSceneStep('dialogue').dialogue, dialogue: sceneDialogueRef('missing') } }];
    const invalid = executeCommand(state, {
      type: 'scene.replaceData',
      payload: { sceneId: 'opening', data: invalidData },
    });
    expect(invalid.ok).toBe(false);

    const next = defaultSceneData('Opening');
    next.displayName = 'Opening Scene';
    next.steps.push({ ...defaultSceneStep('wait'), id: 'wait', label: 'Wait' });
    const valid = executeCommand(state, {
      type: 'scene.replaceData',
      label: 'Set scene data',
      payload: { sceneId: 'opening', data: next },
    });
    expect(valid.ok).toBe(true);
    expect(valid.document).toMatchObject({ scenes: { opening: { data: { displayName: 'Opening Scene', steps: [expect.anything(), expect.objectContaining({ id: 'wait' })] } } } });

    state = valid.state;
    expect(undoCommand(state).document).toMatchObject({ scenes: { opening: { data: { displayName: 'Opening' } } } });
  });
});
