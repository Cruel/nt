import type {
  CompiledFlowTarget,
  CompiledGameplayCommand,
  CompiledProjectWire,
  CompiledText,
  InteractionProgram,
} from './project-schema/compiled-project';
import type { FlowTarget, GameplayCommand, TextContent } from './project-schema/authoring-flow';
import type { InteractionProgram as AuthoringInteractionProgram } from './project-schema/authoring-interaction-programs';
import type { AuthoringProject } from './project-schema/authoring-project';
import { compileSubjectSelector } from './authoring-compiler-shared-lowering';
import { parseDialogueData } from './project-schema/authoring-dialogues';
import type {
  DialogueLineCue,
  DialogueMediaContent,
  DialogueStageMutation,
  DialogueStageSlotState,
} from './project-schema/authoring-dialogues';
import { renderActiveTextFromDialogueCues } from './project-schema/dialogue-cue-markup';
import { parseInteractionData } from './project-schema/authoring-interactions';
import { parseVerbData } from './project-schema/authoring-verbs';
import type {
  CompiledProjectSceneRoomDraft,
  ProgramLoweringDiagnostic,
} from './authoring-compiler-scene-room-lowering';
import {
  compileCondition,
  compileIdentityOperand,
  compileInteractableOperand,
  compileInventoryOperand,
  compileLocationOperand,
  compileLocationSubjectOperand,
  compileMatcher,
} from './authoring-condition-lowering';

export interface CompleteProgramLoweringResult {
  diagnostics: ProgramLoweringDiagnostic[];
  draft?: CompiledProjectWire;
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

function compileDialogueStageState(state: DialogueStageSlotState) {
  return {
    character: { kind: 'character' as const, id: state.character.$ref.id },
    profileId: state.profileId,
    poseId: state.poseId,
    expressionId: state.expressionId,
    appearanceId: state.appearanceId,
    position: state.position,
    offset: state.offset,
    scale: state.scale,
    visible: state.visible,
  };
}

function compileDialogueMedia(media: DialogueMediaContent) {
  return media.kind === 'image'
    ? { kind: 'image' as const, asset: { kind: 'asset' as const, id: media.asset.$ref.id } }
    : {
        kind: 'character' as const,
        character: { kind: 'character' as const, id: media.character.$ref.id },
        profileId: media.profileId,
        poseId: media.poseId,
        expressionId: media.expressionId,
        appearanceId: media.appearanceId,
      };
}

function compileDialogueStageMutation(mutation: DialogueStageMutation) {
  return {
    slotId: mutation.slotId,
    action: mutation.action,
    ...(mutation.character
      ? { character: { kind: 'character' as const, id: mutation.character.$ref.id } }
      : {}),
    ...(mutation.profileId === undefined ? {} : { profileId: mutation.profileId }),
    ...(mutation.poseId === undefined ? {} : { poseId: mutation.poseId }),
    ...(mutation.expressionId === undefined ? {} : { expressionId: mutation.expressionId }),
    ...(mutation.appearanceId === undefined ? {} : { appearanceId: mutation.appearanceId }),
    ...(mutation.position === undefined ? {} : { position: mutation.position }),
    ...(mutation.offset === undefined ? {} : { offset: mutation.offset }),
    ...(mutation.scale === undefined ? {} : { scale: mutation.scale }),
  };
}

function compileDialogueLineText(
  text: TextContent,
  cues: readonly DialogueLineCue[],
): CompiledText {
  if (text.source.kind !== 'inline') return compileText(text);
  return compileText({
    ...text,
    source: {
      kind: 'inline',
      text:
        text.markup === 'active-text'
          ? renderActiveTextFromDialogueCues(text.source.text, cues)
          : text.source.text,
    },
  });
}

function compileDialogueSemanticCue(
  cue: Exclude<DialogueLineCue, { kind: 'active-text' | 'invalid-markup' }>,
) {
  const common = { id: cue.id, position: cue.position };
  if (cue.kind === 'speaker-expression')
    return { ...common, kind: cue.kind, expressionId: cue.expressionId };
  if (cue.kind === 'stage')
    return { ...common, kind: cue.kind, mutation: compileDialogueStageMutation(cue.mutation) };
  if (cue.kind === 'media')
    return {
      ...common,
      kind: cue.kind,
      mutation: {
        slotId: cue.mutation.slotId,
        action: cue.mutation.action,
        ...(cue.mutation.content === undefined
          ? {}
          : { content: compileDialogueMedia(cue.mutation.content) }),
      },
    };
  if (cue.kind === 'gesture')
    return {
      ...common,
      kind: cue.kind,
      slotId: cue.slotId,
      gestureId: cue.gestureId,
      waitForCompletion: cue.waitForCompletion,
      skippable: cue.skippable,
    };
  if (cue.kind === 'voice')
    return {
      ...common,
      kind: cue.kind,
      asset: { kind: 'asset' as const, id: cue.asset.$ref.id },
      pausePolicy: cue.pausePolicy,
      gain: cue.gain,
      pan: cue.pan,
      waitForCompletion: cue.waitForCompletion,
      skipBehavior: cue.skipBehavior,
    };
  if (cue.kind === 'sound-effect')
    return {
      ...common,
      kind: cue.kind,
      asset: { kind: 'asset' as const, id: cue.asset.$ref.id },
      pausePolicy: cue.pausePolicy,
      gain: cue.gain,
      pan: cue.pan,
      waitForCompletion: cue.waitForCompletion,
      causality: cue.causality,
      synchronized: cue.synchronized,
      skipBehavior: cue.skipBehavior,
    };
  return { ...common, kind: cue.kind, emphasis: cue.emphasis };
}

export function compileGameplayCommand(command: GameplayCommand): CompiledGameplayCommand {
  switch (command.kind) {
    case 'set-global-property':
      return {
        id: command.id,
        kind: command.kind,
        property: { kind: 'property', id: command.variable.$ref.id },
        value: command.value,
      };
    case 'unset-global-property':
      return {
        id: command.id,
        kind: command.kind,
        property: { kind: 'property', id: command.variable.$ref.id },
      };
    case 'set-property':
      return {
        id: command.id,
        kind: command.kind,
        owner: compileIdentityOperand(command.owner),
        property: { kind: 'property', id: command.propertyId },
        value: command.value,
      };
    case 'unset-property':
      return {
        id: command.id,
        kind: command.kind,
        owner: compileIdentityOperand(command.owner),
        property: { kind: 'property', id: command.propertyId },
      };
    case 'add-trait':
    case 'remove-trait':
      return {
        id: command.id,
        kind: command.kind,
        owner: compileIdentityOperand(command.owner),
        trait: { kind: 'trait', id: command.trait.$ref.id },
      };
    case 'set-enabled':
      return {
        id: command.id,
        kind: command.kind,
        subject: compileLocationSubjectOperand(command.subject),
        enabled: command.enabled,
      };
    case 'set-visible':
      return {
        id: command.id,
        kind: command.kind,
        subject: compileLocationSubjectOperand(command.subject),
        visible: command.visible,
      };
    case 'move-instance':
      return {
        id: command.id,
        kind: command.kind,
        subject: compileLocationSubjectOperand(command.subject),
        location: compileLocationOperand(command.location),
      };
    case 'create-room':
    case 'create-character':
    case 'create-interactable': {
      const source =
        command.source.kind === 'archetype'
          ? {
              kind: 'archetype' as const,
              archetype: { kind: 'archetype' as const, id: command.source.archetype.$ref.id },
            }
          : {
              kind: command.source.kind,
              instance: compileIdentityOperand(command.source.instance),
            };
      if (command.kind === 'create-room')
        return {
          id: command.id,
          kind: command.kind,
          source,
          ...(command.result ? { result: command.result } : {}),
        };
      return {
        id: command.id,
        kind: command.kind,
        source,
        location: compileLocationOperand(command.location),
        enabled: command.enabled,
        visible: command.visible,
        ...(command.result ? { result: command.result } : {}),
      } as CompiledGameplayCommand;
    }
    case 'destroy-instance':
      return {
        id: command.id,
        kind: command.kind,
        instance: compileIdentityOperand(command.instance),
      };
    case 'split-quantity':
      return {
        id: command.id,
        kind: command.kind,
        source: compileInteractableOperand(command.source),
        quantity: command.quantity,
        ...(command.result ? { result: command.result } : {}),
      };
    case 'merge-quantity':
      return {
        id: command.id,
        kind: command.kind,
        receiver: compileInteractableOperand(command.receiver),
        donor: compileInteractableOperand(command.donor),
      };
    case 'transfer-quantity':
      return command.mode === 'exact'
        ? {
            id: command.id,
            kind: command.kind,
            mode: 'exact',
            source: compileInteractableOperand(command.source),
            quantity: command.quantity,
            location: compileLocationOperand(command.location),
            ...(command.result ? { result: command.result } : {}),
          }
        : {
            id: command.id,
            kind: command.kind,
            mode: 'aggregate',
            matcher: compileMatcher(command.matcher),
            ...(command.sourceInventory
              ? { sourceInventory: compileInventoryOperand(command.sourceInventory) }
              : {}),
            quantity: command.quantity,
            location: compileLocationOperand(command.location),
          };
    case 'add-quantity':
      return {
        id: command.id,
        kind: command.kind,
        definition: { kind: 'interactable-definition', id: command.definition.$ref.id },
        quantity: command.quantity,
        location: compileLocationOperand(command.location),
      };
    case 'consume-quantity':
      return command.mode === 'exact'
        ? {
            id: command.id,
            kind: command.kind,
            mode: 'exact',
            source: compileInteractableOperand(command.source),
            quantity: command.quantity,
          }
        : {
            id: command.id,
            kind: command.kind,
            mode: 'aggregate',
            matcher: compileMatcher(command.matcher),
            ...(command.sourceInventory
              ? { sourceInventory: compileInventoryOperand(command.sourceInventory) }
              : {}),
            quantity: command.quantity,
          };
    case 'present-inventory':
      return {
        id: command.id,
        kind: command.kind,
        inventory: compileInventoryOperand(command.inventory),
        layout: command.layout ? { kind: 'layout', id: command.layout.$ref.id } : null,
      };
    case 'notify':
      return { id: command.id, kind: command.kind, message: compileText(command.message) };
    case 'call-scene':
      return {
        id: command.id,
        kind: command.kind,
        scene: { kind: 'scene', id: command.scene.$ref.id },
      };
    case 'call-dialogue':
      return {
        id: command.id,
        kind: command.kind,
        dialogue: { kind: 'dialogue', id: command.dialogue.$ref.id },
      };
    case 'run-lua':
      return { id: command.id, kind: command.kind, source: command.source };
    case 'if':
      return {
        id: command.id,
        kind: command.kind,
        condition: compileCondition(command.condition),
        // oxlint-disable-next-line unicorn/no-thenable -- `then` is the canonical Gameplay Command wire field.
        then: command.then.map(compileGameplayCommand),
        else: command.else.map(compileGameplayCommand),
      };
  }
}

function compileInteractionProgram(program: AuthoringInteractionProgram): InteractionProgram {
  return {
    instructions: program.instructions.map(compileGameplayCommand),
    completion: compileFlowTarget(program.completion),
    outcome: program.outcome,
  };
}

export function lowerDialogueAndInteractionPrograms(
  project: AuthoringProject,
  partial: CompiledProjectSceneRoomDraft,
): CompleteProgramLoweringResult {
  const diagnostics: ProgramLoweringDiagnostic[] = [];
  const dialogues: CompiledProjectWire['definitions']['dialogues'] = [];
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
    const blocks: CompiledProjectWire['definitions']['dialogues'][number]['program']['blocks'] = [];
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
        } else if (segment.type === 'call-scene') {
          segments.push({
            id: segment.id,
            kind: 'call-scene',
            ...(segment.condition === undefined
              ? {}
              : { condition: compileCondition(segment.condition) }),
            scene: { kind: 'scene', id: segment.scene.$ref.id },
            inputs: segment.inputs.map((binding) => ({
              inputId: binding.inputId,
              value: binding.value,
            })),
            uiPolicy: segment.uiPolicy,
          });
        } else if (segment.type === 'handoff') {
          segments.push({
            id: segment.id,
            kind: 'handoff',
            ...(segment.condition === undefined
              ? {}
              : { condition: compileCondition(segment.condition) }),
            ...(segment.payload === undefined ? {} : { payload: segment.payload }),
          });
        } else {
          segments.push({
            id: segment.id,
            kind: 'line',
            speaker: segment.speaker ? { kind: 'character', id: segment.speaker.$ref.id } : null,
            text: compileDialogueLineText(segment.text, segment.cues),
            cues: segment.cues
              .filter(
                (
                  cue,
                ): cue is Exclude<DialogueLineCue, { kind: 'active-text' | 'invalid-markup' }> =>
                  cue.kind !== 'active-text' && cue.kind !== 'invalid-markup',
              )
              .map(compileDialogueSemanticCue)
              .sort(
                (left, right) =>
                  left.position.offset - right.position.offset ||
                  left.position.order - right.position.order ||
                  left.id.localeCompare(right.id),
              ),
            ...(segment.condition === undefined
              ? {}
              : { condition: compileCondition(segment.condition) }),
            effects: segment.effects.map(compileGameplayCommand),
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
      stageSlots: data.stageSlots.map((slot) => ({
        id: slot.id,
        speakerSync: slot.speakerSync,
        initial: slot.initial ? compileDialogueStageState(slot.initial) : null,
      })),
      mediaSlots: data.mediaSlots.map((slot) => ({
        id: slot.id,
        visible: slot.visible,
        initial: slot.initial ? compileDialogueMedia(slot.initial) : null,
      })),
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
                effects: edge.effects.map(compileGameplayCommand),
                logged: edge.logged,
                autosaveSafePoint: edge.autosaveSafePoint,
              },
        ),
      },
      completion: compileFlowTarget(data.completion),
    });
  }

  const verbs: CompiledProjectWire['definitions']['verbs'] = [];
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

  const interactions: CompiledProjectWire['definitions']['interactions'] = [];
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
        guard: compileCondition(rule.guard),
        priority: rule.priority,
        program: compileInteractionProgram(rule.program),
      })),
    });
  }

  if (diagnostics.length > 0) return { diagnostics };
  return {
    diagnostics,
    draft: {
      ...partial,
      ...(project.undefinedInteractionProgram === null
        ? {}
        : {
            undefinedInteractionProgram: compileInteractionProgram(
              project.undefinedInteractionProgram,
            ),
          }),
      definitions: { ...partial.definitions, dialogues, interactions, verbs },
    },
  };
}
