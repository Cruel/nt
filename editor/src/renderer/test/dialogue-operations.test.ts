import { describe, expect, it } from 'vitest';
import { createInitialCommandBusState, executeCommand, undoCommand } from '@/commands/command-bus';
import { toJsonValue } from '@/project/json-value';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultDialogueData } from '../../shared/project-schema/authoring-dialogues';

describe('dialogue commands', () => {
  it('creates typed dialogue data through entity.createRecord', () => {
    const project = createAuthoringProject();
    const state = createInitialCommandBusState(toJsonValue(project));

    const result = executeCommand(state, {
      type: 'entity.createRecord',
      payload: { collection: 'dialogues', entityId: 'intro', label: 'Intro' },
    });

    expect(result.ok).toBe(true);
    expect(result.document).toMatchObject({
      dialogues: { intro: { data: { kind: 'dialogue', displayName: 'Intro', entryBlockId: 'start', blocks: [{ id: 'start' }] } } },
    });
  });

  it('patches valid dialogue data and rejects error diagnostics', () => {
    const project = createAuthoringProject();
    project.dialogues.intro = { id: 'intro', label: 'Intro', tags: [], data: defaultDialogueData('Intro') };
    let state = createInitialCommandBusState(toJsonValue(project));

    const invalidData = defaultDialogueData('Intro');
    invalidData.edges = [{ id: 'choice', fromBlockId: 'start', toBlockId: 'missing', kind: 'choice', label: 'Missing', order: 0, condition: { enabled: false, source: '' }, script: { enabled: false, source: '' } }];
    const invalid = executeCommand(state, {
      type: 'dialogue.replaceData',
      payload: { dialogueId: 'intro', data: invalidData },
    });
    expect(invalid.ok).toBe(false);

    const next = defaultDialogueData('Intro');
    next.blocks[0]!.segments[0]!.text.source = 'Welcome to the intro.';
    const valid = executeCommand(state, {
      type: 'dialogue.replaceData',
      label: 'Set dialogue line',
      payload: { dialogueId: 'intro', data: next },
    });
    expect(valid.ok).toBe(true);
    expect(valid.document).toMatchObject({ dialogues: { intro: { data: { blocks: [{ segments: [{ text: { source: 'Welcome to the intro.' } }] }] } } } });

    state = valid.state;
    expect(undoCommand(state).document).toMatchObject({ dialogues: { intro: { data: { blocks: [{ segments: [{ text: { source: '' } }] }] } } } });
  });
});
