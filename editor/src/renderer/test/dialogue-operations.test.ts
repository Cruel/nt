import { describe, expect, it } from 'vite-plus/test';
import { createInitialCommandBusState, executeCommand, undoCommand } from '@/commands/command-bus';
import { toJsonValue } from '@/project/json-value';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  defaultDialogueBlock,
  defaultDialogueData,
} from '../../shared/project-schema/authoring-dialogues';
import { inlineTextContent } from '../../shared/project-schema/authoring-flow';

describe('dialogue commands', () => {
  it('creates strict Dialogue V2 data through entity.createRecord', () => {
    const project = createAuthoringProject();
    const result = executeCommand(createInitialCommandBusState(toJsonValue(project)), {
      type: 'entity.createRecord',
      payload: { collection: 'dialogues', entityId: 'intro', label: 'Intro' },
    });

    expect(result.ok).toBe(true);
    expect(result.document).toMatchObject({
      dialogues: {
        intro: {
          data: {
            kind: 'dialogue',
            entryBlockId: 'start',
            blocks: [{ type: 'sequence' }],
            completion: { kind: 'end' },
          },
        },
      },
    });
  });

  it('patches valid Dialogue V2 data and rejects invalid block/edge combinations', () => {
    const project = createAuthoringProject();
    project.dialogues.intro = { id: 'intro', label: 'Intro', data: defaultDialogueData('Intro') };
    let state = createInitialCommandBusState(toJsonValue(project));

    const invalidData = defaultDialogueData('Intro');
    invalidData.blocks.push(defaultDialogueBlock('choice', 'decision', 'Decision'));
    invalidData.edges = [
      {
        id: 'invalid-choice',
        kind: 'choice',
        fromBlockId: 'start',
        toBlockId: 'decision',
        label: inlineTextContent('Choose'),
        effects: [],
        logged: true,
        autosaveSafePoint: false,
      },
    ];
    const invalid = executeCommand(state, {
      type: 'dialogue.replaceData',
      payload: { dialogueId: 'intro', data: invalidData },
    });
    expect(invalid.ok).toBe(false);

    const next = defaultDialogueData('Intro');
    const start = next.blocks[0]!;
    if (start.type !== 'sequence' || start.segments[0]?.type !== 'line')
      throw new Error('Expected default line.');
    start.segments[0].text = inlineTextContent('Welcome to the intro.');
    const valid = executeCommand(state, {
      type: 'dialogue.replaceData',
      label: 'Set dialogue line',
      payload: { dialogueId: 'intro', data: next },
    });
    expect(valid.ok).toBe(true);
    expect(valid.document).toMatchObject({
      dialogues: {
        intro: {
          data: {
            blocks: [{ segments: [{ text: { source: { text: 'Welcome to the intro.' } } }] }],
          },
        },
      },
    });

    state = valid.state;
    expect(undoCommand(state).document).toMatchObject({
      dialogues: {
        intro: { data: { blocks: [{ segments: [{ text: { source: { text: '' } } }] }] } },
      },
    });
  });
});
