import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultSceneData } from '../../shared/project-schema/authoring-scenes';
import {
  defaultTestAssertion,
  defaultTestData,
  defaultTestStep,
  testCharacterSubject,
  testInteractableRef,
  testInteractableSubject,
  testSceneRef,
  testVariableRef,
  testVerbRef,
} from '../../shared/project-schema/authoring-tests';
import {
  buildRuntimePlaybackSpecFromAuthoringTest,
  getAuthoringTestRunReadiness,
} from '../../shared/project-schema/test-playback-project';

describe('authoring test playback project adapter', () => {
  it('serializes stable authoring inputs to the strict typed playback protocol', () => {
    const project = createAuthoringProject();
    const data = defaultTestData('Smoke');
    data.steps = [
      { ...defaultTestStep('tick'), id: 'tick', label: 'Tick', tick: { deltaSeconds: 0.25 } },
      { ...defaultTestStep('continue'), id: 'continue', label: 'Continue' },
      {
        ...defaultTestStep('select-subjects'),
        id: 'select',
        label: 'Select',
        selectSubjects: {
          subjects: [testCharacterSubject('guard'), testInteractableSubject('lamp')],
        },
      },
      { ...defaultTestStep('clear-subject-selection'), id: 'clear', label: 'Clear' },
      {
        ...defaultTestStep('run-interaction'),
        id: 'action',
        label: 'Action',
        runInteraction: {
          verb: testVerbRef('look'),
          operands: [testCharacterSubject('guard'), testInteractableSubject('lamp')],
        },
      },
      {
        ...defaultTestStep('load-save'),
        id: 'load',
        label: 'Load',
        loadSave: { slotId: 'slot-2', payload: null },
      },
      { ...defaultTestStep('continue'), id: 'disabled', label: 'Disabled', enabled: false },
    ];
    project.tests.smoke = { id: 'smoke', label: 'Smoke', data };

    expect(buildRuntimePlaybackSpecFromAuthoringTest(project, 'smoke').spec).toMatchObject({
      id: 'smoke',
      schema: 'noveltea.editor.playback',
      version: 1,
      steps: [
        { index: 0, input: { type: 'advance-time', microseconds: 250000 } },
        { index: 1, input: { type: 'continue' } },
        {
          index: 2,
          input: {
            type: 'select-subjects',
            subjects: [
              { kind: 'character', id: 'guard' },
              { kind: 'interactable', id: 'lamp' },
            ],
          },
        },
        { index: 3, input: { type: 'clear-selection' } },
        {
          index: 4,
          input: {
            type: 'invoke-interaction',
            verb: 'look',
            operands: [
              { kind: 'character', id: 'guard' },
              { kind: 'interactable', id: 'lamp' },
            ],
          },
        },
        { index: 5, input: { type: 'load', slot: { kind: 'manual', number: 2 } } },
      ],
    });
  });

  it('blocks assertions until they have a typed playback representation', () => {
    const project = createAuthoringProject();
    const data = defaultTestData('Smoke');
    data.steps = [
      {
        ...defaultTestStep('continue'),
        id: 'assertions',
        label: 'Assertions',
        assertions: [
          { ...defaultTestAssertion('mode'), id: 'mode', value: 'dialogue' },
          { ...defaultTestAssertion('current-room'), id: 'room', value: 'foyer' },
          { ...defaultTestAssertion('title'), id: 'title', value: 'Opening' },
          { ...defaultTestAssertion('text-log-contains'), id: 'text', value: 'Hello' },
          {
            ...defaultTestAssertion('property-equals'),
            id: 'property',
            variable: testVariableRef('flag'),
            expected: true,
          },
          {
            ...defaultTestAssertion('interactable-location'),
            id: 'location',
            key: 'lamp',
            entity: testInteractableRef('lamp'),
          },
          { ...defaultTestAssertion('inventory-contains'), id: 'inventory', value: 'key' },
          { ...defaultTestAssertion('output-type'), id: 'output', value: 'state' },
          { ...defaultTestAssertion('diagnostic-category'), id: 'diagnostic', value: 'playback' },
          { ...defaultTestAssertion('mode'), id: 'disabled', value: 'ignored', enabled: false },
        ],
      },
    ];
    project.tests.smoke = { id: 'smoke', label: 'Smoke', data };

    const result = buildRuntimePlaybackSpecFromAuthoringTest(project, 'smoke');
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((item) => item.severity === 'error')).toBe(true);
  });

  it('publishes the same compiled artifact for runnable playback', () => {
    const project = createAuthoringProject();
    project.scenes.opening = { id: 'opening', label: 'Opening', data: defaultSceneData('Opening') };
    project.entrypoint = { kind: 'scene', id: 'opening' };
    const data = defaultTestData('Smoke');
    data.entrypoint = testSceneRef('opening');
    project.tests.smoke = { id: 'smoke', label: 'Smoke', data };

    expect(getAuthoringTestRunReadiness(project, 'smoke')).toMatchObject({
      runnable: true,
      reason: 'runnable',
    });
    expect(buildRuntimePlaybackSpecFromAuthoringTest(project, 'smoke').project).toMatchObject({
      schema: 'noveltea.compiled.project',
      entrypoint: { kind: 'scene', scene: { kind: 'scene', id: 'opening' } },
    });
  });

  it('rejects ui-click rather than falling back to legacy UI playback', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    project.entrypoint = { kind: 'room', id: 'foyer' };
    const data = defaultTestData('Title Start');
    data.steps = [
      {
        ...defaultTestStep('ui-click'),
        id: 'title-start',
        label: 'Title Start',
        uiClick: {
          documentId: 'runtime_title',
          target: '#nt-title-start',
          selector: '#nt-title-start',
        },
      },
    ];
    project.tests.smoke = { id: 'smoke', label: 'Smoke', data };

    const result = buildRuntimePlaybackSpecFromAuthoringTest(project, 'smoke');

    expect(result.ok).toBe(false);
    expect(result.runner).toBe('runtime');
    expect(result.diagnostics.some((item) => item.severity === 'error')).toBe(true);
    expect(result.project).toMatchObject({ schema: 'noveltea.compiled.project' });
    expect(getAuthoringTestRunReadiness(project, 'smoke')).toMatchObject({ runnable: false });
  });
});
