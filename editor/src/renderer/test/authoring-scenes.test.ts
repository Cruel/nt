import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  defaultSceneData,
  defaultSceneStep,
  sceneAssetRef,
  sceneDataSchema,
  sceneDialogueRef,
  sceneMaterialRef,
  sceneStepDataSchema,
  sceneVariableRef,
  validateSceneData,
} from '../../shared/project-schema/authoring-scenes';
import { defaultVariableData } from '../../shared/project-schema/authoring-variables';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { buildScenePreviewDocumentData } from '../../shared/project-schema/scene-project';

describe('authoring scenes v2', () => {
  it('creates a strict scene with editor state excluded', () => {
    const data = defaultSceneData('Opening');
    expect(data).toEqual(
      expect.objectContaining({
        kind: 'scene',
        displayName: 'Opening',
        continuation: { kind: 'end' },
        steps: [{ id: 'start', type: 'comment', label: 'Start', text: '' }],
      }),
    );
    expect(data).not.toHaveProperty('preview');
    expect(data).not.toHaveProperty('settings');
  });

  it('rejects inactive payloads and unknown nested fields', () => {
    expect(
      sceneStepDataSchema.safeParse({
        ...defaultSceneStep('wait'),
        background: { color: '#fff' },
      }).success,
    ).toBe(false);
    expect(
      sceneDataSchema.safeParse({
        ...defaultSceneData(),
        defaultBackground: { ...defaultSceneData().defaultBackground, previewOnly: true },
      }).success,
    ).toBe(false);
  });

  it('creates valid defaults for every standalone step variant', () => {
    expect(sceneStepDataSchema.safeParse(defaultSceneStep('run-lua')).success).toBe(true);
    expect(defaultSceneStep('run-lua')).toMatchObject({ source: '-- Lua' });
  });

  it('accepts only strict TransitionGroup children and rejects the stale standalone transition', () => {
    const group = defaultSceneStep('transition-group');
    expect(sceneStepDataSchema.safeParse(group).success).toBe(true);
    expect(sceneStepDataSchema.safeParse({ ...group, type: 'transition' }).success).toBe(false);
    expect(sceneStepDataSchema.safeParse({ ...group, children: [] }).success).toBe(false);
    expect(
      sceneStepDataSchema.safeParse({
        ...group,
        children: [{ id: 'side-effect', type: 'run-lua', source: 'mutate()' }],
      }).success,
    ).toBe(false);
  });

  it('validates TransitionGroup timing, child IDs, and participating Layout planes', () => {
    const project = createAuthoringProject();
    project.layouts.ui = { id: 'ui', label: 'UI', data: defaultLayoutData('UI', 'document') };
    const group = defaultSceneStep('transition-group');
    group.transitionKind = 'cut';
    group.durationMs = 100;
    group.waitForCompletion = true;
    group.color = '#000000';
    group.children = [
      { id: 'same', type: 'clear-background' },
      {
        id: 'same',
        type: 'set-layout',
        action: 'show',
        slot: 'overlay',
        layout: { $ref: { collection: 'layouts', id: 'ui' } },
      },
    ];
    const data = defaultSceneData('Opening');
    data.steps = [group];
    project.scenes.opening = { id: 'opening', label: 'Opening', data };
    expect(validateSceneData(project, 'opening', project.scenes.opening)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/scenes/opening/data/steps/0/durationMs' }),
        expect.objectContaining({ path: '/scenes/opening/data/steps/0/waitForCompletion' }),
        expect.objectContaining({ path: '/scenes/opening/data/steps/0/color' }),
        expect.objectContaining({ path: '/scenes/opening/data/steps/0/children/1/id' }),
        expect.objectContaining({ path: '/scenes/opening/data/steps/0/children/1/layout' }),
      ]),
    );
  });

  it('validates standalone finite presentation timing and visual-kind combinations', () => {
    const project = createAuthoringProject();
    const background = defaultSceneStep('set-background');
    background.id = 'background';
    background.transition = 'cut';
    background.durationMs = 50;
    background.waitForCompletion = true;
    const actor = defaultSceneStep('actor-cue');
    actor.id = 'actor';
    actor.action = 'expression';
    actor.transition = 'slide';
    actor.durationMs = 0;
    const layout = defaultSceneStep('set-layout');
    layout.id = 'layout';
    layout.action = 'hide';
    layout.transition = 'fade';
    layout.durationMs = 0;
    const data = defaultSceneData('Opening');
    data.steps = [background, actor, layout];
    project.scenes.opening = { id: 'opening', label: 'Opening', data };
    expect(validateSceneData(project, 'opening', project.scenes.opening)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/scenes/opening/data/steps/0/durationMs' }),
        expect.objectContaining({ path: '/scenes/opening/data/steps/0/waitForCompletion' }),
        expect.objectContaining({ path: '/scenes/opening/data/steps/1/durationMs' }),
        expect.objectContaining({ path: '/scenes/opening/data/steps/1/transition' }),
        expect.objectContaining({ path: '/scenes/opening/data/steps/2/durationMs' }),
      ]),
    );
  });

  it('validates references, branch targets, and continuation targets', () => {
    const project = createAuthoringProject();
    const data = defaultSceneData('Opening');
    data.steps = [
      {
        ...defaultSceneStep('call-dialogue'),
        id: 'dialogue',
        dialogue: sceneDialogueRef('missing'),
      },
      {
        ...defaultSceneStep('conditional-branch'),
        id: 'branch',
        fallbackStepId: 'missing',
        branches: [{ id: 'arm', condition: { kind: 'always' }, targetStepId: 'missing' }],
      },
    ];
    data.continuation = { kind: 'room', id: 'missing-room' };
    project.scenes.opening = { id: 'opening', label: 'Opening', data };
    expect(validateSceneData(project, 'opening', project.scenes.opening)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/scenes/opening/data/steps/0/dialogue' }),
        expect.objectContaining({ path: '/scenes/opening/data/steps/1/branches/0/targetStepId' }),
        expect.objectContaining({ path: '/scenes/opening/data/steps/1/fallbackStepId' }),
        expect.objectContaining({ path: '/scenes/opening/data/continuation/id' }),
      ]),
    );
  });

  it('validates all scene references, nested IDs, and variable value types', () => {
    const project = createAuthoringProject();
    project.variables.flag = { id: 'flag', label: 'Flag', data: defaultVariableData('boolean') };
    const data = defaultSceneData();
    data.defaultBackground.asset = sceneAssetRef('missing-asset');
    data.defaultBackground.material = sceneMaterialRef('missing-material');
    data.steps = [
      {
        ...defaultSceneStep('set-variable'),
        id: 'set',
        variable: sceneVariableRef('flag'),
        value: 'wrong',
      },
      {
        ...defaultSceneStep('choice'),
        id: 'choice',
        options: [
          {
            id: 'same',
            label: { source: { kind: 'inline', text: 'One' }, markup: 'plain' },
            effects: [],
            targetStepId: 'set',
          },
          {
            id: 'same',
            label: { source: { kind: 'inline', text: 'Two' }, markup: 'plain' },
            effects: [{ kind: 'set-variable', variable: sceneVariableRef('flag'), value: 1 }],
            targetStepId: 'set',
          },
        ],
      },
    ];
    project.scenes.opening = { id: 'opening', label: 'Opening', data };
    expect(validateSceneData(project, 'opening', project.scenes.opening)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/scenes/opening/data/defaultBackground/asset' }),
        expect.objectContaining({ path: '/scenes/opening/data/defaultBackground/material' }),
        expect.objectContaining({ path: '/scenes/opening/data/steps/0/value' }),
        expect.objectContaining({ path: '/scenes/opening/data/steps/1/options/1/id' }),
        expect.objectContaining({ path: '/scenes/opening/data/steps/1/options/1/effects/0/value' }),
      ]),
    );
  });

  it('builds preview data from editor-owned selection', () => {
    const project = createAuthoringProject();
    const data = defaultSceneData('Opening');
    data.steps.push({
      ...defaultSceneStep('show-text'),
      id: 'line',
      text: { source: { kind: 'inline', text: 'Hello' }, markup: 'active-text' },
    });
    project.scenes.opening = { id: 'opening', label: 'Opening', data };
    expect(buildScenePreviewDocumentData(project, 'opening', 'line')).toMatchObject({
      schema: 'noveltea.scene-preview.v2',
      selectedStepId: 'line',
      selectedStep: { type: 'show-text' },
    });
  });
});
