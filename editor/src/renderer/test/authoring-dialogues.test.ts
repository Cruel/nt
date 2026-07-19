import { describe, expect, it } from 'vite-plus/test';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import {
  defaultDialogueBlock,
  defaultDialogueData,
  defaultDialogueSegment,
  dialogueCharacterRef,
  dialogueDataSchema,
  validateDialogueData,
} from '../../shared/project-schema/authoring-dialogues';
import { inlineTextContent } from '../../shared/project-schema/authoring-flow';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import {
  buildDialoguePreviewDocumentData,
  dialoguePreviewRevision,
} from '../../shared/project-schema/dialogue-project';

describe('authoring dialogues schema', () => {
  it('provides strict V2 dialogue defaults without editor state', () => {
    expect(defaultDialogueData('Intro')).toEqual({
      kind: 'dialogue',
      displayName: 'Intro',
      defaultSpeaker: null,
      settings: { showDisabledChoices: true, logMode: 'everything' },
      entryBlockId: 'start',
      blocks: [
        {
          id: 'start',
          type: 'sequence',
          label: 'Sequence',
          defaultSpeaker: null,
          segments: [
            {
              id: 'line-1',
              type: 'line',
              speaker: null,
              text: inlineTextContent(),
              effects: [],
              showOnce: false,
              logged: true,
              autosaveSafePoint: false,
            },
          ],
        },
      ],
      edges: [],
      completion: { kind: 'end' },
    });
  });

  it('rejects legacy shapes and mismatched nested payloads', () => {
    const legacy = {
      ...defaultDialogueData('Intro'),
      settings: {
        showDisabledChoices: true,
        allowDisabledChoiceSelection: false,
        logMode: 'everything',
      },
      preview: { selectedBlockId: 'start' },
    };
    expect(dialogueDataSchema.safeParse(legacy).success).toBe(false);

    const mismatched = defaultDialogueData('Intro') as unknown as Record<string, unknown>;
    mismatched.blocks = [{ id: 'start', type: 'choice', label: 'Choice', segments: [] }];
    expect(dialogueDataSchema.safeParse(mismatched).success).toBe(false);
  });

  it('enforces block and edge semantics plus redirect cycle rejection', () => {
    const project = createAuthoringProject();
    const data = defaultDialogueData('Intro');
    data.blocks = [
      defaultDialogueBlock('sequence', 'start', 'Start'),
      defaultDialogueBlock('choice', 'decision', 'Decision'),
      {
        ...defaultDialogueBlock('redirect', 'redirect-a', 'Redirect A'),
        targetBlockId: 'redirect-b',
      },
      {
        ...defaultDialogueBlock('redirect', 'redirect-b', 'Redirect B'),
        targetBlockId: 'redirect-a',
      },
    ];
    data.edges = [
      {
        id: 'wrong-choice',
        kind: 'choice',
        fromBlockId: 'start',
        toBlockId: 'decision',
        label: inlineTextContent('Choose'),
        effects: [],
        logged: true,
        autosaveSafePoint: false,
      },
      { id: 'wrong-next', kind: 'next', fromBlockId: 'decision', toBlockId: 'start' },
    ];
    project.dialogues.intro = { id: 'intro', label: 'Intro', data };

    expect(validateDialogueData(project, 'intro', project.dialogues.intro)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/dialogues/intro/data/blocks/0', severity: 'error' }),
        expect.objectContaining({ path: '/dialogues/intro/data/blocks/1', severity: 'error' }),
        expect.objectContaining({
          path: '/dialogues/intro/data/blocks',
          message: expect.stringContaining('Redirect-only cycle'),
          severity: 'error',
        }),
      ]),
    );
  });

  it('validates speakers, stable nested IDs, choice policy, and completion targets', () => {
    const project = createAuthoringProject();
    const data = defaultDialogueData('Intro');
    const line = defaultDialogueSegment('line', 'line-1');
    data.defaultSpeaker = dialogueCharacterRef('missing-character');
    data.blocks = [
      { ...defaultDialogueBlock('sequence', 'start', 'Start'), segments: [line, { ...line }] },
      defaultDialogueBlock('choice', 'decision', 'Decision'),
    ];
    data.edges = [
      { id: 'next', kind: 'next', fromBlockId: 'start', toBlockId: 'decision' },
      {
        id: 'choice',
        kind: 'choice',
        fromBlockId: 'decision',
        toBlockId: 'missing',
        label: inlineTextContent(''),
        effects: [],
        logged: true,
        autosaveSafePoint: true,
      },
    ];
    data.completion = { kind: 'room', id: 'missing-room' };
    project.dialogues.intro = { id: 'intro', label: 'Intro', data };

    expect(validateDialogueData(project, 'intro', project.dialogues.intro)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/dialogues/intro/data/defaultSpeaker',
          severity: 'error',
        }),
        expect.objectContaining({
          path: '/dialogues/intro/data/blocks/0/segments/1/id',
          severity: 'error',
        }),
        expect.objectContaining({
          path: '/dialogues/intro/data/edges/1/toBlockId',
          severity: 'error',
        }),
        expect.objectContaining({ path: '/dialogues/intro/data/edges/1/label', severity: 'error' }),
        expect.objectContaining({ path: '/dialogues/intro/data/completion/id', severity: 'error' }),
      ]),
    );
  });

  it('reports Dialogue diagnostics through project validation', () => {
    const project = createAuthoringProject();
    project.dialogues.intro = { id: 'intro', label: 'Intro', data: defaultDialogueData('Intro') };
    expect(validateAuthoringProject(project)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'Dialogues',
          path: '/dialogues/intro/data/blocks/0/segments/0/text',
          severity: 'warning',
        }),
      ]),
    );
  });

  it('builds V2 preview documents from editor-owned selection', () => {
    const project = createAuthoringProject();
    project.characters.iris = { id: 'iris', label: 'Iris', data: defaultCharacterData('Iris') };
    const data = defaultDialogueData('Intro');
    data.defaultSpeaker = dialogueCharacterRef('iris');
    const start = data.blocks[0]!;
    if (start.type !== 'sequence' || start.segments[0]?.type !== 'line')
      throw new Error('Expected default line.');
    start.segments[0].text = inlineTextContent('Welcome.');
    data.blocks.push(defaultDialogueBlock('choice', 'decision', 'Decision'));
    data.edges = [
      { id: 'next', kind: 'next', fromBlockId: 'start', toBlockId: 'decision' },
      {
        id: 'choice',
        kind: 'choice',
        fromBlockId: 'decision',
        toBlockId: 'start',
        label: inlineTextContent('Again'),
        effects: [],
        logged: true,
        autosaveSafePoint: false,
      },
    ];
    project.dialogues.intro = { id: 'intro', label: 'Intro', data };

    expect(dialoguePreviewRevision(project, 'intro')).toContain('iris');
    expect(
      buildDialoguePreviewDocumentData(project, 'intro', {
        selectedBlockId: 'decision',
        background: 'checker',
      }),
    ).toMatchObject({
      schema: 'noveltea.dialogue-preview.v2',
      dialogueId: 'intro',
      selectedBlockId: 'decision',
      choices: [expect.objectContaining({ targetLabel: 'Sequence' })],
      preview: { background: 'checker' },
    });
  });
});
