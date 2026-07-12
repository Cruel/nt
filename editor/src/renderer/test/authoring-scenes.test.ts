import { describe, expect, it } from 'vitest';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  defaultSceneData, defaultSceneStep, sceneAssetRef, sceneDataSchema, sceneDialogueRef,
  sceneMaterialRef, sceneStepDataSchema, sceneVariableRef, validateSceneData,
} from '../../shared/project-schema/authoring-scenes';
import { defaultVariableData } from '../../shared/project-schema/authoring-variables';
import { buildScenePreviewDocumentData } from '../../shared/project-schema/scene-project';

describe('authoring scenes v2', () => {
  it('creates a strict scene with editor state excluded', () => {
    const data = defaultSceneData('Opening');
    expect(data).toEqual(expect.objectContaining({
      kind: 'scene', displayName: 'Opening', continuation: { kind: 'end' },
      steps: [{ id: 'start', type: 'comment', label: 'Start', text: '' }],
    }));
    expect(data).not.toHaveProperty('preview');
    expect(data).not.toHaveProperty('settings');
  });

  it('rejects inactive payloads and unknown nested fields', () => {
    expect(sceneStepDataSchema.safeParse({
      ...defaultSceneStep('wait'),
      background: { color: '#fff' },
    }).success).toBe(false);
    expect(sceneDataSchema.safeParse({
      ...defaultSceneData(),
      defaultBackground: { ...defaultSceneData().defaultBackground, previewOnly: true },
    }).success).toBe(false);
  });

  it('creates valid defaults for every standalone step variant', () => {
    expect(sceneStepDataSchema.safeParse(defaultSceneStep('run-lua')).success).toBe(true);
    expect(defaultSceneStep('run-lua')).toMatchObject({ source: '-- Lua' });
  });

  it('validates references, branch targets, and continuation targets', () => {
    const project = createAuthoringProject();
    const data = defaultSceneData('Opening');
    data.steps = [
      { ...defaultSceneStep('call-dialogue'), id: 'dialogue', dialogue: sceneDialogueRef('missing') },
      { ...defaultSceneStep('conditional-branch'), id: 'branch', fallbackStepId: 'missing', branches: [{ id: 'arm', condition: { kind: 'always' }, targetStepId: 'missing' }] },
    ];
    data.continuation = { kind: 'room', id: 'missing-room' };
    project.scenes.opening = { id: 'opening', label: 'Opening', data };
    expect(validateSceneData(project, 'opening', project.scenes.opening)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/scenes/opening/data/steps/0/dialogue' }),
      expect.objectContaining({ path: '/scenes/opening/data/steps/1/branches/0/targetStepId' }),
      expect.objectContaining({ path: '/scenes/opening/data/steps/1/fallbackStepId' }),
      expect.objectContaining({ path: '/scenes/opening/data/continuation/id' }),
    ]));
  });

  it('validates all scene references, nested IDs, and variable value types', () => {
    const project = createAuthoringProject();
    project.variables.flag = { id: 'flag', label: 'Flag', data: defaultVariableData('boolean') };
    const data = defaultSceneData();
    data.defaultBackground.asset = sceneAssetRef('missing-asset');
    data.defaultBackground.material = sceneMaterialRef('missing-material');
    data.steps = [
      { ...defaultSceneStep('set-variable'), id: 'set', variable: sceneVariableRef('flag'), value: 'wrong' },
      { ...defaultSceneStep('choice'), id: 'choice', options: [
        { id: 'same', label: { source: { kind: 'inline', text: 'One' }, markup: 'plain' }, effects: [], targetStepId: 'set' },
        { id: 'same', label: { source: { kind: 'inline', text: 'Two' }, markup: 'plain' }, effects: [{ kind: 'set-variable', variable: sceneVariableRef('flag'), value: 1 }], targetStepId: 'set' },
      ] },
    ];
    project.scenes.opening = { id: 'opening', label: 'Opening', data };
    expect(validateSceneData(project, 'opening', project.scenes.opening)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/scenes/opening/data/defaultBackground/asset' }),
      expect.objectContaining({ path: '/scenes/opening/data/defaultBackground/material' }),
      expect.objectContaining({ path: '/scenes/opening/data/steps/0/value' }),
      expect.objectContaining({ path: '/scenes/opening/data/steps/1/options/1/id' }),
      expect.objectContaining({ path: '/scenes/opening/data/steps/1/options/1/effects/0/value' }),
    ]));
  });

  it('builds preview data from editor-owned selection', () => {
    const project = createAuthoringProject();
    const data = defaultSceneData('Opening');
    data.steps.push({ ...defaultSceneStep('show-text'), id: 'line', text: { source: { kind: 'inline', text: 'Hello' }, markup: 'active-text' } });
    project.scenes.opening = { id: 'opening', label: 'Opening', data };
    expect(buildScenePreviewDocumentData(project, 'opening', 'line')).toMatchObject({
      schema: 'noveltea.scene-preview.v2', selectedStepId: 'line', selectedStep: { type: 'show-text' },
    });
  });
});
