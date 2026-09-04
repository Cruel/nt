import type {
  CompiledGameplayCommand,
  CompiledProjectWire,
  FlowPredictionIndex,
} from './project-schema/compiled-project';
import type {
  PrefetchHint,
  PrefetchHintPoint,
  PrefetchHintTarget,
} from './project-schema/authoring-prefetch-hints';
import { staticPredictionTruth } from './flow-prediction-static';

type PredictionDependency = FlowPredictionIndex['dependencyGroups'][number][number];
type PredictionProgram = FlowPredictionIndex['slices'][number]['program'];
type PredictionPoint = FlowPredictionIndex['slices'][number]['point'];
type PredictionSlice = FlowPredictionIndex['slices'][number];
type SceneInstruction =
  CompiledProjectWire['definitions']['scenes'][number]['program']['events'][number]['instruction'];
type DialogueDefinition = CompiledProjectWire['definitions']['dialogues'][number];
type DialogueBlock = DialogueDefinition['program']['blocks'][number];
type DialogueSequenceBlock = Extract<DialogueBlock, { kind: 'sequence' }>;
type DialogueSegment = DialogueSequenceBlock['segments'][number];
type DialogueLineSegment = Extract<DialogueSegment, { kind: 'line' }>;
type DialogueCue = DialogueLineSegment['cues'][number];
type InteractionProgram = CompiledProjectWire['definitions']['verbs'][number]['defaultProgram'];

function compiledHintTarget(
  target: PrefetchHintTarget,
): NonNullable<FlowPredictionIndex['supplementalHints']>[number]['target'] {
  switch (target.kind) {
    case 'asset':
      return { kind: 'asset', asset: { kind: 'asset', id: target.asset.$ref.id } };
    case 'scene':
      return { kind: 'scene', scene: { kind: 'scene', id: target.scene.$ref.id } };
    case 'dialogue':
      return { kind: 'dialogue', dialogue: { kind: 'dialogue', id: target.dialogue.$ref.id } };
    case 'room':
      return { kind: 'room', room: { kind: 'room', id: target.room.$ref.id } };
    case 'layout':
      return { kind: 'layout', layout: { kind: 'layout', id: target.layout.$ref.id } };
  }
}

function compiledHintPoint(point: PrefetchHintPoint): PredictionPoint {
  switch (point.kind) {
    case 'scene-entry':
    case 'scene-terminal':
      return { kind: point.kind, scene: { kind: 'scene', id: point.scene.$ref.id } };
    case 'scene-step':
      return {
        kind: 'scene-step',
        scene: { kind: 'scene', id: point.scene.$ref.id },
        stepId: point.stepId,
      };
    case 'dialogue-entry':
    case 'dialogue-terminal':
      return { kind: point.kind, dialogue: { kind: 'dialogue', id: point.dialogue.$ref.id } };
    case 'dialogue-position':
      return {
        kind: 'dialogue-position',
        dialogue: { kind: 'dialogue', id: point.dialogue.$ref.id },
        blockId: point.blockId,
        ...(point.segmentId ? { segmentId: point.segmentId } : {}),
        ...(point.edgeId ? { edgeId: point.edgeId } : {}),
        stage: point.stage,
        cursor: point.cursor,
      };
    case 'room-lifecycle':
      return {
        kind: 'room-lifecycle',
        room: { kind: 'room', id: point.room.$ref.id },
        stage: point.stage,
      };
    case 'interaction-rule':
      return {
        kind: 'interaction-rule',
        interaction: { kind: 'interaction', id: point.interaction.$ref.id },
        ruleId: point.ruleId,
      };
    case 'verb-default':
      return { kind: 'verb-default', verb: { kind: 'verb', id: point.verb.$ref.id } };
    case 'resident-layout':
      return { kind: 'resident-layout', layout: { kind: 'layout', id: point.layout.$ref.id } };
    case 'undefined-interaction':
      return { kind: 'undefined-interaction' };
  }
}

function summarizeGameplayCommands(
  commands: readonly CompiledGameplayCommand[],
): PredictionProgram {
  const result: PredictionProgram = [];
  for (const command of commands) {
    switch (command.kind) {
      case 'set-global-property':
        result.push({
          commandId: command.id,
          kind: 'set-global-property',
          property: command.property,
          value: command.value,
        });
        break;
      case 'unset-global-property':
        result.push({
          commandId: command.id,
          kind: 'invalidate-global-property',
          property: command.property,
        });
        break;
      case 'set-property':
        result.push({
          commandId: command.id,
          kind: 'set-identity-property',
          owner: command.owner,
          property: command.property,
          value: command.value,
        });
        break;
      case 'add-trait':
      case 'remove-trait':
        result.push({
          commandId: command.id,
          kind: 'set-trait-presence',
          owner: command.owner,
          trait: command.trait,
          present: command.kind === 'add-trait',
        });
        break;
      case 'move-instance':
        result.push({
          commandId: command.id,
          kind: 'set-location',
          subject: command.subject,
          location: command.location,
        });
        break;
      case 'unset-property':
      case 'set-enabled':
      case 'set-visible':
      case 'create-room':
      case 'create-character':
      case 'create-interactable':
      case 'destroy-instance':
      case 'split-quantity':
      case 'merge-quantity':
      case 'transfer-quantity':
      case 'add-quantity':
      case 'consume-quantity':
        result.push({ commandId: command.id, kind: 'invalidate-condition-facts' });
        break;
      case 'navigate-exit':
      case 'change-room':
        result.push({ commandId: command.id, kind: 'invalidate-prediction-state' });
        break;
      case 'call-scene':
        result.push({ commandId: command.id, kind: 'call-scene', scene: command.scene });
        break;
      case 'call-dialogue':
        result.push({ commandId: command.id, kind: 'call-dialogue', dialogue: command.dialogue });
        break;
      case 'run-lua':
        result.push({ commandId: command.id, kind: 'opaque' });
        break;
      case 'if':
        result.push({
          commandId: command.id,
          kind: 'if',
          condition: command.condition,
          thenCommands: summarizeGameplayCommands(command.then),
          elseCommands: summarizeGameplayCommands(command.else),
        });
        break;
      default:
        // Presentation-only commands such as inventory UI and notifications do not change the
        // authoritative typed facts admitted by prediction.
        break;
    }
  }
  return result;
}

function summarizeFlowTarget(target: InteractionProgram['completion']): PredictionProgram {
  switch (target.kind) {
    case 'scene':
      return [{ kind: 'call-scene', scene: target.scene }];
    case 'dialogue':
      return [{ kind: 'call-dialogue', dialogue: target.dialogue }];
    case 'room':
      return [{ kind: 'enter-room', room: target.room }];
    default:
      return [];
  }
}

function summarizeInteractionProgram(program: InteractionProgram): PredictionProgram {
  return [
    ...summarizeGameplayCommands(program.instructions),
    ...summarizeFlowTarget(program.completion),
  ];
}

function appendBackgroundDependencies(
  dependencies: PredictionDependency[],
  background: {
    asset: { kind: 'asset'; id: string } | null;
    material: { kind: 'material'; id: string } | null;
  },
) {
  if (background.asset) dependencies.push({ kind: 'asset', asset: background.asset });
  if (background.material) dependencies.push({ kind: 'material', material: background.material });
}

function sceneInstructionDependencies(instruction: SceneInstruction): PredictionDependency[] {
  const dependencies: PredictionDependency[] = [];
  switch (instruction.kind) {
    case 'set-background':
      appendBackgroundDependencies(dependencies, instruction);
      break;
    case 'actor-cue':
      if (instruction.action !== 'hide') {
        dependencies.push({
          kind: 'character',
          character: instruction.character,
          profileId: instruction.profileId,
          poseId: instruction.poseId,
          expressionId: instruction.expressionId,
          appearanceId: instruction.appearanceId,
        });
      }
      break;
    case 'audio-cue':
      if (instruction.asset && ['play', 'fade-in'].includes(instruction.action))
        dependencies.push({
          kind: 'audio',
          asset: instruction.asset,
          purpose: instruction.purpose,
        });
      break;
    case 'set-layout':
      if (instruction.action !== 'hide' && instruction.layout)
        dependencies.push({ kind: 'layout', layout: instruction.layout });
      break;
    case 'material-parameter':
      dependencies.push({ kind: 'material', material: instruction.material });
      break;
    case 'postprocess-effect':
      if (instruction.action === 'upsert' && instruction.material)
        dependencies.push({ kind: 'material', material: instruction.material });
      break;
    case 'transition-group':
      for (const child of instruction.children) {
        if (child.kind === 'set-background') appendBackgroundDependencies(dependencies, child);
        else if (child.kind === 'actor-cue' && child.action !== 'hide') {
          dependencies.push({
            kind: 'character',
            character: child.character,
            profileId: child.profileId,
            poseId: child.poseId,
            expressionId: child.expressionId,
            appearanceId: child.appearanceId,
          });
        } else if (child.kind === 'set-layout' && child.action !== 'hide' && child.layout) {
          dependencies.push({ kind: 'layout', layout: child.layout });
        }
      }
      break;
    default:
      break;
  }
  return dependencies;
}

function sceneInstructionProgram(instruction: SceneInstruction): PredictionProgram {
  switch (instruction.kind) {
    case 'call-scene':
      return [{ kind: 'call-scene', scene: instruction.scene }];
    case 'start-detached-scene':
      return [{ kind: 'start-detached-scene', scene: instruction.scene }];
    case 'call-dialogue':
      return [{ kind: 'call-dialogue', dialogue: instruction.dialogue }];
    case 'gameplay-effect-batch':
      return summarizeGameplayCommands(instruction.operations);
    case 'run-lua':
      return [{ kind: 'opaque' }];
    case 'runtime-world-transaction':
      return [{ kind: 'invalidate-condition-facts' }];
    case 'directed-room-change':
    case 'navigation-attempt':
    case 'call-interaction':
      return [{ kind: 'invalidate-prediction-state' }];
    default:
      return [];
  }
}

function sceneInstructionFrontier(instruction: SceneInstruction): PredictionSlice['frontier'] {
  switch (instruction.kind) {
    case 'choice':
      return 'decision';
    case 'wait-input':
    case 'wait-condition':
    case 'wait-operation':
    case 'wait-audio':
    case 'wait-layout-signal':
      return 'strong-wait';
    case 'wait-duration':
      return instruction.durationMs <= 2_000 ? 'short-wait' : 'strong-wait';
    case 'show-text':
      return instruction.wait === 'input' ? 'strong-wait' : 'normal';
    case 'audio-cue':
      return instruction.waitForCompletion ? 'strong-wait' : 'normal';
    case 'set-background':
    case 'actor-cue':
    case 'set-layout':
    case 'material-parameter':
    case 'transition-group':
      if (!instruction.waitForCompletion) return 'normal';
      return instruction.durationMs <= 2_000 ? 'short-wait' : 'strong-wait';
    case 'run-lua':
      return instruction.mayYield ? 'strong-wait' : 'normal';
    default:
      return 'normal';
  }
}

function sceneInstructionCanSharePredictionSlice(instruction: SceneInstruction): boolean {
  // Keep coalescing intentionally conservative. A number of Scene instructions currently have no
  // asset dependency or mutation summary but can still change authoritative gameplay/Flow state
  // (for example navigation, runtime-world transactions, and Interaction dispatch). Treat only an
  // immediate text presentation as prediction-inert: it introduces no dependency, suspension, or
  // state/reachability distinction for speculative asset prediction.
  return instruction.kind === 'show-text' && instruction.wait === 'immediate';
}

function characterDependency(
  character: { kind: 'character'; id: string },
  options: {
    profileId?: string | null;
    poseId?: string | null;
    expressionId?: string | null;
    appearanceId?: string | null;
  } = {},
): PredictionDependency {
  return {
    kind: 'character',
    character,
    profileId: options.profileId ?? null,
    poseId: options.poseId ?? null,
    expressionId: options.expressionId ?? null,
    appearanceId: options.appearanceId ?? null,
  };
}

function dialogueInitialDependencies(dialogue: DialogueDefinition): PredictionDependency[] {
  const dependencies: PredictionDependency[] = [];
  for (const slot of dialogue.stageSlots) {
    if (slot.initial?.visible)
      dependencies.push(
        characterDependency(slot.initial.character, {
          profileId: slot.initial.profileId,
          poseId: slot.initial.poseId,
          expressionId: slot.initial.expressionId,
          appearanceId: slot.initial.appearanceId,
        }),
      );
  }
  for (const slot of dialogue.mediaSlots) {
    if (!slot.visible || !slot.initial) continue;
    if (slot.initial.kind === 'image')
      dependencies.push({ kind: 'asset', asset: slot.initial.asset });
    else
      dependencies.push(
        characterDependency(slot.initial.character, {
          profileId: slot.initial.profileId,
          poseId: slot.initial.poseId,
          expressionId: slot.initial.expressionId,
          appearanceId: slot.initial.appearanceId,
        }),
      );
  }
  return dependencies;
}

function dialogueSpeaker(
  dialogue: DialogueDefinition,
  block: DialogueSequenceBlock,
  line: DialogueLineSegment,
) {
  return line.speaker ?? block.defaultSpeaker ?? dialogue.defaultSpeaker;
}

function dialogueStageCharacters(dialogue: DialogueDefinition, slotId: string) {
  const characters = new Map<string, { kind: 'character'; id: string }>();
  const initial = dialogue.stageSlots.find((slot) => slot.id === slotId)?.initial;
  if (initial) characters.set(initial.character.id, initial.character);
  for (const block of dialogue.program.blocks) {
    if (block.kind !== 'sequence') continue;
    for (const segment of block.segments) {
      if (segment.kind !== 'line') continue;
      for (const cue of segment.cues) {
        if (cue.kind === 'stage' && cue.mutation.slotId === slotId && cue.mutation.character)
          characters.set(cue.mutation.character.id, cue.mutation.character);
      }
    }
  }
  return [...characters.values()];
}

function dialogueMediaContents(dialogue: DialogueDefinition, slotId: string) {
  const contents: Array<DialogueDefinition['mediaSlots'][number]['initial']> = [];
  const append = (content: DialogueDefinition['mediaSlots'][number]['initial']) => {
    if (!content) return;
    const key = JSON.stringify(content);
    if (!contents.some((candidate) => JSON.stringify(candidate) === key)) contents.push(content);
  };
  append(dialogue.mediaSlots.find((slot) => slot.id === slotId)?.initial ?? null);
  for (const block of dialogue.program.blocks) {
    if (block.kind !== 'sequence') continue;
    for (const segment of block.segments) {
      if (segment.kind !== 'line') continue;
      for (const cue of segment.cues) {
        if (cue.kind === 'media' && cue.mutation.slotId === slotId && cue.mutation.content)
          append(cue.mutation.content);
      }
    }
  }
  return contents;
}

function dialogueCueDependencies(
  dialogue: DialogueDefinition,
  block: DialogueSequenceBlock,
  line: DialogueLineSegment,
  cue: DialogueCue,
): PredictionDependency[] {
  const dependencies: PredictionDependency[] = [];
  switch (cue.kind) {
    case 'speaker-expression': {
      const speaker = dialogueSpeaker(dialogue, block, line);
      if (speaker)
        dependencies.push(characterDependency(speaker, { expressionId: cue.expressionId }));
      break;
    }
    case 'stage': {
      if (cue.mutation.action === 'hide' || cue.mutation.action === 'clear') break;
      const characters = cue.mutation.character
        ? [cue.mutation.character]
        : dialogueStageCharacters(dialogue, cue.mutation.slotId);
      for (const character of characters)
        dependencies.push(
          characterDependency(character, {
            profileId: cue.mutation.profileId,
            poseId: cue.mutation.poseId,
            expressionId: cue.mutation.expressionId,
            appearanceId: cue.mutation.appearanceId,
          }),
        );
      break;
    }
    case 'media': {
      if (cue.mutation.action === 'hide' || cue.mutation.action === 'clear') break;
      const contents = cue.mutation.content
        ? [cue.mutation.content]
        : dialogueMediaContents(dialogue, cue.mutation.slotId);
      for (const content of contents) {
        if (!content) continue;
        if (content.kind === 'image') dependencies.push({ kind: 'asset', asset: content.asset });
        else
          dependencies.push(
            characterDependency(content.character, {
              profileId: content.profileId,
              poseId: content.poseId,
              expressionId: content.expressionId,
              appearanceId: content.appearanceId,
            }),
          );
      }
      break;
    }
    case 'gesture': {
      for (const character of dialogueStageCharacters(dialogue, cue.slotId))
        dependencies.push(characterDependency(character));
      break;
    }
    case 'voice':
      dependencies.push({ kind: 'audio', asset: cue.asset, purpose: 'voice' });
      break;
    case 'sound-effect':
      dependencies.push({ kind: 'audio', asset: cue.asset, purpose: 'sound-effect' });
      break;
    default:
      break;
  }
  return dependencies;
}

function dialogueCueFrontier(cue: DialogueCue): PredictionSlice['frontier'] {
  switch (cue.kind) {
    case 'voice':
    case 'sound-effect':
    case 'gesture':
      return cue.waitForCompletion ? 'strong-wait' : 'normal';
    case 'camera':
      if (!cue.emphasis.waitForCompletion) return 'normal';
      return cue.emphasis.durationMs <= 2_000 ? 'short-wait' : 'strong-wait';
    default:
      return 'normal';
  }
}

/**
 * Compiles runtime-blind speculative prediction metadata from already-lowered Flow definitions.
 * Runtime consumes only this projection for the covered Flow semantics; mandatory dependency
 * collection remains a separate correctness path.
 */
export function compileFlowPredictionIndex(
  project: CompiledProjectWire,
  authoredHints: Readonly<Record<string, PrefetchHint>> = {},
): FlowPredictionIndex | undefined {
  if (
    project.definitions.scenes.length === 0 &&
    project.definitions.dialogues.length === 0 &&
    project.definitions.rooms.length === 0
  )
    return undefined;

  const dependencyGroups: FlowPredictionIndex['dependencyGroups'] = [];
  const dependencyGroupByKey = new Map<string, number>();
  const internDependencyGroup = (
    dependencies: FlowPredictionIndex['dependencyGroups'][number],
  ): number | null => {
    if (dependencies.length === 0) return null;
    const key = JSON.stringify(dependencies);
    const existing = dependencyGroupByKey.get(key);
    if (existing !== undefined) return existing;
    const index = dependencyGroups.length;
    dependencyGroups.push(dependencies);
    dependencyGroupByKey.set(key, index);
    return index;
  };

  const slices: FlowPredictionIndex['slices'] = [];
  const sliceByPoint = new Map<string, number>();
  const pointKey = (point: PredictionPoint): string => JSON.stringify(point);
  const hintedPointKeys = new Set(
    Object.values(authoredHints).flatMap((hint) =>
      hint.attachment.kind === 'point' ? [pointKey(compiledHintPoint(hint.attachment.point))] : [],
    ),
  );
  const addSlice = (
    point: PredictionPoint,
    dependencies: FlowPredictionIndex['dependencyGroups'][number] = [],
    program: PredictionProgram = [],
    options: { condition?: PredictionSlice['condition']; frontier: PredictionSlice['frontier'] } = {
      frontier: 'normal',
    },
  ): number => {
    const dependencyGroup = internDependencyGroup(dependencies);
    const index = slices.length;
    slices.push({
      point,
      dependencyGroups: dependencyGroup === null ? [] : [dependencyGroup],
      ...(options.condition ? { condition: options.condition } : {}),
      conditionFalseSuccessor: null,
      control: { kind: 'sequential', successor: null },
      frontier: options.frontier,
      program,
    });
    sliceByPoint.set(pointKey(point), index);
    return index;
  };
  const addResumePoint = (sliceIndex: number, point: PredictionPoint): void => {
    const slice = slices[sliceIndex];
    if (!slice) return;
    slice.resumePoints ??= [];
    slice.resumePoints.push(point);
    sliceByPoint.set(pointKey(point), sliceIndex);
  };
  const findSlice = (point: PredictionPoint): number | undefined =>
    sliceByPoint.get(pointKey(point));

  for (const scene of project.definitions.scenes) {
    const sceneRef = { kind: 'scene' as const, id: scene.id };
    const stageDependencies: PredictionDependency[] = [];
    if (scene.stage.kind === 'staged-room') {
      stageDependencies.push({ kind: 'room', room: scene.stage.room });
    } else if (scene.stage.kind === 'blank') {
      appendBackgroundDependencies(stageDependencies, scene.stage.background);
      if (scene.stage.layout)
        stageDependencies.push({ kind: 'layout', layout: scene.stage.layout });
    }
    addSlice({ kind: 'scene-entry', scene: sceneRef }, stageDependencies);
    let inertRunSlice: number | null = null;
    for (const event of scene.program.events) {
      const point = { kind: 'scene-step' as const, scene: sceneRef, stepId: event.id };
      const dependencies = sceneInstructionDependencies(event.instruction);
      const program = sceneInstructionProgram(event.instruction);
      const frontier = sceneInstructionFrontier(event.instruction);
      const inert =
        sceneInstructionCanSharePredictionSlice(event.instruction) &&
        dependencies.length === 0 &&
        program.length === 0 &&
        !event.instruction.condition &&
        frontier === 'normal' &&
        !hintedPointKeys.has(pointKey(point)) &&
        event.instruction.kind !== 'conditional-branch' &&
        event.instruction.kind !== 'choice';
      if (inert && inertRunSlice !== null) {
        addResumePoint(inertRunSlice, point);
        continue;
      }
      inertRunSlice = addSlice(point, dependencies, program, {
        condition: event.instruction.condition,
        frontier,
      });
      if (!inert) inertRunSlice = null;
    }
    addSlice({ kind: 'scene-terminal', scene: sceneRef });
  }

  const dialoguePoint = (
    dialogueId: string,
    blockId: string,
    stage: Extract<PredictionPoint, { kind: 'dialogue-position' }>['stage'],
    options: { segmentId?: string; edgeId?: string; cursor?: number } = {},
  ): PredictionPoint => ({
    kind: 'dialogue-position',
    dialogue: { kind: 'dialogue', id: dialogueId },
    blockId,
    stage,
    cursor: options.cursor ?? 0,
    ...(options.segmentId ? { segmentId: options.segmentId } : {}),
    ...(options.edgeId ? { edgeId: options.edgeId } : {}),
  });

  const dialogueTerminalPoint = (dialogueId: string): PredictionPoint => ({
    kind: 'dialogue-terminal',
    dialogue: { kind: 'dialogue', id: dialogueId },
  });

  for (const dialogue of project.definitions.dialogues) {
    const dialogueRef = { kind: 'dialogue' as const, id: dialogue.id };
    addSlice(
      { kind: 'dialogue-entry', dialogue: dialogueRef },
      dialogueInitialDependencies(dialogue),
    );

    for (const block of dialogue.program.blocks) {
      addSlice(dialoguePoint(dialogue.id, block.id, 'enter-block'));
      if (block.kind === 'choice') {
        addSlice(dialoguePoint(dialogue.id, block.id, 'present-choices'), [], [], {
          frontier: 'decision',
        });
        continue;
      }
      if (block.kind !== 'sequence') continue;

      for (const segment of block.segments) {
        if (segment.kind === 'line') {
          const speaker = dialogueSpeaker(dialogue, block, segment);
          for (let cursor = 0; cursor <= segment.cues.length; cursor += 1) {
            const dependencies: PredictionDependency[] = [];
            if (cursor === 0 && speaker) dependencies.push(characterDependency(speaker));
            const cue = segment.cues[cursor];
            if (cue) dependencies.push(...dialogueCueDependencies(dialogue, block, segment, cue));
            addSlice(
              dialoguePoint(dialogue.id, block.id, 'present-segment', {
                segmentId: segment.id,
                cursor,
              }),
              dependencies,
              [],
              {
                condition: cursor === 0 ? segment.condition : undefined,
                frontier:
                  cursor === segment.cues.length
                    ? 'strong-wait'
                    : dialogueCueFrontier(segment.cues[cursor]!),
              },
            );
          }
          for (let cursor = 0; cursor <= segment.effects.length; cursor += 1) {
            addSlice(
              dialoguePoint(dialogue.id, block.id, 'apply-segment-effects', {
                segmentId: segment.id,
                cursor,
              }),
              [],
              cursor < segment.effects.length
                ? summarizeGameplayCommands([segment.effects[cursor]!])
                : [],
            );
          }
          continue;
        }

        let program: PredictionProgram = [];
        let frontier: PredictionSlice['frontier'] = 'normal';
        if (segment.kind === 'call-scene') program = [{ kind: 'call-scene', scene: segment.scene }];
        else if (segment.kind === 'run-lua') {
          program = [{ kind: 'opaque' }];
          if (segment.mayYield) frontier = 'strong-wait';
        } else if (segment.kind === 'handoff') {
          // A Handoff may resume an awaiting Scene before this Dialogue continues, or may have no
          // awaiting Scene and continue immediately. Keep the retained Dialogue continuation
          // reachable but behind a strong semantic frontier; the next runtime publication will
          // replace this plan with the resumed Scene root when a direct handoff exists.
          frontier = 'strong-wait';
        }
        addSlice(
          dialoguePoint(dialogue.id, block.id, 'present-segment', {
            segmentId: segment.id,
          }),
          [],
          program,
          { condition: segment.condition, frontier },
        );
      }
    }

    for (const edge of dialogue.program.edges) {
      addSlice(dialoguePoint(dialogue.id, edge.fromBlockId, 'follow-edge', { edgeId: edge.id }));
      if (edge.kind !== 'choice') continue;
      for (let cursor = 0; cursor <= edge.effects.length; cursor += 1) {
        addSlice(
          dialoguePoint(dialogue.id, edge.fromBlockId, 'apply-choice-effects', {
            edgeId: edge.id,
            cursor,
          }),
          [],
          cursor < edge.effects.length ? summarizeGameplayCommands([edge.effects[cursor]!]) : [],
        );
      }
    }
    addSlice(dialogueTerminalPoint(dialogue.id));
  }

  const lifecycleStages = [
    ['before-leave', 'beforeLeave'],
    ['before-enter', 'beforeEnter'],
    ['presentation', null],
    ['after-leave', 'afterLeave'],
    ['after-enter', 'afterEnter'],
  ] as const;
  for (const room of project.definitions.rooms) {
    for (const [stage, lifecycleField] of lifecycleStages) {
      const dependencies =
        stage === 'presentation'
          ? ([
              { kind: 'room', room: { kind: 'room', id: room.id } },
            ] satisfies FlowPredictionIndex['dependencyGroups'][number])
          : [];
      const program =
        lifecycleField === null ? [] : summarizeGameplayCommands(room.lifecycle[lifecycleField]);
      if (lifecycleField !== null && room.scriptHooks.some((hook) => hook.hook === stage)) {
        // Runtime invokes the Room's Lua hook after the typed lifecycle command program. Keep
        // that ordering in the prediction summary, but treat the Lua boundary as opaque.
        program.push({ kind: 'opaque' });
      }
      addSlice(
        { kind: 'room-lifecycle', room: { kind: 'room', id: room.id }, stage },
        dependencies,
        program,
      );
    }
  }

  for (const interaction of project.definitions.interactions) {
    const interactionRef = { kind: 'interaction' as const, id: interaction.id };
    for (const rule of interaction.rules) {
      addSlice(
        { kind: 'interaction-rule', interaction: interactionRef, ruleId: rule.id },
        [],
        summarizeInteractionProgram(rule.program),
        { condition: rule.guard, frontier: 'normal' },
      );
    }
  }
  for (const verb of project.definitions.verbs) {
    addSlice(
      { kind: 'verb-default', verb: { kind: 'verb', id: verb.id } },
      [],
      summarizeInteractionProgram(verb.defaultProgram),
      { condition: verb.availability, frontier: 'normal' },
    );
  }
  if (project.undefinedInteractionProgram) {
    addSlice(
      { kind: 'undefined-interaction' },
      [],
      summarizeInteractionProgram(project.undefinedInteractionProgram),
    );
  }
  // Resident Layout points are prediction metadata, not a mirror of every Layout resource. Keep
  // default resident surfaces plus Layouts that have an authored precise attachment. Runtime may
  // report additional mounted Layouts, but they need no generated slice until they actually carry
  // prediction-relevant intent.
  const residentLayoutIds = new Set<string>();
  for (const layout of [
    project.settings.interaction.defaultVerbMenuLayout,
    project.settings.inventory.defaultLayout,
  ]) {
    if (layout) residentLayoutIds.add(layout.id);
  }
  for (const hint of Object.values(authoredHints)) {
    if (hint.attachment.kind === 'point' && hint.attachment.point.kind === 'resident-layout')
      residentLayoutIds.add(hint.attachment.point.layout.$ref.id);
  }
  for (const layoutId of [...residentLayoutIds].sort()) {
    const layout = { kind: 'layout' as const, id: layoutId };
    addSlice({ kind: 'resident-layout', layout }, [{ kind: 'layout', layout }]);
  }

  for (const scene of project.definitions.scenes) {
    const sceneRef = { kind: 'scene' as const, id: scene.id };
    const terminalPoint = { kind: 'scene-terminal' as const, scene: sceneRef };
    const terminal = findSlice(terminalPoint);
    const first = scene.program.events[0];
    const firstPoint: PredictionPoint = first
      ? { kind: 'scene-step', scene: sceneRef, stepId: first.id }
      : terminalPoint;
    const entry = findSlice({ kind: 'scene-entry', scene: sceneRef });
    const firstSlice = findSlice(firstPoint);
    if (entry !== undefined)
      slices[entry]!.control = { kind: 'sequential', successor: firstSlice ?? null };

    for (let index = 0; index < scene.program.events.length; index += 1) {
      const event = scene.program.events[index]!;
      const instruction = event.instruction;
      const eventPoint = { kind: 'scene-step' as const, scene: sceneRef, stepId: event.id };
      const sliceIndex = findSlice(eventPoint);
      if (sliceIndex === undefined) continue;
      if (pointKey(slices[sliceIndex]!.point) !== pointKey(eventPoint)) continue;
      let sequential = terminal;
      for (let nextIndex = index + 1; nextIndex < scene.program.events.length; nextIndex += 1) {
        const nextEvent = scene.program.events[nextIndex]!;
        const nextSlice = findSlice({ kind: 'scene-step', scene: sceneRef, stepId: nextEvent.id });
        if (nextSlice !== undefined && nextSlice !== sliceIndex) {
          sequential = nextSlice;
          break;
        }
      }
      slices[sliceIndex]!.conditionFalseSuccessor = instruction.condition
        ? (sequential ?? null)
        : null;

      if (instruction.kind === 'conditional-branch') {
        const branches = instruction.branches.flatMap((branch) => {
          const target = findSlice({
            kind: 'scene-step',
            scene: sceneRef,
            stepId: branch.targetInstructionId,
          });
          return target === undefined ? [] : [{ condition: branch.condition, target }];
        });
        const fallback = findSlice({
          kind: 'scene-step',
          scene: sceneRef,
          stepId: instruction.fallbackInstructionId,
        });
        if (fallback !== undefined)
          slices[sliceIndex]!.control = { kind: 'branch', branches, fallback };
        continue;
      }
      if (instruction.kind === 'choice') {
        const options = instruction.options.flatMap((option) => {
          const target = findSlice({
            kind: 'scene-step',
            scene: sceneRef,
            stepId: option.targetInstructionId,
          });
          return target === undefined
            ? []
            : [
                {
                  optionId: option.id,
                  ...(option.condition ? { condition: option.condition } : {}),
                  programs: option.effects.map((effect) => summarizeGameplayCommands([effect])),
                  target,
                },
              ];
        });
        slices[sliceIndex]!.control = { kind: 'choice', options };
        continue;
      }
      slices[sliceIndex]!.control = { kind: 'sequential', successor: sequential ?? null };
    }

    if (terminal === undefined) continue;
    if (scene.terminal.kind === 'continue-scene') {
      slices[terminal]!.control = {
        kind: 'sequential',
        successor: findSlice({ kind: 'scene-entry', scene: scene.terminal.scene }) ?? null,
      };
    } else if (scene.terminal.kind === 'continue-dialogue') {
      slices[terminal]!.control = {
        kind: 'sequential',
        successor: findSlice({ kind: 'dialogue-entry', dialogue: scene.terminal.dialogue }) ?? null,
      };
    }
  }

  for (const dialogue of project.definitions.dialogues) {
    const entry = findSlice({
      kind: 'dialogue-entry',
      dialogue: { kind: 'dialogue', id: dialogue.id },
    });
    const terminal = findSlice(dialogueTerminalPoint(dialogue.id));
    const entryBlock = findSlice(
      dialoguePoint(dialogue.id, dialogue.program.entryBlockId, 'enter-block'),
    );
    if (entry !== undefined)
      slices[entry]!.control = { kind: 'sequential', successor: entryBlock ?? terminal ?? null };

    const findBlock = (blockId: string) =>
      dialogue.program.blocks.find((candidate) => candidate.id === blockId);
    const nextAfterSequence = (
      block: DialogueSequenceBlock,
      segmentIndex: number,
    ): number | null => {
      const next = block.segments[segmentIndex + 1];
      if (next)
        return (
          findSlice(
            dialoguePoint(dialogue.id, block.id, 'present-segment', {
              segmentId: next.id,
            }),
          ) ?? null
        );
      const edge = dialogue.program.edges.find(
        (candidate) => candidate.kind === 'next' && candidate.fromBlockId === block.id,
      );
      if (edge)
        return (
          findSlice(dialoguePoint(dialogue.id, block.id, 'follow-edge', { edgeId: edge.id })) ??
          null
        );
      return terminal ?? null;
    };

    for (const block of dialogue.program.blocks) {
      const blockEntry = findSlice(dialoguePoint(dialogue.id, block.id, 'enter-block'));
      if (blockEntry === undefined) continue;
      if (block.kind === 'redirect') {
        slices[blockEntry]!.control = {
          kind: 'sequential',
          successor:
            findSlice(dialoguePoint(dialogue.id, block.targetBlockId, 'enter-block')) ?? null,
        };
        continue;
      }
      if (block.kind === 'choice') {
        const choice = findSlice(dialoguePoint(dialogue.id, block.id, 'present-choices'));
        slices[blockEntry]!.control = { kind: 'sequential', successor: choice ?? null };
        if (choice !== undefined) {
          slices[choice]!.control = {
            kind: 'choice',
            options: dialogue.program.edges.flatMap((edge) => {
              if (edge.kind !== 'choice' || edge.fromBlockId !== block.id) return [];
              const target = findSlice(
                dialoguePoint(dialogue.id, block.id, 'apply-choice-effects', {
                  edgeId: edge.id,
                }),
              );
              return target === undefined
                ? []
                : [
                    {
                      optionId: edge.id,
                      ...(edge.condition ? { condition: edge.condition } : {}),
                      programs: [],
                      target,
                    },
                  ];
            }),
          };
        }
        continue;
      }

      const first = block.segments[0];
      slices[blockEntry]!.control = {
        kind: 'sequential',
        successor: first
          ? (findSlice(
              dialoguePoint(dialogue.id, block.id, 'present-segment', {
                segmentId: first.id,
              }),
            ) ?? null)
          : nextAfterSequence(block, -1),
      };

      for (let segmentIndex = 0; segmentIndex < block.segments.length; segmentIndex += 1) {
        const segment = block.segments[segmentIndex]!;
        const next = nextAfterSequence(block, segmentIndex);
        if (segment.kind === 'line') {
          for (let cursor = 0; cursor <= segment.cues.length; cursor += 1) {
            const sliceIndex = findSlice(
              dialoguePoint(dialogue.id, block.id, 'present-segment', {
                segmentId: segment.id,
                cursor,
              }),
            );
            if (sliceIndex === undefined) continue;
            slices[sliceIndex]!.conditionFalseSuccessor = cursor === 0 ? next : null;
            slices[sliceIndex]!.control = {
              kind: 'sequential',
              successor:
                cursor < segment.cues.length
                  ? (findSlice(
                      dialoguePoint(dialogue.id, block.id, 'present-segment', {
                        segmentId: segment.id,
                        cursor: cursor + 1,
                      }),
                    ) ?? null)
                  : (findSlice(
                      dialoguePoint(dialogue.id, block.id, 'apply-segment-effects', {
                        segmentId: segment.id,
                      }),
                    ) ?? null),
            };
          }
          for (let cursor = 0; cursor <= segment.effects.length; cursor += 1) {
            const sliceIndex = findSlice(
              dialoguePoint(dialogue.id, block.id, 'apply-segment-effects', {
                segmentId: segment.id,
                cursor,
              }),
            );
            if (sliceIndex !== undefined)
              slices[sliceIndex]!.control = {
                kind: 'sequential',
                successor:
                  cursor < segment.effects.length
                    ? (findSlice(
                        dialoguePoint(dialogue.id, block.id, 'apply-segment-effects', {
                          segmentId: segment.id,
                          cursor: cursor + 1,
                        }),
                      ) ?? null)
                    : next,
              };
          }
          continue;
        }

        const sliceIndex = findSlice(
          dialoguePoint(dialogue.id, block.id, 'present-segment', { segmentId: segment.id }),
        );
        if (sliceIndex === undefined) continue;
        slices[sliceIndex]!.conditionFalseSuccessor = next;
        slices[sliceIndex]!.control = { kind: 'sequential', successor: next };
      }
    }

    for (const edge of dialogue.program.edges) {
      if (edge.kind === 'choice') {
        for (let cursor = 0; cursor <= edge.effects.length; cursor += 1) {
          const sliceIndex = findSlice(
            dialoguePoint(dialogue.id, edge.fromBlockId, 'apply-choice-effects', {
              edgeId: edge.id,
              cursor,
            }),
          );
          if (sliceIndex !== undefined)
            slices[sliceIndex]!.control = {
              kind: 'sequential',
              successor:
                cursor < edge.effects.length
                  ? (findSlice(
                      dialoguePoint(dialogue.id, edge.fromBlockId, 'apply-choice-effects', {
                        edgeId: edge.id,
                        cursor: cursor + 1,
                      }),
                    ) ?? null)
                  : (findSlice(
                      dialoguePoint(dialogue.id, edge.fromBlockId, 'follow-edge', {
                        edgeId: edge.id,
                      }),
                    ) ?? null),
            };
        }
      }
      const follow = findSlice(
        dialoguePoint(dialogue.id, edge.fromBlockId, 'follow-edge', { edgeId: edge.id }),
      );
      if (follow !== undefined)
        slices[follow]!.control = {
          kind: 'sequential',
          successor: findBlock(edge.toBlockId)
            ? (findSlice(dialoguePoint(dialogue.id, edge.toBlockId, 'enter-block')) ?? null)
            : null,
        };
    }

    if (terminal !== undefined) {
      if (dialogue.completion.kind === 'scene')
        slices[terminal]!.program = [{ kind: 'call-scene', scene: dialogue.completion.scene }];
      else if (dialogue.completion.kind === 'dialogue')
        slices[terminal]!.program = [
          { kind: 'call-dialogue', dialogue: dialogue.completion.dialogue },
        ];
      else if (dialogue.completion.kind === 'room')
        slices[terminal]!.program = [{ kind: 'enter-room', room: dialogue.completion.room }];
    }
  }

  const roomEntryRoots = (roomId: string): number[] =>
    (['before-enter', 'presentation', 'after-enter'] as const)
      .map((stage) =>
        findSlice({
          kind: 'room-lifecycle',
          room: { kind: 'room', id: roomId },
          stage,
        }),
      )
      .filter((value): value is number => value !== undefined);

  const targetRoots = (
    target: NonNullable<FlowPredictionIndex['supplementalHints']>[number]['target'],
  ): number[] => {
    if (target.kind === 'scene') {
      const root = findSlice({ kind: 'scene-entry', scene: target.scene });
      return root === undefined ? [] : [root];
    }
    if (target.kind === 'dialogue') {
      const root = findSlice({ kind: 'dialogue-entry', dialogue: target.dialogue });
      return root === undefined ? [] : [root];
    }
    if (target.kind === 'room') return roomEntryRoots(target.room.id);
    return [];
  };

  const entryPathHintRoots = (roomId: string): number[] =>
    Object.values(authoredHints).flatMap((hint) =>
      hint.attachment.kind === 'room' &&
      hint.attachment.scope === 'entry-path' &&
      hint.attachment.room.$ref.id === roomId
        ? targetRoots(compiledHintTarget(hint.target))
        : [],
    );

  const programRoots = (program: PredictionProgram): number[] => {
    const roots: number[] = [];
    const add = (slice: number | undefined) => {
      if (slice !== undefined) roots.push(slice);
    };
    for (const command of program) {
      if (command.kind === 'call-scene' || command.kind === 'start-detached-scene') {
        add(findSlice({ kind: 'scene-entry', scene: command.scene }));
      } else if (command.kind === 'call-dialogue') {
        add(findSlice({ kind: 'dialogue-entry', dialogue: command.dialogue }));
      } else if (command.kind === 'enter-room') {
        roots.push(...roomEntryRoots(command.room.id), ...entryPathHintRoots(command.room.id));
      } else if (command.kind === 'if') {
        const truth = staticPredictionTruth(command.condition);
        if (truth !== 'false') roots.push(...programRoots(command.thenCommands));
        if (truth !== 'true') roots.push(...programRoots(command.elseCommands));
      }
    }
    return roots;
  };

  const controlSuccessors = (slice: PredictionSlice): number[] => {
    if (slice.control.kind === 'sequential')
      return slice.control.successor === null ? [] : [slice.control.successor];
    if (slice.control.kind === 'choice') {
      const targets: number[] = [];
      for (const option of slice.control.options) {
        if (option.condition && staticPredictionTruth(option.condition) === 'false') continue;
        for (const program of option.programs) targets.push(...programRoots(program));
        targets.push(option.target);
      }
      return targets;
    }

    const targets: number[] = [];
    let fallthrough = true;
    for (const branch of slice.control.branches) {
      const truth = staticPredictionTruth(branch.condition);
      if (truth === 'false') continue;
      targets.push(branch.target);
      if (truth === 'true') {
        fallthrough = false;
        break;
      }
    }
    if (fallthrough) targets.push(slice.control.fallback);
    return targets;
  };

  const potentialExpansionSlices = (
    target: NonNullable<FlowPredictionIndex['supplementalHints']>[number]['target'],
  ): number[] => {
    const roots = targetRoots(target);
    if (target.kind === 'room') roots.push(...entryPathHintRoots(target.room.id));

    const pending = [...roots];
    const traversed = new Set<number>();
    const dependencySlices: number[] = [];
    while (pending.length > 0 && traversed.size < 4096) {
      const sliceIndex = pending.shift()!;
      if (traversed.has(sliceIndex)) continue;
      const slice = slices[sliceIndex];
      if (!slice) continue;
      traversed.add(sliceIndex);

      const truth = slice.condition ? staticPredictionTruth(slice.condition) : 'true';
      if (truth !== 'false') {
        dependencySlices.push(sliceIndex);
        for (const nested of Object.values(authoredHints)) {
          if (nested.attachment.kind !== 'point') continue;
          const attachment = findSlice(compiledHintPoint(nested.attachment.point));
          if (attachment === sliceIndex)
            pending.push(...targetRoots(compiledHintTarget(nested.target)));
        }
        pending.push(...programRoots(slice.program), ...controlSuccessors(slice));
      }
      if (slice.conditionFalseSuccessor !== null && truth !== 'true')
        pending.push(slice.conditionFalseSuccessor);
    }
    return dependencySlices;
  };

  const supplementalHints: NonNullable<FlowPredictionIndex['supplementalHints']> = [];
  for (const hint of Object.values(authoredHints).sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    if (hint.attachment.kind === 'point') {
      const slice = findSlice(compiledHintPoint(hint.attachment.point));
      if (slice === undefined) continue;
      supplementalHints.push({
        id: hint.id,
        target: compiledHintTarget(hint.target),
        potentialExpansionSlices: potentialExpansionSlices(compiledHintTarget(hint.target)),
        attachment: { kind: 'point', slice },
      });
      continue;
    }
    const target = compiledHintTarget(hint.target);
    supplementalHints.push({
      id: hint.id,
      target,
      potentialExpansionSlices: potentialExpansionSlices(target),
      attachment: {
        kind: 'room',
        room: { kind: 'room', id: hint.attachment.room.$ref.id },
        scope: hint.attachment.scope,
      },
    });
  }

  return { dependencyGroups, supplementalHints, slices };
}
