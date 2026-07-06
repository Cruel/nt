import { describe, expect, it } from 'vitest';
import { createInitialCommandBusState, executeCommand, undoCommand } from '@/commands/command-bus';
import { toJsonValue } from '@/project/json-value';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';

describe('layout commands', () => {
  it('patches valid layout data and rejects invalid data', () => {
    const project = createAuthoringProject();
    project.layouts.main = { id: 'main', label: 'Main UI', tags: [], data: defaultLayoutData('Main UI') };
    let state = createInitialCommandBusState(toJsonValue(project));

    const invalid = executeCommand(state, {
      type: 'layout.replaceData',
      payload: { layoutId: 'main', data: { kind: 'layout', rml: { sourceMode: 'inline', sourceText: '' } } },
    });
    expect(invalid.ok).toBe(false);

    const next = { ...defaultLayoutData('Main UI'), target: 'dialogue-ui' as const };
    const valid = executeCommand(state, {
      type: 'layout.replaceData',
      label: 'Set layout target',
      payload: { layoutId: 'main', data: next },
    });
    expect(valid.ok).toBe(true);
    expect(valid.document).toMatchObject({ layouts: { main: { data: { target: 'dialogue-ui' } } } });

    state = valid.state;
    expect(undoCommand(state).document).toMatchObject({ layouts: { main: { data: { target: 'default-ui' } } } });
  });
});
