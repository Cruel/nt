import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import {
  defaultTestData,
  defaultTestStep,
  parseTestData,
  testCharacterSubject,
  testInteractableSubject,
  validateTestData,
} from '../../shared/project-schema/authoring-tests';

describe('authoring tests schema', () => {
  it('provides semantic playback defaults', () => {
    expect(defaultTestData('Smoke')).toMatchObject({
      kind: 'test',
      displayName: 'Smoke',
      steps: [{ id: 'start', input: 'tick', label: 'Start', tick: { deltaSeconds: 0 } }],
      preview: { selectedStepId: 'start' },
    });
    expect(defaultTestStep('dialogue-choice')).toMatchObject({
      input: 'dialogue-choice',
      dialogueChoice: { edgeId: 'choice' },
    });
    expect(defaultTestStep('scene-choice')).toMatchObject({
      input: 'scene-choice',
      sceneChoice: { optionId: 'choice' },
    });
    expect(defaultTestStep('navigate')).toMatchObject({
      input: 'navigate',
      navigate: { exitId: 'exit' },
    });
    expect(defaultTestStep('save')).toMatchObject({
      input: 'save',
      saveSlot: { slotId: 'autosave' },
    });
  });

  it('strictly rejects obsolete positional and UI-driven test forms', () => {
    const data = defaultTestData('Smoke');
    expect(
      parseTestData({
        ...data,
        entrypoint: { $ref: { collection: 'scenes', id: 'opening' } },
      }),
    ).toBeNull();
    expect(
      parseTestData({
        ...data,
        steps: [
          {
            ...defaultTestStep('primary-activate'),
            subjectAction: {
              subject: {
                kind: 'item-stack',
                itemStack: { $ref: { collection: 'itemStacks', id: 'coins' } },
              },
            },
          },
        ],
      }),
    ).toBeNull();
    expect(
      parseTestData({
        ...data,
        steps: [
          {
            ...defaultTestStep('tick'),
            input: 'dialogue-option',
            dialogueOption: { optionIndex: 0 },
          },
        ],
      }),
    ).toBeNull();
    expect(
      parseTestData({
        ...data,
        steps: [
          {
            ...defaultTestStep('tick'),
            input: 'ui-click',
            uiClick: { documentId: 'runtime_title', selector: '#start' },
          },
        ],
      }),
    ).toBeNull();
  });

  it('validates referenced semantic subjects and duplicate step IDs', () => {
    const project = createAuthoringProject();
    const data = defaultTestData('Smoke');
    data.steps = [
      {
        ...defaultTestStep('run-interaction'),
        id: 'step',
        label: 'Interaction',
        runInteraction: {
          verb: { $ref: { collection: 'verbs', id: 'missing-verb' } },
          bindings: [
            { slotId: 'character', subject: testCharacterSubject('missing-character') },
            { slotId: 'interactable', subject: testInteractableSubject('missing-interactable') },
          ],
        },
      },
      { ...defaultTestStep('tick'), id: 'step', label: 'Duplicate' },
    ];
    project.tests.smoke = { id: 'smoke', label: 'Smoke', data };

    expect(validateTestData(project, 'smoke', project.tests.smoke)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/tests/smoke/data/steps/1/id', severity: 'error' }),
        expect.objectContaining({
          path: '/tests/smoke/data/steps/0/runInteraction/verb/$ref',
          severity: 'error',
        }),
        expect.objectContaining({
          path: '/tests/smoke/data/steps/0/runInteraction/bindings/0/subject/character/$ref',
          severity: 'error',
        }),
        expect.objectContaining({
          path: '/tests/smoke/data/steps/0/runInteraction/bindings/1/subject/interactable/$ref',
          severity: 'error',
        }),
      ]),
    );
  });

  it('reports invalid current test data through project validation', () => {
    const project = createAuthoringProject();
    const data = defaultTestData('Smoke');
    data.steps = [{ ...defaultTestStep('load'), saveSlot: { slotId: '' } }];
    project.tests.smoke = { id: 'smoke', label: 'Smoke', data };

    expect(validateAuthoringProject(project)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'Tests',
          path: '/tests/smoke/data/steps/0/saveSlot/slotId',
          severity: 'error',
        }),
      ]),
    );
  });
});
