import { describe, expect, it } from 'vite-plus/test';
import { createInitialCommandBusState, executeCommand, undoCommand } from './command-test-utils';
import { toJsonValue } from '@/project/json-value';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  defaultSceneData,
  defaultSceneStep,
  sceneDialogueRef,
} from '../../shared/project-schema/authoring-scenes';

describe('scene commands', () => {
  it('creates a strict scene record', () => {
    const state = createInitialCommandBusState(toJsonValue(createAuthoringProject()));
    const result = executeCommand(state, {
      type: 'entity.createRecord',
      payload: { collection: 'scenes', entityId: 'opening', label: 'Opening' },
    });
    expect(result.ok).toBe(true);
    expect(result.document).toMatchObject({
      scenes: {
        opening: {
          data: { kind: 'scene', continuation: { kind: 'end' }, steps: [{ type: 'comment' }] },
        },
      },
    });
  });

  it('rejects invalid references and supports undo for valid replacements', () => {
    const project = createAuthoringProject();
    project.scenes.opening = { id: 'opening', label: 'Opening', data: defaultSceneData('Opening') };
    let state = createInitialCommandBusState(toJsonValue(project));
    const invalid = defaultSceneData('Opening');
    invalid.steps = [
      { ...defaultSceneStep('call-dialogue'), dialogue: sceneDialogueRef('missing') },
    ];
    expect(
      executeCommand(state, {
        type: 'scene.replaceData',
        payload: { sceneId: 'opening', data: invalid },
      }).ok,
    ).toBe(false);
    const next = defaultSceneData('Opening Scene');
    next.steps.push({ ...defaultSceneStep('wait'), id: 'wait' });
    const valid = executeCommand(state, {
      type: 'scene.replaceData',
      label: 'Set scene data',
      payload: { sceneId: 'opening', data: next },
    });
    expect(valid.ok).toBe(true);
    state = valid.state;
    expect(undoCommand(state).document).toMatchObject({
      scenes: { opening: { data: { displayName: 'Opening' } } },
    });
  });
});
