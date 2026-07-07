import { describe, expect, it } from 'vitest';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultSceneData } from '../../shared/project-schema/authoring-scenes';
import {
  defaultTestAssertion,
  defaultTestData,
  defaultTestStep,
  testObjectRef,
  testSceneRef,
  testVariableRef,
  testVerbRef,
} from '../../shared/project-schema/authoring-tests';
import { buildRuntimePlaybackSpecFromAuthoringTest, getAuthoringTestRunReadiness } from '../../shared/project-schema/test-playback-project';

describe('authoring test playback project adapter', () => {
  it('serializes every supported authoring input to native playback spelling', () => {
    const project = createAuthoringProject();
    const data = defaultTestData('Smoke');
    data.fixedDeltaSeconds = 0.016;
    data.initScript = 'setup()';
    data.checkScript = 'check()';
    data.steps = [
      { ...defaultTestStep('tick'), id: 'tick', label: 'Tick', tick: { deltaSeconds: 0.25 } },
      { ...defaultTestStep('continue'), id: 'continue', label: 'Continue' },
      { ...defaultTestStep('dialogue-option'), id: 'choice', label: 'Choice', dialogueOption: { optionIndex: 2 } },
      { ...defaultTestStep('navigate'), id: 'navigate', label: 'Navigate', navigate: { direction: 3, target: null } },
      { ...defaultTestStep('select-object'), id: 'select', label: 'Select', selectObject: { object: testObjectRef('lamp') } },
      { ...defaultTestStep('clear-object-selection'), id: 'clear', label: 'Clear' },
      { ...defaultTestStep('run-action'), id: 'action', label: 'Action', runAction: { verb: testVerbRef('look'), objects: [testObjectRef('lamp')] } },
      { ...defaultTestStep('load-save'), id: 'load', label: 'Load', loadSave: { slotId: 'quick', payload: { mode: 'test' } } },
      { ...defaultTestStep('set-entrypoint'), id: 'entrypoint', label: 'Entrypoint', setEntrypoint: { entrypoint: testSceneRef('opening') } },
      { ...defaultTestStep('continue'), id: 'disabled', label: 'Disabled', enabled: false },
    ];
    project.tests.smoke = { id: 'smoke', label: 'Smoke', tags: [], data };

    expect(buildRuntimePlaybackSpecFromAuthoringTest(project, 'smoke').spec).toMatchObject({
      id: 'smoke',
      fixed_delta_seconds: 0.016,
      init: 'setup()',
      check: 'check()',
      steps: [
        { input: 'tick', delta_seconds: 0.25 },
        { input: 'continue' },
        { input: 'dialogue_option', option_index: 2 },
        { input: 'navigate', direction: 3 },
        { input: 'select_object', object_id: 'lamp' },
        { input: 'clear_object_selection' },
        { input: 'run_action', verb_id: 'look', object_ids: ['lamp'] },
        { input: 'load_save', payload: { slot_id: 'quick', payload: { mode: 'test' } } },
        { input: 'set_entrypoint', entity_ref: null },
      ],
    });
  });

  it('serializes every supported assertion type to native playback spelling', () => {
    const project = createAuthoringProject();
    const data = defaultTestData('Smoke');
    data.steps = [{
      ...defaultTestStep('continue'),
      id: 'assertions',
      label: 'Assertions',
      assertions: [
        { ...defaultTestAssertion('mode'), id: 'mode', value: 'dialogue' },
        { ...defaultTestAssertion('current-room'), id: 'room', value: 'foyer' },
        { ...defaultTestAssertion('title'), id: 'title', value: 'Opening' },
        { ...defaultTestAssertion('text-log-contains'), id: 'text', value: 'Hello' },
        { ...defaultTestAssertion('property-equals'), id: 'property', variable: testVariableRef('flag'), expected: true },
        { ...defaultTestAssertion('object-location'), id: 'location', key: 'lamp', entity: testObjectRef('lamp') },
        { ...defaultTestAssertion('inventory-contains'), id: 'inventory', value: 'key' },
        { ...defaultTestAssertion('output-type'), id: 'output', value: 'state' },
        { ...defaultTestAssertion('diagnostic-category'), id: 'diagnostic', value: 'playback' },
        { ...defaultTestAssertion('mode'), id: 'disabled', value: 'ignored', enabled: false },
      ],
    }];
    project.tests.smoke = { id: 'smoke', label: 'Smoke', tags: [], data };

    expect(buildRuntimePlaybackSpecFromAuthoringTest(project, 'smoke').spec).toMatchObject({
      steps: [{
        input: 'continue',
        assertions: [
          { type: 'mode', value: 'dialogue' },
          { type: 'current_room', value: 'foyer' },
          { type: 'title', value: 'Opening' },
          { type: 'text_log_contains', value: 'Hello' },
          { type: 'property_equals', key: 'flag', expected: true },
          { type: 'object_location', key: 'lamp', entity_ref: { id: 'lamp' } },
          { type: 'inventory_contains', value: 'key' },
          { type: 'output_type', value: 'state' },
          { type: 'diagnostic_category', value: 'playback' },
        ],
      }],
    });
  });

  it('explains current authoring-to-runtime conversion limitations', () => {
    const project = createAuthoringProject();
    project.scenes.opening = { id: 'opening', label: 'Opening', tags: [], data: defaultSceneData('Opening') };
    const data = defaultTestData('Smoke');
    data.entrypoint = testSceneRef('opening');
    project.tests.smoke = { id: 'smoke', label: 'Smoke', tags: [], data };

    expect(getAuthoringTestRunReadiness(project, 'smoke')).toMatchObject({
      runnable: false,
      reason: 'not-runnable-authoring-conversion-missing',
      diagnostics: [expect.objectContaining({ category: 'authoring-test-playback' })],
    });
  });

  it('serializes ui-click steps to the UI playback runner with an exported runtime project', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', tags: [], data: defaultRoomData('Foyer') };
    project.entrypoint = { collection: 'rooms', id: 'foyer' };
    const data = defaultTestData('Title Start');
    data.steps = [{
      ...defaultTestStep('ui-click'),
      id: 'title-start',
      label: 'Title Start',
      uiClick: { documentId: 'runtime_title', target: '#nt-title-start', selector: '#nt-title-start' },
    }];
    project.tests.smoke = { id: 'smoke', label: 'Smoke', tags: [], data };

    const result = buildRuntimePlaybackSpecFromAuthoringTest(project, 'smoke');

    expect(result).toMatchObject({
      ok: true,
      runner: 'runtime-ui',
      spec: {
        id: 'smoke',
        steps: [{ input: 'ui_click', document_id: 'runtime_title', target: '#nt-title-start', selector: '#nt-title-start' }],
      },
    });
    expect(result.project).toMatchObject({ room: { foyer: expect.any(Array) }, entrypoint: [3, 'foyer'] });
    expect(getAuthoringTestRunReadiness(project, 'smoke')).toMatchObject({ runnable: true, reason: 'runnable' });
  });
});
