import { describe, expect, it } from 'vite-plus/test';
import { createInitialCommandBusState, executeCommand, undoCommand } from './command-test-utils';
import { toJsonValue } from '@/project/json-value';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  defaultTestData,
  defaultTestStep,
  testSceneRef,
} from '../../shared/project-schema/authoring-tests';

describe('test commands', () => {
  it('creates typed test data through entity.createRecord', () => {
    const project = createAuthoringProject();
    const state = createInitialCommandBusState(toJsonValue(project));

    const result = executeCommand(state, {
      type: 'entity.createRecord',
      payload: { collection: 'tests', entityId: 'smoke', label: 'Smoke Test' },
    });

    expect(result.ok).toBe(true);
    expect(result.document).toMatchObject({
      tests: {
        smoke: {
          data: {
            kind: 'test',
            displayName: 'Smoke Test',
            steps: [{ id: 'start', input: 'tick' }],
          },
        },
      },
    });
  });

  it('patches valid test data and rejects error diagnostics', () => {
    const project = createAuthoringProject();
    project.tests.smoke = { id: 'smoke', label: 'Smoke', data: defaultTestData('Smoke') };
    let state = createInitialCommandBusState(toJsonValue(project));

    const invalid = defaultTestData('Smoke');
    invalid.entrypoint = testSceneRef('missing');
    expect(
      executeCommand(state, {
        type: 'test.replaceData',
        payload: { testId: 'smoke', data: invalid },
      }).ok,
    ).toBe(false);

    const next = defaultTestData('Smoke');
    next.displayName = 'Smoke Edited';
    next.steps.push({ ...defaultTestStep('continue'), id: 'continue', label: 'Continue' });
    const valid = executeCommand(state, {
      type: 'test.replaceData',
      label: 'Set test data',
      payload: { testId: 'smoke', data: next },
    });

    expect(valid.ok).toBe(true);
    expect(valid.document).toMatchObject({
      tests: {
        smoke: {
          data: {
            displayName: 'Smoke Edited',
            steps: [expect.anything(), expect.objectContaining({ id: 'continue' })],
          },
        },
      },
    });

    state = valid.state;
    expect(undoCommand(state).document).toMatchObject({
      tests: { smoke: { data: { displayName: 'Smoke' } } },
    });
  });
});
