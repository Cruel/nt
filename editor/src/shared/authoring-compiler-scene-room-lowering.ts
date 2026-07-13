import type { CompiledCondition, CompiledEffect, CompiledFlowTarget, CompiledProjectWireV1, CompiledText, SceneProgram } from './project-schema/compiled-project';
import type { Condition, Effect, FlowTarget, TextContent } from './project-schema/authoring-flow';
import type { AuthoringProject } from './project-schema/authoring-project';
import { parseRoomData } from './project-schema/authoring-rooms';
import { parseSceneData, type SceneStepData } from './project-schema/authoring-scenes';
import type {
  CompiledProjectSharedDraft,
  SharedDialogueDefinition,
  SharedInteractionDefinition,
  SharedVerbDefinition,
} from './authoring-compiler-shared-lowering';

export interface ProgramLoweringDiagnostic {
  code: string;
  path: string;
  message: string;
}

type WireDefinitions = CompiledProjectWireV1['definitions'];

/** Phase 4D's non-publishable draft. Dialogue and Interaction programs remain owned by Phase 4E. */
export interface CompiledProjectSceneRoomDraft extends Omit<CompiledProjectSharedDraft, 'definitions'> {
  definitions: {
    characters: WireDefinitions['characters'];
    rooms: WireDefinitions['rooms'];
    interactables: WireDefinitions['interactables'];
    verbs: SharedVerbDefinition[];
    interactions: SharedInteractionDefinition[];
    scenes: WireDefinitions['scenes'];
    dialogues: SharedDialogueDefinition[];
    maps: WireDefinitions['maps'];
  };
}

export interface SceneRoomLoweringResult {
  diagnostics: ProgramLoweringDiagnostic[];
  draft?: CompiledProjectSceneRoomDraft;
}

const assetRef = (ref: { $ref: { id: string } } | null) => ref ? { kind: 'asset' as const, id: ref.$ref.id } : null;
const materialRef = (ref: { $ref: { id: string } } | null) => ref ? { kind: 'material' as const, id: ref.$ref.id } : null;
const layoutRef = (ref: { $ref: { id: string } } | null) => ref ? { kind: 'layout' as const, id: ref.$ref.id } : null;
const characterRef = (ref: { $ref: { id: string } } | null) => ref ? { kind: 'character' as const, id: ref.$ref.id } : null;

function compileText(text: TextContent): CompiledText {
  return { markup: text.markup, source: { ...text.source } };
}

function compileCondition(condition: Condition): CompiledCondition {
  if (condition.kind !== 'variable-comparison') return { ...condition };
  return {
    kind: condition.kind,
    operator: condition.operator,
    variable: { kind: 'variable', id: condition.variable.$ref.id },
    ...(condition.value === undefined ? {} : { value: condition.value }),
  };
}

function compileEffect(effect: Effect): CompiledEffect {
  if (effect.kind === 'run-lua-effect') return { ...effect };
  return { kind: 'set-variable', variable: { kind: 'variable', id: effect.variable.$ref.id }, value: effect.value };
}

function compileFlowTarget(target: FlowTarget): CompiledFlowTarget {
  switch (target.kind) {
    case 'scene': return { kind: 'scene', scene: { kind: 'scene', id: target.id } };
    case 'dialogue': return { kind: 'dialogue', dialogue: { kind: 'dialogue', id: target.id } };
    case 'room': return { kind: 'room', room: { kind: 'room', id: target.id } };
    case 'return': return { kind: 'return' };
    case 'end': return { kind: 'end' };
  }
}

function common(step: Exclude<SceneStepData, { type: 'comment' }>) {
  return {
    id: step.id,
    ...(step.condition === undefined ? {} : { condition: compileCondition(step.condition) }),
  };
}

function compileSceneStep(step: Exclude<SceneStepData, { type: 'comment' }>): SceneProgram['instructions'][number] {
  const base = common(step);
  switch (step.type) {
    case 'set-background': return { ...base, kind: 'set-background', asset: assetRef(step.asset), material: materialRef(step.material), color: step.color, fit: step.fit, transition: step.transition };
    case 'actor-cue': return { ...base, kind: 'actor-cue', slotId: step.slotId, character: characterRef(step.character)!, action: step.action, poseId: step.poseId, expressionId: step.expressionId, position: step.position, offset: { ...step.offset }, scale: step.scale, transition: step.transition };
    case 'call-dialogue': return { ...base, kind: 'call-dialogue', dialogue: { kind: 'dialogue', id: step.dialogue.$ref.id }, startBlockId: step.startBlockId, autosaveSafePoint: step.autosaveSafePoint };
    case 'show-text': return { ...base, kind: 'show-text', text: compileText(step.text), speaker: characterRef(step.speaker), wait: step.wait, autosaveSafePoint: step.autosaveSafePoint };
    case 'audio-cue': return { ...base, kind: 'audio-cue', asset: assetRef(step.asset), channel: step.channel, action: step.action, loop: step.loop, volume: step.volume, fadeMs: step.fadeMs, waitForCompletion: step.waitForCompletion };
    case 'set-variable': return { ...base, kind: 'set-variable', variable: { kind: 'variable', id: step.variable.$ref.id }, value: step.value };
    case 'run-lua': return { ...base, kind: 'run-lua', source: step.source, mayYield: step.mayYield, autosaveSafePoint: step.autosaveSafePoint };
    case 'wait': return step.waitKind === 'duration'
      ? { ...base, kind: 'wait-duration', durationMs: step.durationMs, skippable: step.skippable }
      : { ...base, kind: 'wait-input', skippable: step.skippable };
    case 'conditional-branch': return { ...base, kind: 'conditional-branch', branches: step.branches.map((branch) => ({ id: branch.id, condition: compileCondition(branch.condition), targetInstructionId: branch.targetStepId })), fallbackInstructionId: step.fallbackStepId };
    case 'choice': return { ...base, kind: 'choice', prompt: step.prompt ? compileText(step.prompt) : null, options: step.options.map((option) => ({ id: option.id, label: compileText(option.label), ...(option.condition === undefined ? {} : { condition: compileCondition(option.condition) }), effects: option.effects.map(compileEffect), targetInstructionId: option.targetStepId })), autosaveSafePoint: step.autosaveSafePoint };
    case 'set-layout': return { ...base, kind: 'set-layout', layout: layoutRef(step.layout), action: step.action, slot: step.slot };
    case 'transition': return { ...base, kind: 'transition', transitionKind: step.transitionKind, durationMs: step.durationMs, color: step.color, waitForCompletion: step.waitForCompletion };
  }
}

export function lowerSceneAndRoomPrograms(project: AuthoringProject, shared: CompiledProjectSharedDraft): SceneRoomLoweringResult {
  const diagnostics: ProgramLoweringDiagnostic[] = [];
  const scenes: WireDefinitions['scenes'] = [];
  for (const scene of shared.definitions.scenes) {
    const data = parseSceneData(project.scenes[scene.id]?.data);
    if (!data) {
      diagnostics.push({ code: 'COMPILER_SCENE_DATA_MISSING', path: `/scenes/${scene.id}/data`, message: 'Validated Scene data could not be lowered.' });
      continue;
    }
    const executableIds = new Set(data.steps.filter((step) => step.type !== 'comment' && step.enabled).map((step) => step.id));
    data.steps.forEach((step, index) => {
      if (step.type === 'comment' || !step.enabled) return;
      const targets = step.type === 'conditional-branch'
        ? [...step.branches.map((branch) => branch.targetStepId), step.fallbackStepId]
        : step.type === 'choice' ? step.options.map((option) => option.targetStepId) : [];
      targets.forEach((target) => {
        if (!executableIds.has(target)) diagnostics.push({ code: 'COMPILER_SCENE_TARGET_NOT_EXECUTABLE', path: `/scenes/${scene.id}/data/steps/${index}`, message: `Scene target '${target}' does not name an enabled runtime instruction.` });
      });
      if (step.type === 'actor-cue') {
        const character = project.characters[step.character.$ref.id];
        const characterData = character?.data;
        const poses = characterData && typeof characterData === 'object' && 'poses' in characterData && Array.isArray(characterData.poses) ? characterData.poses : [];
        const expressions = characterData && typeof characterData === 'object' && 'expressions' in characterData && Array.isArray(characterData.expressions) ? characterData.expressions : [];
        if (step.poseId && !poses.some((pose) => typeof pose === 'object' && pose !== null && 'id' in pose && pose.id === step.poseId)) diagnostics.push({ code: 'COMPILER_SCENE_POSE_MISSING', path: `/scenes/${scene.id}/data/steps/${index}/poseId`, message: `Pose '${step.poseId}' does not exist on Character '${step.character.$ref.id}'.` });
        if (step.expressionId && !expressions.some((expression) => typeof expression === 'object' && expression !== null && 'id' in expression && expression.id === step.expressionId)) diagnostics.push({ code: 'COMPILER_SCENE_EXPRESSION_MISSING', path: `/scenes/${scene.id}/data/steps/${index}/expressionId`, message: `Expression '${step.expressionId}' does not exist on Character '${step.character.$ref.id}'.` });
      }
      if (step.type === 'call-dialogue' && step.startBlockId) {
        const dialogue = project.dialogues[step.dialogue.$ref.id];
        const dialogueData = dialogue?.data;
        const blocks = dialogueData && typeof dialogueData === 'object' && 'blocks' in dialogueData && Array.isArray(dialogueData.blocks) ? dialogueData.blocks : [];
        if (!blocks.some((block) => typeof block === 'object' && block !== null && 'id' in block && block.id === step.startBlockId)) diagnostics.push({ code: 'COMPILER_SCENE_DIALOGUE_BLOCK_MISSING', path: `/scenes/${scene.id}/data/steps/${index}/startBlockId`, message: `Dialogue block '${step.startBlockId}' does not exist in Dialogue '${step.dialogue.$ref.id}'.` });
      }
    });
    scenes.push({ ...scene, program: { instructions: data.steps.filter((step): step is Exclude<SceneStepData, { type: 'comment' }> => step.type !== 'comment' && step.enabled).map(compileSceneStep) }, continuation: compileFlowTarget(data.continuation) });
  }

  const hookNames = [
    ['beforeEnter', 'before-enter'], ['afterEnter', 'after-enter'],
    ['beforeLeave', 'before-leave'], ['afterLeave', 'after-leave'],
  ] as const;
  const rooms: WireDefinitions['rooms'] = [];
  for (const room of shared.definitions.rooms) {
    const data = parseRoomData(project.rooms[room.id]?.data);
    if (!data) {
      diagnostics.push({ code: 'COMPILER_ROOM_DATA_MISSING', path: `/rooms/${room.id}/data`, message: 'Validated Room data could not be lowered.' });
      continue;
    }
    rooms.push({ ...room, lifecycle: { ...room.lifecycle, hooks: hookNames.map(([field, hook]) => ({ hook, effects: data.lifecycle[field].map(compileEffect) })) } });
  }

  if (diagnostics.length > 0) return { diagnostics };
  return { diagnostics, draft: { ...shared, definitions: { ...shared.definitions, rooms, scenes } } };
}
