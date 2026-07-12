import { describe, expect, it } from 'vitest';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultVariableData } from '../../shared/project-schema/authoring-variables';
import { createInitialCommandBusState, executeCommand, undoCommand } from '@/commands/command-bus';
import { toJsonValue } from '@/project/json-value';

describe('variable commands', () => {
  it('patches valid variable data and rejects invalid defaults', () => {
    const project = createAuthoringProject();
    project.variables.score = { id: 'score', label: 'Score', data: defaultVariableData('integer') };
    let state = createInitialCommandBusState(toJsonValue(project));

    const invalid = executeCommand(state, {
      type: 'variable.setDefaultValue',
      payload: { variableId: 'score', defaultValue: 1.5 },
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.diagnostics[0]).toMatchObject({ path: '/variables/score/data/defaultValue' });

    const valid = executeCommand(state, {
      type: 'variable.setDefaultValue',
      label: 'Set score default',
      payload: { variableId: 'score', defaultValue: 3 },
    });
    expect(valid.ok).toBe(true);
    expect(valid.projectChanged).toBe(true);
    expect(valid.document).toMatchObject({ variables: { score: { data: { defaultValue: 3 } } } });

    state = valid.state;
    const undone = undoCommand(state);
    expect(undone.document).toMatchObject({ variables: { score: { data: { defaultValue: 0 } } } });
  });

  it('uses the variable ID as the canonical runtime name', () => {
    const project = createAuthoringProject();
    project.variables['has-key'] = { id: 'has-key', label: 'Has Key', data: defaultVariableData('boolean') };
    expect(project.variables['has-key']?.data).not.toHaveProperty('runtimeName');
  });
});
