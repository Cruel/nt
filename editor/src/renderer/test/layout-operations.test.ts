import { describe, expect, it } from 'vite-plus/test';
import { createInitialCommandBusState, executeCommand, undoCommand } from './command-test-utils';
import { toJsonValue } from '@/project/json-value';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';

describe('layout commands', () => {
  it('produces undoable layout patch intents; native admission validates semantic data', () => {
    const project = createAuthoringProject();
    project.layouts.main = { id: 'main', label: 'Main UI', data: defaultLayoutData('Main UI') };
    let state = createInitialCommandBusState(toJsonValue(project));

    const next = { ...defaultLayoutData('Main UI'), target: 'dialogue-ui' as const };
    const valid = executeCommand(state, {
      type: 'layout.replaceData',
      label: 'Set layout target',
      payload: { layoutId: 'main', data: next },
    });
    expect(valid.ok).toBe(true);
    expect(valid.document).toMatchObject({
      layouts: { main: { data: { target: 'dialogue-ui' } } },
    });

    state = valid.state;
    expect(undoCommand(state).document).toMatchObject({
      layouts: { main: { data: { target: 'default-ui' } } },
    });
  });
});
