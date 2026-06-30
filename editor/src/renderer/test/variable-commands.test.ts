import { describe, expect, it } from 'vitest';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultVariableData } from '../../shared/project-schema/authoring-variables';
import { createInitialCommandBusState, executeCommand, undoCommand } from '@/commands/command-bus';
import { toJsonValue } from '@/project/json-value';

describe('variable commands', () => {
  it('patches valid variable data and rejects invalid defaults', () => {
    const project = createAuthoringProject();
    project.variables.score = { id: 'score', label: 'Score', tags: [], data: defaultVariableData('integer') };
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

  it('renames concise variable references through entity rename', () => {
    const project = createAuthoringProject();
    project.variables['has-key'] = { id: 'has-key', label: 'Has Key', tags: [], data: defaultVariableData('boolean') };
    project.scenes.intro = { id: 'intro', label: 'Intro', tags: [], data: { condition: { $var: 'has-key' } } };
    const state = createInitialCommandBusState(toJsonValue(project));

    const renamed = executeCommand(state, {
      type: 'entity.renameId',
      payload: { collection: 'variables', fromId: 'has-key', toId: 'has-badge', label: 'Has Badge' },
    });

    expect(renamed.ok).toBe(true);
    expect(renamed.document).toMatchObject({
      variables: { 'has-badge': { id: 'has-badge', label: 'Has Badge' } },
      scenes: { intro: { data: { condition: { $var: 'has-badge' } } } },
    });
  });
});
