import { describe, expect, it } from 'vite-plus/test';
import { createInitialCommandBusState, executeCommand, undoCommand } from './command-test-utils';
import { toJsonValue } from '@/project/json-value';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  defaultSceneData,
  defaultSceneStep,
  sceneDialogueRef,
} from '../../shared/project-schema/authoring-scenes';
import { inlineTextContent } from '../../shared/project-schema/authoring-flow';
import { structuredMessageId } from '../../shared/authoring-structured-messages';
import { testTranslation } from './fixtures/localization-workflow';

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
          data: {
            kind: 'scene',
            inputs: [],
            outcomes: [],
            terminal: { kind: 'complete-game' },
            stage: { kind: 'blank' },
            events: [{ type: 'comment' }],
          },
        },
      },
    });
  });

  it('preserves structured Message identity for an explicit event rename', () => {
    const project = createAuthoringProject();
    const scene = defaultSceneData('Opening');
    scene.events = [
      {
        ...defaultSceneStep('show-text'),
        id: 'line',
        text: inlineTextContent('Welcome.'),
      },
    ];
    project.scenes.opening = { id: 'opening', label: 'Opening', data: scene };
    project.localization.locales.fr = { supported: false, parentLocale: null, fontStack: null };
    const messageId = structuredMessageId('/scenes/opening/data/events/@line/text');
    const translation = testTranslation('Bienvenue.');
    project.localization.translations.fr = { [messageId]: translation };

    const renamed = structuredClone(scene);
    renamed.events[0]!.id = 'welcome-line';
    const result = executeCommand(createInitialCommandBusState(toJsonValue(project)), {
      type: 'scene.replaceData',
      payload: {
        sceneId: 'opening',
        data: renamed,
        semanticOwnerMoves: [
          {
            fromPrefix: '/scenes/opening/data/events/@line',
            toPrefix: '/scenes/opening/data/events/@welcome-line',
          },
        ],
      },
    });

    expect(result.ok, JSON.stringify(result.diagnostics, null, 2)).toBe(true);
    expect(result.document).toMatchObject({
      localization: {
        structuredMessageIds: { '/scenes/opening/data/events/@welcome-line/text': messageId },
        translations: { fr: { [messageId]: translation } },
      },
    });
  });

  it('rejects invalid references and supports undo for valid replacements', () => {
    const project = createAuthoringProject();
    project.scenes.opening = { id: 'opening', label: 'Opening', data: defaultSceneData('Opening') };
    let state = createInitialCommandBusState(toJsonValue(project));
    const invalid = defaultSceneData('Opening');
    invalid.events = [
      { ...defaultSceneStep('call-dialogue'), dialogue: sceneDialogueRef('missing') },
    ];
    expect(
      executeCommand(state, {
        type: 'scene.replaceData',
        payload: { sceneId: 'opening', data: invalid },
      }).ok,
    ).toBe(false);
    const next = defaultSceneData('Opening Scene');
    next.events.push({ ...defaultSceneStep('wait'), id: 'wait' });
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
