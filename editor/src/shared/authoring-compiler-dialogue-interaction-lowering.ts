import type {
  CompiledCondition,
  CompiledEffect,
  CompiledFlowTarget,
  CompiledProjectWireV4,
  CompiledText,
  InteractionProgram,
} from './project-schema/compiled-project';
import type { Condition, Effect, FlowTarget, TextContent } from './project-schema/authoring-flow';
import type {
  InteractionInstruction,
  InteractionMoveTarget,
  InteractionProgram as AuthoringInteractionProgram,
} from './project-schema/authoring-interaction-programs';
import type { AuthoringProject } from './project-schema/authoring-project';
import { compileSubjectSelector } from './authoring-compiler-shared-lowering';
import type { InventoryReferenceData } from './project-schema/authoring-inventories';
import { parseDialogueData } from './project-schema/authoring-dialogues';
import { parseInteractionData } from './project-schema/authoring-interactions';
import { parseVerbData } from './project-schema/authoring-verbs';
import type {
  CompiledProjectSceneRoomDraft,
  ProgramLoweringDiagnostic,
} from './authoring-compiler-scene-room-lowering';

export interface CompleteProgramLoweringResult {
  diagnostics: ProgramLoweringDiagnostic[];
  draft?: CompiledProjectWireV4;
}

function compileText(text: TextContent): CompiledText {
  const source = text.source;
  return {
    markup: text.markup,
    source:
      source.kind === 'inline'
        ? { kind: 'inline', text: source.text }
        : source.kind === 'localized'
          ? { kind: 'localized', key: source.key }
          : { kind: 'lua-expression', source: source.source },
  };
}

function compileCondition(condition: Condition): CompiledCondition {
  if (condition.kind === 'always') return { kind: 'always' };
  if (condition.kind === 'lua-predicate') {
    return { kind: 'lua-predicate', source: condition.source };
  }
  return {
    kind: 'global-property-comparison',
    operator: condition.operator,
    property: { kind: 'property', id: condition.variable.$ref.id },
    ...(condition.value === undefined ? {} : { value: condition.value }),
  };
}

function compileEffect(effect: Effect): CompiledEffect {
  if (effect.kind === 'run-lua-effect') return { ...effect };
  return {
    kind: 'set-global-property',
    property: { kind: 'property', id: effect.variable.$ref.id },
    value: effect.value,
  };
}

function compileFlowTarget(target: FlowTarget): CompiledFlowTarget {
  switch (target.kind) {
    case 'scene':
      return { kind: 'scene', scene: { kind: 'scene', id: target.id } };
    case 'dialogue':
      return { kind: 'dialogue', dialogue: { kind: 'dialogue', id: target.id } };
    case 'room':
      return { kind: 'room', room: { kind: 'room', id: target.id } };
    case 'return':
      return { kind: 'return' };
    case 'end':
      return { kind: 'end' };
  }
}

function compileInventoryReference(inventory: InventoryReferenceData) {
  const owner = inventory.owner;
  const compiledOwner =
    owner.kind === 'project'
      ? { kind: 'project' as const }
      : owner.kind === 'character'
        ? {
            kind: 'character' as const,
            character: { kind: 'character' as const, id: owner.character.$ref.id },
          }
        : owner.kind === 'interactable'
          ? {
              kind: 'interactable' as const,
              interactable: { kind: 'interactable' as const, id: owner.interactable.$ref.id },
            }
          : owner.kind === 'room-feature'
            ? {
                kind: 'room-feature' as const,
                room: { kind: 'room' as const, id: owner.room.$ref.id },
                featureId: owner.featureId,
              }
            : {
                kind: 'interactable-feature' as const,
                interactable: {
                  kind: 'interactable' as const,
                  id: owner.interactable.$ref.id,
                },
                featureId: owner.featureId,
              };
  return { owner: compiledOwner, inventoryId: inventory.inventoryId };
}

function compileMoveTarget(
  target: InteractionMoveTarget,
): Extract<InteractionProgram['instructions'][number], { kind: 'move-interactable' }>['target'] {
  if (target.kind === 'unplaced') return { kind: 'unplaced' };
  if (target.kind === 'room')
    return { kind: 'room', room: { kind: 'room', id: target.room.$ref.id } };
  return { kind: 'inventory', inventory: compileInventoryReference(target.inventory) };
}

function compileInstruction(
  instruction: InteractionInstruction,
): InteractionProgram['instructions'][number] {
  switch (instruction.kind) {
    case 'apply-effect':
      return {
        id: instruction.id,
        kind: 'apply-effect',
        effect: compileEffect(instruction.effect),
      };
    case 'move-interactable':
      return {
        id: instruction.id,
        kind: 'move-interactable',
        interactable: { kind: 'interactable', id: instruction.interactable.$ref.id },
        target: compileMoveTarget(instruction.target),
      };
    case 'set-interactable-state':
      return {
        id: instruction.id,
        kind: 'set-interactable-state',
        interactable: { kind: 'interactable', id: instruction.interactable.$ref.id },
        ...(instruction.enabled === undefined ? {} : { enabled: instruction.enabled }),
        ...(instruction.visible === undefined ? {} : { visible: instruction.visible }),
      };
    case 'notify':
      return { id: instruction.id, kind: 'notify', message: compileText(instruction.message) };
    case 'call-scene':
      return {
        id: instruction.id,
        kind: 'call-scene',
        scene: { kind: 'scene', id: instruction.scene.$ref.id },
      };
    case 'call-dialogue':
      return {
        id: instruction.id,
        kind: 'call-dialogue',
        dialogue: { kind: 'dialogue', id: instruction.dialogue.$ref.id },
      };
  }
}

function compileInteractionProgram(program: AuthoringInteractionProgram): InteractionProgram {
  return {
    instructions: program.instructions.map(compileInstruction),
    completion: compileFlowTarget(program.completion),
    outcome: program.outcome,
  };
}

export function lowerDialogueAndInteractionPrograms(
  project: AuthoringProject,
  partial: CompiledProjectSceneRoomDraft,
): CompleteProgramLoweringResult {
  const diagnostics: ProgramLoweringDiagnostic[] = [];
  const dialogues: CompiledProjectWireV4['definitions']['dialogues'] = [];
  for (const dialogue of partial.definitions.dialogues) {
    const data = parseDialogueData(project.dialogues[dialogue.id]?.data);
    if (!data) {
      diagnostics.push({
        code: 'COMPILER_DIALOGUE_DATA_MISSING',
        path: `/dialogues/${dialogue.id}/data`,
        message: 'Validated Dialogue data could not be lowered.',
      });
      continue;
    }
    const blocks: CompiledProjectWireV4['definitions']['dialogues'][number]['program']['blocks'] =
      [];
    for (const block of data.blocks) {
      if (block.type === 'comment') continue;
      if (block.type === 'choice') {
        blocks.push({ id: block.id, kind: 'choice' });
        continue;
      }
      if (block.type === 'redirect') {
        blocks.push({ id: block.id, kind: 'redirect', targetBlockId: block.targetBlockId });
        continue;
      }
      const segments: Extract<(typeof blocks)[number], { kind: 'sequence' }>['segments'] = [];
      for (const segment of block.segments) {
        if (segment.type === 'comment') continue;
        if (segment.type === 'run-lua') {
          segments.push({
            id: segment.id,
            kind: 'run-lua',
            ...(segment.condition === undefined
              ? {}
              : { condition: compileCondition(segment.condition) }),
            source: segment.source,
            mayYield: segment.mayYield,
          });
        } else {
          segments.push({
            id: segment.id,
            kind: 'line',
            speaker: segment.speaker ? { kind: 'character', id: segment.speaker.$ref.id } : null,
            text: compileText(segment.text),
            ...(segment.condition === undefined
              ? {}
              : { condition: compileCondition(segment.condition) }),
            effects: segment.effects.map(compileEffect),
            showOnce: segment.showOnce,
            logged: segment.logged,
            autosaveSafePoint: segment.autosaveSafePoint,
          });
        }
      }
      blocks.push({
        id: block.id,
        kind: 'sequence',
        defaultSpeaker: block.defaultSpeaker
          ? { kind: 'character', id: block.defaultSpeaker.$ref.id }
          : null,
        segments,
      });
    }
    dialogues.push({
      ...dialogue,
      program: {
        entryBlockId: data.entryBlockId,
        blocks,
        edges: data.edges.map((edge) =>
          edge.kind === 'next'
            ? {
                id: edge.id,
                kind: 'next' as const,
                fromBlockId: edge.fromBlockId,
                toBlockId: edge.toBlockId,
              }
            : {
                id: edge.id,
                kind: 'choice' as const,
                fromBlockId: edge.fromBlockId,
                toBlockId: edge.toBlockId,
                label: compileText(edge.label),
                ...(edge.condition === undefined
                  ? {}
                  : { condition: compileCondition(edge.condition) }),
                effects: edge.effects.map(compileEffect),
                logged: edge.logged,
                autosaveSafePoint: edge.autosaveSafePoint,
              },
        ),
      },
      completion: compileFlowTarget(data.completion),
    });
  }

  const verbs: CompiledProjectWireV4['definitions']['verbs'] = [];
  for (const verb of partial.definitions.verbs) {
    const data = parseVerbData(project.verbs[verb.id]?.data);
    if (!data) {
      diagnostics.push({
        code: 'COMPILER_VERB_DATA_MISSING',
        path: `/verbs/${verb.id}/data`,
        message: 'Validated Verb data could not be lowered.',
      });
      continue;
    }
    verbs.push({
      ...verb,
      offers: verb.offers.map((offer, index) => ({
        ...offer,
        ...(data.offers[index]?.condition === undefined
          ? {}
          : { condition: compileCondition(data.offers[index].condition) }),
      })),
      availability: compileCondition(data.availability),
      defaultProgram: compileInteractionProgram(data.defaultProgram),
    });
  }

  const interactions: CompiledProjectWireV4['definitions']['interactions'] = [];
  for (const interaction of partial.definitions.interactions) {
    const data = parseInteractionData(project.interactions[interaction.id]?.data);
    if (!data) {
      diagnostics.push({
        code: 'COMPILER_INTERACTION_DATA_MISSING',
        path: `/interactions/${interaction.id}/data`,
        message: 'Validated Interaction data could not be lowered.',
      });
      continue;
    }
    interactions.push({
      ...interaction,
      rules: data.rules.map((rule) => ({
        id: rule.id,
        verb: { kind: 'verb', id: rule.verb.$ref.id },
        slots: rule.slots.map((slot) => ({
          slotId: slot.slotId,
          selectors: slot.selectors.map(compileSubjectSelector),
        })),
        offer:
          rule.offer === null
            ? null
            : {
                slotId: rule.offer.slotId,
                ...(rule.offer.condition === undefined
                  ? {}
                  : { condition: compileCondition(rule.offer.condition) }),
                rank: rule.offer.rank,
                primary: rule.offer.primary,
              },
        context:
          rule.context.kind === 'any'
            ? { kind: 'any' as const }
            : rule.context.kind === 'active-room'
              ? {
                  kind: 'active-room' as const,
                  room: { kind: 'room' as const, id: rule.context.room.$ref.id },
                }
              : rule.context.kind === 'room-placement'
                ? {
                    kind: 'room-placement' as const,
                    placement: {
                      room: { kind: 'room' as const, id: rule.context.placement.room },
                      placementId: rule.context.placement.placement,
                    },
                  }
                : {
                    kind: 'predicate' as const,
                    condition: compileCondition(rule.context.condition),
                  },
        program: compileInteractionProgram(rule.program),
      })),
    });
  }

  if (diagnostics.length > 0) return { diagnostics };
  return {
    diagnostics,
    draft: { ...partial, definitions: { ...partial.definitions, dialogues, interactions, verbs } },
  };
}
