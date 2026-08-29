import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultSceneData } from '../../shared/project-schema/authoring-scenes';
import {
  defaultTestData,
  defaultTestStep,
  testCharacterSubject,
  testFeatureSubject,
  testInteractableSubject,
  testVerbRef,
} from '../../shared/project-schema/authoring-tests';
import { roomFeatureRef } from '../../shared/project-schema/authoring-features';
import {
  buildRuntimePlaybackSpecFromAuthoringTest,
  getAuthoringTestRunReadiness,
} from '../../shared/project-schema/test-playback-project';

describe('authoring test playback project adapter', () => {
  it('serializes stable authoring inputs to the strict typed playback protocol', async () => {
    const project = createAuthoringProject();
    const data = defaultTestData('Smoke');
    data.steps = [
      { ...defaultTestStep('tick'), id: 'tick', label: 'Tick', tick: { deltaSeconds: 0.25 } },
      { ...defaultTestStep('continue'), id: 'continue', label: 'Continue' },
      {
        ...defaultTestStep('dialogue-choice'),
        id: 'dialogue-choice',
        label: 'Dialogue Choice',
        dialogueChoice: { edgeId: 'accept' },
      },
      {
        ...defaultTestStep('scene-choice'),
        id: 'scene-choice',
        label: 'Scene Choice',
        sceneChoice: { optionId: 'investigate' },
      },
      {
        ...defaultTestStep('navigate'),
        id: 'navigate',
        label: 'Navigate',
        navigate: { exitId: 'north-exit' },
      },
      {
        ...defaultTestStep('select-subjects'),
        id: 'select',
        label: 'Select',
        selectSubjects: {
          subjects: [
            testCharacterSubject('guard'),
            testInteractableSubject('lamp'),
            testFeatureSubject(roomFeatureRef('foyer', 'door')),
          ],
        },
      },
      {
        ...defaultTestStep('primary-activate'),
        id: 'primary',
        label: 'Primary',
        subjectAction: { subject: testInteractableSubject('lamp') },
      },
      {
        ...defaultTestStep('open-verb-menu'),
        id: 'menu',
        label: 'Menu',
        subjectAction: { subject: testFeatureSubject(roomFeatureRef('foyer', 'door')) },
      },
      { ...defaultTestStep('clear-subject-selection'), id: 'clear', label: 'Clear' },
      {
        ...defaultTestStep('run-interaction'),
        id: 'action',
        label: 'Action',
        runInteraction: {
          verb: testVerbRef('look'),
          bindings: [
            { slotId: 'first', subject: testCharacterSubject('guard') },
            { slotId: 'second', subject: testInteractableSubject('lamp') },
          ],
        },
      },
      {
        ...defaultTestStep('save'),
        id: 'save',
        label: 'Save',
        saveSlot: { slotId: 'autosave' },
      },
      {
        ...defaultTestStep('load'),
        id: 'load',
        label: 'Load',
        saveSlot: { slotId: 'slot-2' },
      },
      { ...defaultTestStep('continue'), id: 'disabled', label: 'Disabled', enabled: false },
    ];
    project.tests.smoke = { id: 'smoke', label: 'Smoke', data };

    expect((await buildRuntimePlaybackSpecFromAuthoringTest(project, 'smoke')).spec).toMatchObject({
      id: 'smoke',
      schema: 'noveltea.editor.playback',
      version: 1,
      steps: [
        { index: 0, input: { type: 'advance-time', microseconds: 250000 } },
        { index: 1, input: { type: 'continue' } },
        { index: 2, input: { type: 'dialogue-choice', edge: 'accept' } },
        { index: 3, input: { type: 'scene-choice', option: 'investigate' } },
        { index: 4, input: { type: 'navigate', exit: 'north-exit' } },
        {
          index: 5,
          input: {
            type: 'select-subjects',
            subjects: [
              { kind: 'character', id: 'guard' },
              { kind: 'interactable', id: 'lamp' },
              { kind: 'feature', ownerKind: 'room', ownerId: 'foyer', featureId: 'door' },
            ],
          },
        },
        {
          index: 6,
          input: { type: 'primary-activate', subject: { kind: 'interactable', id: 'lamp' } },
        },
        {
          index: 7,
          input: {
            type: 'open-verb-menu',
            subject: { kind: 'feature', ownerKind: 'room', ownerId: 'foyer', featureId: 'door' },
          },
        },
        { index: 8, input: { type: 'clear-selection' } },
        {
          index: 9,
          input: {
            type: 'invoke-interaction',
            verb: 'look',
            bindings: [
              { slotId: 'first', subject: { kind: 'character', id: 'guard' } },
              { slotId: 'second', subject: { kind: 'interactable', id: 'lamp' } },
            ],
          },
        },
        { index: 10, input: { type: 'save', slot: { kind: 'autosave' } } },
        { index: 11, input: { type: 'load', slot: { kind: 'manual', number: 2 } } },
      ],
    });
  });

  it('publishes the same compiled artifact for runnable playback', async () => {
    const project = createAuthoringProject();
    project.scenes.opening = { id: 'opening', label: 'Opening', data: defaultSceneData('Opening') };
    project.entrypoint = { kind: 'scene', id: 'opening' };
    const data = defaultTestData('Smoke');
    project.tests.smoke = { id: 'smoke', label: 'Smoke', data };

    expect(await getAuthoringTestRunReadiness(project, 'smoke')).toMatchObject({
      runnable: true,
      reason: 'runnable',
    });
    expect(
      (await buildRuntimePlaybackSpecFromAuthoringTest(project, 'smoke')).project,
    ).toMatchObject({
      schema: 'noveltea.compiled.project',
      entrypoint: { kind: 'scene', scene: { kind: 'scene', id: 'opening' } },
    });
  });

  it('rejects ui-click rather than falling back to legacy UI playback', async () => {
    const project = createAuthoringProject();
    const data = defaultTestData('Title Start');
    project.tests.smoke = {
      id: 'smoke',
      label: 'Smoke',
      data: {
        ...data,
        steps: [
          {
            ...defaultTestStep('tick'),
            input: 'ui-click',
            uiClick: { documentId: 'runtime_title', selector: '#nt-title-start' },
          },
        ],
      } as never,
    };

    const result = await buildRuntimePlaybackSpecFromAuthoringTest(project, 'smoke');

    expect(result.ok).toBe(false);
    expect(result.runner).toBeUndefined();
    expect(result.diagnostics.some((item) => item.severity === 'error')).toBe(true);
    expect(result.project).toBeUndefined();
    expect(await getAuthoringTestRunReadiness(project, 'smoke')).toMatchObject({ runnable: false });
  });
});
