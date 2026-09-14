import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import {
  defaultTestData,
  defaultTestExpectation,
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
      expectations: [],
    });
    expect(defaultTestData('Smoke').finalExpectations).toEqual([]);
    expect(defaultTestExpectation('trait')).toMatchObject({
      type: 'trait',
      operator: 'present',
      trait: { ownerKind: 'interactable', ownerId: '', traitId: 'trait' },
    });
    const structuredLayout = defaultTestExpectation('layout', 'eq');
    structuredLayout.layout = {
      layoutId: 'hud',
      field: 'state',
      value: { page: 2, flags: [true, false] },
    };
    expect(
      parseTestData({ ...defaultTestData('Smoke'), finalExpectations: [structuredLayout] }),
    ).not.toBeNull();
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

  it('validates typed expectation operators, targets, and duplicate IDs', () => {
    const project = createAuthoringProject();
    const data = defaultTestData('Smoke');
    const invalidRoom = defaultTestExpectation('current-room', 'eq');
    invalidRoom.id = 'same';
    invalidRoom.currentRoom.roomId = 'missing-room';
    const invalidTrait = defaultTestExpectation('trait', 'eq');
    invalidTrait.id = 'same';
    invalidTrait.trait.ownerId = 'missing-instance';
    invalidTrait.trait.traitId = 'missing-trait';
    data.steps[0]!.expectations = [invalidRoom, invalidTrait];
    data.finalExpectations = [
      {
        ...defaultTestExpectation('property', 'gt'),
        property: {
          scope: 'global',
          ownerId: '',
          propertyId: 'missing-property',
          value: 'not-a-number',
        },
      },
    ];
    project.tests.smoke = { id: 'smoke', label: 'Smoke', data };

    expect(validateTestData(project, 'smoke', project.tests.smoke)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/tests/smoke/data/steps/0/expectations/1/id' }),
        expect.objectContaining({
          path: '/tests/smoke/data/steps/0/expectations/0/currentRoom/roomId',
        }),
        expect.objectContaining({ path: '/tests/smoke/data/steps/0/expectations/1/operator' }),
        expect.objectContaining({ path: '/tests/smoke/data/steps/0/expectations/1/trait/ownerId' }),
        expect.objectContaining({ path: '/tests/smoke/data/steps/0/expectations/1/trait/traitId' }),
        expect.objectContaining({ path: '/tests/smoke/data/finalExpectations/0/property/value' }),
        expect.objectContaining({
          path: '/tests/smoke/data/finalExpectations/0/property/propertyId',
        }),
      ]),
    );
  });

  it('strictly rejects retired generic assertion payloads', () => {
    const data = defaultTestData('Smoke');
    expect(
      parseTestData({
        ...data,
        steps: [
          {
            ...defaultTestStep('tick'),
            assertions: [{ type: 'lua', value: 'return true' }],
          },
        ],
      }),
    ).toBeNull();
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
