import { describe, expect, it } from 'vitest';
import { createInitialCommandBusState, executeCommand, undoCommand } from '@/commands/command-bus';
import { toJsonValue } from '@/project/json-value';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultTestData } from '../../shared/project-schema/authoring-tests';
import { recordedTestDraftToTestData } from '../../shared/project-schema/recorded-test-draft';

describe('recorded test draft conversion', () => {
  it('lowers runtime semantic inputs to existing authoring test step types', () => {
    const result = recordedTestDraftToTestData({
      actions: [
        { id: 'continue-1', kind: 'continue', label: 'Continue', input: { type: 'continue' } },
        { id: 'choice-1', kind: 'dialogue-option', label: 'Pick option', input: { type: 'dialogue-option', optionIndex: 2 } },
        { id: 'navigate-1', kind: 'navigate', label: 'Go north', input: { type: 'navigate', direction: 1 } },
        { id: 'select-1', kind: 'select-object', label: 'Select lamp', input: { type: 'select-object', objectId: 'lamp' } },
        { id: 'clear-1', kind: 'clear-object-selection', label: 'Clear', input: { type: 'clear-object-selection' } },
        { id: 'action-1', kind: 'run-action', label: 'Look lamp', input: { type: 'run-action', verbId: 'look', objectIds: ['lamp'] } },
      ],
    }, { label: 'Recorded Smoke' });

    expect(result.ok).toBe(true);
    expect(result.skippedActionCount).toBe(0);
    expect(result.data).toMatchObject({
      kind: 'test',
      displayName: 'Recorded Smoke',
      steps: [
        { id: 'start', input: 'tick' },
        { id: 'continue-1', input: 'continue', label: 'Continue' },
        { id: 'choice-1', input: 'dialogue-option', dialogueOption: { optionIndex: 2 } },
        { id: 'navigate-1', input: 'navigate', navigate: { direction: 1, target: null } },
        { id: 'select-1', input: 'select-object', selectObject: { object: { $ref: { collection: 'objects', id: 'lamp' } } } },
        { id: 'clear-1', input: 'clear-object-selection' },
        { id: 'action-1', input: 'run-action', runAction: { verb: { $ref: { collection: 'verbs', id: 'look' } }, objects: [{ $ref: { collection: 'objects', id: 'lamp' } }] } },
      ],
      preview: { selectedStepId: 'continue-1' },
    });
  });

  it('does not persist ui-click steps until UI playback is in the editor test path', () => {
    const result = recordedTestDraftToTestData({
      actions: [
        { id: 'title-click', kind: 'ui-click', label: 'Click Start', input: { type: 'ui-click' } },
        { id: 'continue-1', kind: 'continue', label: 'Continue', input: { type: 'continue' } },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.skippedActionCount).toBe(1);
    expect(result.diagnostics).toContain("Skipped unsupported recorded input 'ui-click'.");
    expect(result.data.steps.map((step) => step.input)).toEqual(['tick', 'continue']);
  });

  it('normalizes runtime action ids into valid authoring step ids', () => {
    const result = recordedTestDraftToTestData({
      actions: [{ id: '9D7327AF-CLICK', kind: 'continue', label: 'Continue', input: { type: 'continue' } }],
    });

    expect(result.data.steps[1]?.id).toBe('recorded-9d7327af-click');
  });

  it('can be saved as new or applied to existing tests through the command bus', () => {
    const project = createAuthoringProject();
    project.tests.existing = { id: 'existing', label: 'Existing', tags: [], data: defaultTestData('Existing') };
    let state = createInitialCommandBusState(toJsonValue(project));
    const data = recordedTestDraftToTestData({
      actions: [{ id: 'continue-1', kind: 'continue', label: 'Continue', input: { type: 'continue' } }],
    }, { label: 'Recorded' }).data;

    const created = executeCommand(state, {
      type: 'entity.createRecord',
      label: 'Create recorded test',
      payload: { collection: 'tests', entityId: 'recorded', label: 'Recorded', data },
    });
    expect(created.ok).toBe(true);
    expect(created.document).toMatchObject({ tests: { recorded: { data: { steps: [{ input: 'tick' }, { input: 'continue' }] } } } });

    state = created.state;
    const applied = executeCommand(state, {
      type: 'test.replaceData',
      label: 'Apply recording to existing test',
      payload: { testId: 'existing', data },
    });
    expect(applied.ok).toBe(true);
    expect(applied.document).toMatchObject({ tests: { existing: { data: { displayName: 'Recorded', steps: [{ input: 'tick' }, { input: 'continue' }] } } } });
    expect(undoCommand(applied.state).document).toMatchObject({ tests: { existing: { data: { displayName: 'Existing', steps: [{ input: 'tick' }] } } } });
  });
});
