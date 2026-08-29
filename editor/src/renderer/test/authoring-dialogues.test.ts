import { describe, expect, it } from 'vite-plus/test';
import { assetDataFromImportMetadata } from '../../shared/project-schema/authoring-assets';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import {
  defaultDialogueBlock,
  defaultDialogueData,
  defaultDialogueSegment,
  dialogueCharacterRef,
  dialogueDataSchema,
  validateDialogueData,
  type DialogueLineCue,
} from '../../shared/project-schema/authoring-dialogues';
import { inlineTextContent } from '../../shared/project-schema/authoring-flow';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultSceneData } from '../../shared/project-schema/authoring-scenes';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import {
  parseDialogueCueMarkup,
  serializeDialogueCueMarkup,
} from '../../shared/project-schema/dialogue-cue-markup';
import {
  buildDialoguePreviewDocumentData,
  dialoguePreviewRevision,
} from '../../shared/project-schema/dialogue-project';

describe('authoring dialogues schema', () => {
  it('round-trips ActiveText and semantic markup through one positioned cue model', () => {
    const source =
      '[b]Hi[nt-cue id=pose kind=speaker-expression data=%7B%22expressionId%22%3A%22angry%22%7D] there[/b]';
    const parsed = parseDialogueCueMarkup(source);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.text).toBe('Hi there');
    expect(parsed.cues).toEqual([
      expect.objectContaining({
        kind: 'active-text',
        position: { offset: 0, order: 0 },
        token: '[b]',
      }),
      expect.objectContaining({
        id: 'pose',
        kind: 'speaker-expression',
        position: { offset: 2, order: 0 },
        expressionId: 'angry',
      }),
      expect.objectContaining({
        kind: 'active-text',
        position: { offset: 8, order: 0 },
        token: '[/b]',
      }),
    ]);
    expect(serializeDialogueCueMarkup(parsed.text, parsed.cues)).toBe(source);
  });

  it('retains malformed source markup as an actionable invalid cue', () => {
    const parsed = parseDialogueCueMarkup('Hello [nt-cue id=broken]');
    expect(parsed.text).toBe('Hello ');
    expect(parsed.diagnostics).toEqual([
      expect.objectContaining({
        offset: 6,
        message: expect.stringContaining('requires id, kind, and data'),
      }),
    ]);
    expect(parsed.cues).toEqual([
      expect.objectContaining({
        kind: 'invalid-markup',
        position: { offset: 6, order: 0 },
        token: '[nt-cue id=broken]',
      }),
    ]);
    expect(serializeDialogueCueMarkup(parsed.text, parsed.cues)).toBe('Hello [nt-cue id=broken]');

    const project = createAuthoringProject();
    const data = defaultDialogueData('Intro');
    const block = data.blocks[0]!;
    if (block.type !== 'sequence' || block.segments[0]?.type !== 'line')
      throw new Error('Expected default line.');
    block.segments[0].text = inlineTextContent(parsed.text);
    block.segments[0].cues = parsed.cues;
    project.dialogues.intro = { id: 'intro', label: 'Intro', data };
    expect(validateDialogueData(project, 'intro', project.dialogues.intro)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/dialogues/intro/data/blocks/0/segments/0/cues/0',
          severity: 'error',
          message: expect.stringContaining('Malformed Dialogue markup'),
        }),
      ]),
    );
  });

  it('round-trips and validates Voice SFX and camera cues through preview dependencies', () => {
    const project = createAuthoringProject();
    project.assets.voice = {
      id: 'voice',
      label: 'Voice',
      data: assetDataFromImportMetadata({
        kind: 'audio',
        projectRelativePath: 'assets/audio/voice.ogg',
        extension: '.ogg',
        byteSize: 10,
        contentHash: 'voice-hash-a',
        importedAt: '2026-01-01T00:00:00.000Z',
        originalName: 'voice.ogg',
        originalPath: '/tmp/voice.ogg',
        imageMetadata: null,
      }),
    };
    const data = defaultDialogueData('Intro');
    const block = data.blocks[0]!;
    if (block.type !== 'sequence' || block.segments[0]?.type !== 'line')
      throw new Error('Expected default line.');
    block.segments[0].text = inlineTextContent('ABCDE');
    const cues: DialogueLineCue[] = [
      {
        id: 'voice',
        kind: 'voice',
        position: { offset: 1, order: 0 },
        asset: { $ref: { collection: 'assets', id: 'voice' } },
        pausePolicy: 'gameplay',
        gain: 0.8,
        pan: -0.2,
        waitForCompletion: true,
        skipBehavior: 'stop',
      },
      {
        id: 'sfx',
        kind: 'sound-effect',
        position: { offset: 2, order: 0 },
        asset: { $ref: { collection: 'assets', id: 'voice' } },
        pausePolicy: 'owner',
        gain: 0.5,
        pan: 0.25,
        waitForCompletion: false,
        causality: 'disposable',
        synchronized: false,
        skipBehavior: 'suppress',
      },
      {
        id: 'camera',
        kind: 'camera',
        position: { offset: 3, order: 0 },
        emphasis: {
          kind: 'shake',
          amplitude: { x: 4, y: 2 },
          frequencyHz: 12,
          durationMs: 150,
          skippable: true,
          waitForCompletion: false,
        },
      },
    ];
    block.segments[0].cues = cues;
    project.dialogues.intro = { id: 'intro', label: 'Intro', data };

    expect(validateDialogueData(project, 'intro', project.dialogues.intro)).toEqual([]);
    const source = serializeDialogueCueMarkup('ABCDE', cues);
    const parsed = parseDialogueCueMarkup(source);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.text).toBe('ABCDE');
    expect(parsed.cues).toEqual(cues);
    expect(buildDialoguePreviewDocumentData(project, 'intro')).toMatchObject({
      selectedSegment: { cues },
    });

    const before = dialoguePreviewRevision(project, 'intro');
    project.assets.voice = {
      ...project.assets.voice,
      data: assetDataFromImportMetadata({
        kind: 'audio',
        projectRelativePath: 'assets/audio/voice.ogg',
        extension: '.ogg',
        byteSize: 11,
        contentHash: 'voice-hash-b',
        importedAt: '2026-01-01T00:00:00.000Z',
        originalName: 'voice.ogg',
        originalPath: '/tmp/voice.ogg',
        imageMetadata: null,
      }),
    };
    expect(dialoguePreviewRevision(project, 'intro')).not.toBe(before);

    const sfx = cues.find(
      (cue): cue is Extract<DialogueLineCue, { kind: 'sound-effect' }> =>
        cue.kind === 'sound-effect',
    );
    if (!sfx) throw new Error('Expected SFX cue.');
    block.segments[0].cues = [{ ...sfx, waitForCompletion: true }];
    expect(validateDialogueData(project, 'intro', project.dialogues.intro)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/dialogues/intro/data/blocks/0/segments/0/cues/0/causality',
          severity: 'error',
        }),
      ]),
    );
  });

  it('provides strict dialogue defaults without editor state', () => {
    expect(defaultDialogueData('Intro')).toEqual({
      kind: 'dialogue',
      displayName: 'Intro',
      defaultSpeaker: null,
      stageSlots: [],
      mediaSlots: [],
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
              cues: [],
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

  it('validates retained Stage and Media Slots plus sparse line cues', () => {
    const project = createAuthoringProject();
    project.characters.iris = { id: 'iris', label: 'Iris', data: defaultCharacterData('Iris') };
    const data = defaultDialogueData('Intro');
    data.defaultSpeaker = dialogueCharacterRef('iris');
    data.stageSlots = [
      {
        id: 'left-speaker',
        label: 'Left speaker',
        speakerSync: true,
        initial: {
          character: dialogueCharacterRef('iris'),
          profileId: 'stage',
          poseId: 'default',
          expressionId: 'neutral',
          appearanceId: null,
          position: 'left',
          offset: { x: 12, y: -4 },
          scale: 1,
          visible: true,
        },
      },
    ];
    data.mediaSlots = [
      {
        id: 'portrait',
        label: 'Portrait',
        visible: true,
        initial: {
          kind: 'character',
          character: dialogueCharacterRef('iris'),
          profileId: 'stage',
          poseId: 'default',
          expressionId: 'neutral',
          appearanceId: null,
        },
      },
    ];
    const start = data.blocks[0]!;
    if (start.type !== 'sequence' || start.segments[0]?.type !== 'line')
      throw new Error('Expected default line.');
    start.segments[0].text = inlineTextContent('Welcome.');
    start.segments[0].cues = [
      {
        id: 'speaker-expression',
        kind: 'speaker-expression',
        position: { offset: 0, order: 0 },
        expressionId: 'neutral',
      },
      {
        id: 'stage-update',
        kind: 'stage',
        position: { offset: 0, order: 1 },
        mutation: { slotId: 'left-speaker', action: 'update', position: 'center', scale: 1.1 },
      },
      {
        id: 'stage-show',
        kind: 'stage',
        position: { offset: 0, order: 2 },
        mutation: { slotId: 'left-speaker', action: 'show' },
      },
      {
        id: 'media-hide',
        kind: 'media',
        position: { offset: 0, order: 3 },
        mutation: { slotId: 'portrait', action: 'hide' },
      },
    ];
    project.dialogues.intro = { id: 'intro', label: 'Intro', data };

    expect(validateDialogueData(project, 'intro', project.dialogues.intro)).toEqual([]);
    expect(buildDialoguePreviewDocumentData(project, 'intro')).toMatchObject({
      stageSlots: [expect.objectContaining({ id: 'left-speaker', speakerSync: true })],
      mediaSlots: [expect.objectContaining({ id: 'portrait', visible: true })],
      selectedSegment: expect.objectContaining({
        cues: expect.arrayContaining([
          expect.objectContaining({ kind: 'stage', id: 'stage-update' }),
          expect.objectContaining({ kind: 'media', id: 'media-hide' }),
        ]),
      }),
    });

    start.segments[0].cues = [
      {
        id: 'bad-stage',
        kind: 'stage',
        position: { offset: 0, order: 0 },
        mutation: { slotId: 'missing-slot', action: 'hide' },
      },
    ];
    expect(validateDialogueData(project, 'intro', project.dialogues.intro)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/dialogues/intro/data/blocks/0/segments/0/cues/0/mutation/slotId',
          severity: 'error',
        }),
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

  it('builds preview documents from editor-owned selection', () => {
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
      schema: 'noveltea.dialogue-preview',
      dialogueId: 'intro',
      selectedBlockId: 'decision',
      choices: [expect.objectContaining({ targetLabel: 'Sequence' })],
      preview: { background: 'checker' },
    });
  });

  it('validates and previews Dialogue child Scene and Handoff segments', () => {
    const project = createAuthoringProject();
    const scene = defaultSceneData('Child');
    scene.inputs = [
      { id: 'flag', label: 'Flag', type: 'boolean', nullable: false },
      { id: 'note', label: 'Note', type: 'string', nullable: true },
    ];
    project.scenes.child = { id: 'child', label: 'Child', data: scene };
    const data = defaultDialogueData('Intro');
    const block = data.blocks[0]!;
    if (block.type !== 'sequence') throw new Error('Expected default Sequence block.');
    block.segments = [
      {
        ...defaultDialogueSegment('call-scene', 'child-call'),
        scene: { $ref: { collection: 'scenes', id: 'child' } },
        inputs: [{ inputId: 'flag', value: true }],
        uiPolicy: 'preserve',
      },
      { ...defaultDialogueSegment('handoff', 'handoff'), payload: 'token' },
    ];
    project.dialogues.intro = { id: 'intro', label: 'Intro', data };

    expect(validateDialogueData(project, 'intro', project.dialogues.intro)).toEqual([]);
    expect(
      buildDialoguePreviewDocumentData(project, 'intro', {
        selectedBlockId: block.id,
        selectedSegmentId: 'child-call',
      }),
    ).toMatchObject({
      selectedSegment: {
        id: 'child-call',
        type: 'call-scene',
        scene: { $ref: { collection: 'scenes', id: 'child' } },
        inputs: [{ inputId: 'flag', value: true }],
        uiPolicy: 'preserve',
      },
    });

    if (block.segments[0]?.type !== 'call-scene') throw new Error('Expected child Scene segment.');
    block.segments[0] = {
      ...block.segments[0],
      inputs: [
        { inputId: 'flag', value: 'wrong' },
        { inputId: 'missing', value: true },
      ],
    };
    expect(validateDialogueData(project, 'intro', project.dialogues.intro)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringContaining('/inputs/0/value'),
          severity: 'error',
        }),
        expect.objectContaining({
          path: expect.stringContaining('/inputs/1/inputId'),
          severity: 'error',
        }),
      ]),
    );
  });
});
