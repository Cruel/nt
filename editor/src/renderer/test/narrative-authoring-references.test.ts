import { describe, expect, it } from 'vite-plus/test';
import { authoringProjectSchema } from '../../shared/project-schema/authoring-project';
import {
  characterRecordSchema,
  dialogueRecordSchema,
  interactionRecordSchema,
  roomRecordSchema,
  sceneRecordSchema,
} from '../../shared/project-schema/authoring-records';
import {
  decodeSparseRecordYaml,
  encodeSparseRecordYaml,
} from '../../shared/project-workspace/sparse-record-yaml-source';
import {
  defaultDialogueBlock,
  defaultDialogueSegment,
} from '../../shared/project-schema/authoring-dialogues';
import { compileAuthoringProjectValue } from '../../shared/authoring-compiler-lowering';
import { canonicalVocabularyGoldenProject } from './fixtures/compiled-project-golden-projects';

const links = ['event.trial', 'milestone.permission-granted'];

// Use a complete valid native-authoring fixture, not a synthetic source that
// would be rejected by the actual compiler for unrelated gameplay reasons.
function withNarrativeLinks() {
  const project = canonicalVocabularyGoldenProject();
  const scene = project.scenes.opening!;
  const dialogue = project.dialogues.intro!;
  const interaction = project.interactions.actions!;
  const room = Object.values(project.rooms)[0]!;
  const character = Object.values(project.characters)[0]!;

  // Many-to-many: one Story Event can be implemented by several definitions,
  // and one definition can fulfill several independent Story obligations.
  scene.narrativeRefs = [...links];
  dialogue.narrativeRefs = ['event.trial'];
  interaction.narrativeRefs = [...links];
  room.narrativeRefs = ['world-entity.tower'];
  character.narrativeRefs = ['character.mara'];
  scene.data.events[0]!.narrativeRefs = ['event.trial'];
  dialogue.data.blocks[0]!.narrativeRefs = ['event.trial'];
  const firstSequence = dialogue.data.blocks.find((block) => block.type === 'sequence');
  if (firstSequence?.type === 'sequence') {
    if (!firstSequence.segments.length) firstSequence.segments.push(defaultDialogueSegment('line'));
    firstSequence.segments[0]!.narrativeRefs = ['authored-content.trial-dialogue'];
  }
  if (dialogue.data.edges.length)
    dialogue.data.edges[0]!.narrativeRefs = ['choice-point.trial-response'];
  interaction.data.rules[0]!.narrativeRefs = ['event.trial'];
  return { project, scene, dialogue, interaction, room, character };
}

describe('optional Story-to-implementation narrative references', () => {
  it('round-trips typed record and nested links through canonical YAML without a Story root', () => {
    const { project, scene, dialogue, interaction, room, character } = withNarrativeLinks();
    expect(authoringProjectSchema.safeParse(project).success).toBe(true);
    for (const [family, record, schema] of [
      ['scenes', scene, sceneRecordSchema],
      ['dialogues', dialogue, dialogueRecordSchema],
      ['interactions', interaction, interactionRecordSchema],
      ['rooms', room, roomRecordSchema],
      ['characters', character, characterRecordSchema],
    ] as const) {
      const yaml = encodeSparseRecordYaml(family, record);
      const reloaded = schema.parse(decodeSparseRecordYaml(family, yaml));
      expect(reloaded).toEqual(schema.parse(record));
      expect(encodeSparseRecordYaml(family, reloaded, yaml)).toEqual(yaml);
    }
    expect(scene.data.events[0]!.id).toBeTruthy();
    expect(dialogue.data.blocks[0]!.id).toBeTruthy();
    expect(interaction.data.rules[0]!.id).toBeTruthy();
  });

  it('rejects malformed typed IDs and unknown metadata instead of accepting untyped extras', () => {
    const { scene, dialogue, interaction } = withNarrativeLinks();
    for (const bad of ['event', 'event.Invalid', 'scene.gameplay-event', 'event.under_score', '']) {
      expect(sceneRecordSchema.safeParse({ ...scene, narrativeRefs: [bad] }).success).toBe(false);
      expect(
        sceneRecordSchema.safeParse({
          ...scene,
          data: {
            ...scene.data,
            events: [{ ...scene.data.events[0], narrativeRefs: [bad] }],
          },
        }).success,
      ).toBe(false);
    }
    expect(sceneRecordSchema.safeParse({ ...scene, narrativeRefs: 'event.trial' }).success).toBe(
      false,
    );
    expect(sceneRecordSchema.safeParse({ ...scene, unknownNarrativeMetadata: {} }).success).toBe(
      false,
    );
    expect(
      dialogueRecordSchema.safeParse({
        ...dialogue,
        data: {
          ...dialogue.data,
          blocks: [{ ...dialogue.data.blocks[0], narrativeRefs: ['event.Invalid'] }],
        },
      }).success,
    ).toBe(false);
    expect(
      interactionRecordSchema.safeParse({
        ...interaction,
        data: {
          ...interaction.data,
          rules: [{ ...interaction.data.rules[0], narrativeRefs: [{ id: 'event.trial' }] }],
        },
      }).success,
    ).toBe(false);
  });

  it('erases every author-only link from compiled bytes with identical gameplay', () => {
    const baseline = canonicalVocabularyGoldenProject();
    const linked = withNarrativeLinks().project;
    const before = compileAuthoringProjectValue(baseline);
    const after = compileAuthoringProjectValue(linked);
    expect(before.ok, JSON.stringify(before.diagnostics)).toBe(true);
    expect(after.ok, JSON.stringify(after.diagnostics)).toBe(true);
    if (!before.ok || !after.ok) throw new Error('Expected valid compiled projects');
    expect(after.project).toEqual(before.project);
    expect(JSON.stringify(after.project)).not.toContain('narrativeRefs');
    expect(JSON.stringify(after.project)).not.toContain('event.trial');
  });

  it('supports nested semantic Dialogue edges independently of the scene operation kind', () => {
    const block = defaultDialogueBlock('sequence');
    const segment = defaultDialogueSegment('line');
    const dialogue = withNarrativeLinks().dialogue;
    if (block.type !== 'sequence') throw new Error('Expected sequence block');
    block.narrativeRefs = ['event.trial'];
    segment.narrativeRefs = ['authored-content.mara-answer'];
    block.segments = [segment];
    const edge = {
      id: 'next',
      kind: 'next' as const,
      fromBlockId: 'start',
      toBlockId: 'start',
      narrativeRefs: ['choice-point.mara-chooses'],
    };
    const record = {
      ...dialogue,
      data: { ...dialogue.data, blocks: [block], edges: [edge] },
    };
    const reopened = dialogueRecordSchema.parse(
      decodeSparseRecordYaml('dialogues', encodeSparseRecordYaml('dialogues', record)),
    );
    expect(reopened.data.blocks[0]!.narrativeRefs).toEqual(['event.trial']);
    expect(reopened.data.edges[0]!.narrativeRefs).toEqual(['choice-point.mara-chooses']);
    expect(reopened.data.blocks[0]!.id).toBe(block.id);
  });
});
