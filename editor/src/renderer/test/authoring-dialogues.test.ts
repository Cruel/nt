import { describe, expect, it } from 'vitest';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  defaultDialogueData,
  dialogueCharacterRef,
  validateDialogueData,
} from '../../shared/project-schema/authoring-dialogues';
import { buildDialoguePreviewDocumentData, dialoguePreviewRevision } from '../../shared/project-schema/dialogue-project';

describe('authoring dialogues schema', () => {
  it('provides typed dialogue defaults', () => {
    expect(defaultDialogueData('Intro')).toMatchObject({
      kind: 'dialogue',
      displayName: 'Intro',
      entryBlockId: 'start',
      blocks: [{ id: 'start', segments: [{ id: 'line-1', type: 'line' }] }],
      preview: { selectedBlockId: 'start', selectedSegmentId: 'line-1' },
    });
  });

  it('validates dialogue dependencies and graph IDs', () => {
    const project = createAuthoringProject();
    project.dialogues.intro = { id: 'intro', label: 'Intro', tags: [], data: defaultDialogueData('Intro') };
    const data = defaultDialogueData('Intro');
    data.defaultSpeaker = dialogueCharacterRef('missing-character');
    data.entryBlockId = 'missing-entry';
    data.blocks = [
      ...data.blocks,
      { ...data.blocks[0]!, id: 'start', label: 'Duplicate Start' },
      { ...data.blocks[0]!, id: 'orphan', label: 'Orphan', segments: [] },
    ];
    data.blocks[0]!.segments = [
      data.blocks[0]!.segments[0]!,
      { ...data.blocks[0]!.segments[0]!, id: 'line-1' },
    ];
    data.edges = [
      { id: 'choice', fromBlockId: 'start', toBlockId: 'missing-target', kind: 'choice', label: '', order: 0, condition: { enabled: false, source: '' }, script: { enabled: false, source: '' } },
      { id: 'choice', fromBlockId: 'start', toBlockId: 'start', kind: 'next', label: '', order: 0, condition: { enabled: false, source: '' }, script: { enabled: false, source: '' } },
    ];
    project.dialogues.intro.data = data;

    expect(validateDialogueData(project, 'intro', project.dialogues.intro)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/dialogues/intro/data/defaultSpeaker/$ref', severity: 'error' }),
      expect.objectContaining({ path: '/dialogues/intro/data/entryBlockId', severity: 'error' }),
      expect.objectContaining({ path: '/dialogues/intro/data/blocks/1/id', severity: 'error' }),
      expect.objectContaining({ path: '/dialogues/intro/data/blocks/0/segments/1/id', severity: 'error' }),
      expect.objectContaining({ path: '/dialogues/intro/data/edges/0/toBlockId', severity: 'error' }),
      expect.objectContaining({ path: '/dialogues/intro/data/edges/1/id', severity: 'error' }),
      expect.objectContaining({ path: '/dialogues/intro/data/edges/0/label', severity: 'warning' }),
    ]));
  });

  it('reports warning-only dialogue diagnostics through project validation', () => {
    const project = createAuthoringProject();
    project.dialogues.intro = { id: 'intro', label: 'Intro', tags: [], data: defaultDialogueData('Intro') };

    expect(validateAuthoringProject(project)).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'authoring-dialogues', path: '/dialogues/intro/data/blocks/0/segments/0/text/source', severity: 'warning' }),
    ]));
  });

  it('builds dialogue preview documents with dependency revisions', () => {
    const project = createAuthoringProject();
    project.characters.iris = { id: 'iris', label: 'Iris', tags: [], data: defaultCharacterData('Iris') };
    const data = defaultDialogueData('Intro');
    data.defaultSpeaker = dialogueCharacterRef('iris');
    data.blocks[0]!.segments[0]!.text.source = 'Welcome.';
    data.blocks.push({
      id: 'choice-result',
      type: 'linear',
      label: 'Choice Result',
      defaultSpeaker: null,
      segments: [{ ...data.blocks[0]!.segments[0]!, id: 'line-2', text: { mode: 'plain', source: 'You chose well.' } }],
      link: { targetBlockId: null },
      graph: { x: 240, y: 0 },
    });
    data.edges = [{ id: 'choice', fromBlockId: 'start', toBlockId: 'choice-result', kind: 'choice', label: 'Continue', order: 0, condition: { enabled: false, source: '' }, script: { enabled: false, source: '' } }];
    project.dialogues.intro = { id: 'intro', label: 'Intro', tags: [], data };

    expect(dialoguePreviewRevision(project, 'intro')).toContain('iris');
    expect(buildDialoguePreviewDocumentData(project, 'intro')).toMatchObject({
      schema: 'noveltea.dialogue-preview.v1',
      dialogueId: 'intro',
      selectedBlock: {
        id: 'start',
        segments: [expect.objectContaining({ speakerMetadata: expect.objectContaining({ id: 'iris' }) })],
      },
      choices: [expect.objectContaining({ label: 'Continue', targetLabel: 'Choice Result' })],
    });
  });
});
