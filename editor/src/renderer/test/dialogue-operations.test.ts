import { describe, expect, it } from 'vite-plus/test';
import { createInitialCommandBusState, executeCommand, undoCommand } from './command-test-utils';
import { toJsonValue } from '@/project/json-value';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  defaultDialogueBlock,
  defaultDialogueData,
} from '../../shared/project-schema/authoring-dialogues';
import { inlineTextContent } from '../../shared/project-schema/authoring-flow';
import { structuredMessageId } from '../../shared/authoring-structured-messages';
import { testTranslation } from './fixtures/localization-workflow';

describe('dialogue commands', () => {
  it('creates strict Dialogue data through entity.createRecord', () => {
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

  it('preserves structured Message identity for an explicit segment rename', () => {
    const project = createAuthoringProject();
    const dialogue = defaultDialogueData('Intro');
    const block = dialogue.blocks[0];
    if (block?.type !== 'sequence' || block.segments[0]?.type !== 'line')
      throw new Error('Expected default dialogue line.');
    block.segments[0].text = inlineTextContent('Hello.');
    const oldSegmentId = block.segments[0].id;
    project.dialogues.intro = { id: 'intro', label: 'Intro', data: dialogue };
    project.localization.locales.fr = { supported: false, parentLocale: null };
    const oldPrefix = `/dialogues/intro/data/blocks/@${block.id}/segments/@${oldSegmentId}`;
    const messageId = structuredMessageId(`${oldPrefix}/text`);
    const translation = testTranslation('Bonjour.');
    project.localization.translations.fr = { [messageId]: translation };

    const renamed = structuredClone(dialogue);
    const renamedBlock = renamed.blocks[0];
    if (renamedBlock?.type !== 'sequence' || !renamedBlock.segments[0])
      throw new Error('Expected cloned dialogue line.');
    renamedBlock.segments[0].id = 'welcome-line';
    const newPrefix = `/dialogues/intro/data/blocks/@${block.id}/segments/@welcome-line`;
    const result = executeCommand(createInitialCommandBusState(toJsonValue(project)), {
      type: 'dialogue.replaceData',
      payload: {
        dialogueId: 'intro',
        data: renamed,
        semanticOwnerMoves: [{ fromPrefix: oldPrefix, toPrefix: newPrefix }],
      },
    });

    expect(result.ok, JSON.stringify(result.diagnostics, null, 2)).toBe(true);
    expect(result.document).toMatchObject({
      localization: {
        structuredMessageIds: { [`${newPrefix}/text`]: messageId },
        translations: { fr: { [messageId]: translation } },
      },
    });
  });

  it('patches valid Dialogue data and rejects invalid block/edge combinations', () => {
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
