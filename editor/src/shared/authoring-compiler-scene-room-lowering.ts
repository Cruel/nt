import type {
  CompiledCondition,
  CompiledEffect,
  CompiledFlowTarget,
  CompiledProjectWire,
  CompiledText,
  SceneProgram,
} from './project-schema/compiled-project';
import type { Condition, Effect, FlowTarget, TextContent } from './project-schema/authoring-flow';
import type { AuthoringProject } from './project-schema/authoring-project';
import { resolveMaterialData } from './project-schema/authoring-materials';
import { parseShaderData, type ShaderUniformValue } from './project-schema/authoring-shaders';
import {
  parseSceneData,
  type SceneStepData,
  type SceneTransitionGroupChildData,
} from './project-schema/authoring-scenes';
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

type WireDefinitions = CompiledProjectWire['definitions'];

/** Non-publishable Scene/Room draft. Dialogue and Interaction programs are lowered separately. */
export interface CompiledProjectSceneRoomDraft extends Omit<
  CompiledProjectSharedDraft,
  'definitions'
> {
  definitions: {
    characters: WireDefinitions['characters'];
    rooms: WireDefinitions['rooms'];
    interactables: WireDefinitions['interactables'];
    itemDefinitions: WireDefinitions['itemDefinitions'];
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

const assetRef = (ref: { $ref: { id: string } } | null) =>
  ref ? { kind: 'asset' as const, id: ref.$ref.id } : null;
const materialRef = (ref: { $ref: { id: string } } | null) =>
  ref ? { kind: 'material' as const, id: ref.$ref.id } : null;
const layoutRef = (ref: { $ref: { id: string } } | null) =>
  ref ? { kind: 'layout' as const, id: ref.$ref.id } : null;
const characterRef = (ref: { $ref: { id: string } } | null) =>
  ref ? { kind: 'character' as const, id: ref.$ref.id } : null;

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

function common(step: Exclude<SceneStepData, { type: 'comment' }>) {
  return {
    id: step.id,
    ...(step.condition === undefined ? {} : { condition: compileCondition(step.condition) }),
  };
}

function compileMaterialParameterValue(
  project: AuthoringProject,
  materialId: string,
  parameter: string,
  value: ShaderUniformValue,
): Extract<SceneProgram['instructions'][number], { kind: 'material-parameter' }>['value'] {
  const material = resolveMaterialData(project, materialId).data;
  const shaderId = material?.shader?.$ref.id;
  const uniform = shaderId
    ? parseShaderData(project.shaders[shaderId]?.data)?.uniforms.find(
        (item) => item.name === parameter,
      )
    : undefined;
  if (!uniform || value === null)
    throw new Error(`Validated Material Parameter '${materialId}.${parameter}' cannot be lowered.`);
  switch (uniform.type) {
    case 'float':
      return { type: 'float', value: value as number };
    case 'vec2':
      return { type: 'vec2', value: value as [number, number] };
    case 'vec3':
      return { type: 'vec3', value: value as [number, number, number] };
    case 'vec4':
      return { type: 'vec4', value: value as [number, number, number, number] };
    case 'color':
      return { type: 'color', value: value as { r: number; g: number; b: number; a: number } };
    case 'int':
      return { type: 'int', value: value as number };
    case 'bool':
      return { type: 'bool', value: value as boolean };
  }
}

function compileTransitionGroupChild(
  child: SceneTransitionGroupChildData,
): Extract<SceneProgram['instructions'][number], { kind: 'transition-group' }>['children'][number] {
  switch (child.type) {
    case 'set-background':
      return {
        id: child.id,
        kind: 'set-background',
        asset: assetRef(child.asset),
        material: materialRef(child.material),
        color: child.color,
        fit: child.fit,
      };
    case 'clear-background':
      return { id: child.id, kind: 'clear-background' };
    case 'actor-cue':
      return {
        id: child.id,
        kind: 'actor-cue',
        slotId: child.slotId,
        character: characterRef(child.character)!,
        action: child.action,
        poseId: child.poseId,
        expressionId: child.expressionId,
        position: child.position,
        offset: { ...child.offset },
        scale: child.scale,
      };
    case 'set-layout':
      return {
        id: child.id,
        kind: 'set-layout',
        layout: layoutRef(child.layout),
        action: child.action,
        ...(child.scaleOverrides ? { scaleOverrides: { ...child.scaleOverrides } } : {}),
        slot: child.slot as 'overlay' | 'custom',
        plane: 'world-overlay',
      };
  }
}

function compileSceneStep(
  project: AuthoringProject,
  step: Exclude<SceneStepData, { type: 'comment' }>,
): SceneProgram['instructions'][number] {
  const base = common(step);
  switch (step.type) {
    case 'set-background':
      return {
        ...base,
        kind: 'set-background',
        asset: assetRef(step.asset),
        material: materialRef(step.material),
        color: step.color,
        fit: step.fit,
        transition: step.transition,
        durationMs: step.durationMs,
        waitForCompletion: step.waitForCompletion,
        skippable: step.skippable,
      };
    case 'actor-cue':
      return {
        ...base,
        kind: 'actor-cue',
        slotId: step.slotId,
        character: characterRef(step.character)!,
        action: step.action,
        poseId: step.poseId,
        expressionId: step.expressionId,
        position: step.position,
        offset: { ...step.offset },
        scale: step.scale,
        transition: step.transition,
        durationMs: step.durationMs,
        waitForCompletion: step.waitForCompletion,
        skippable: step.skippable,
      };
    case 'call-dialogue':
      return {
        ...base,
        kind: 'call-dialogue',
        dialogue: { kind: 'dialogue', id: step.dialogue.$ref.id },
        startBlockId: step.startBlockId,
        autosaveSafePoint: step.autosaveSafePoint,
      };
    case 'show-text':
      return {
        ...base,
        kind: 'show-text',
        text: compileText(step.text),
        speaker: characterRef(step.speaker),
        wait: step.wait,
        autosaveSafePoint: step.autosaveSafePoint,
      };
    case 'audio-cue':
      return {
        ...base,
        kind: 'audio-cue',
        asset: assetRef(step.asset),
        purpose: step.purpose,
        action: step.action,
        lifetime: step.lifetime,
        pausePolicy: step.pausePolicy,
        gain: step.gain,
        pan: step.pan,
        panSource:
          step.panSource?.kind === 'room-anchor'
            ? {
                kind: 'room-anchor' as const,
                room: { kind: 'room' as const, id: step.panSource.room.$ref.id },
                anchorId: step.panSource.anchorId,
              }
            : step.panSource
              ? { kind: 'scene-actor' as const, slotId: step.panSource.slotId }
              : null,
        fadeMs: step.fadeMs,
        waitForCompletion: step.waitForCompletion,
        causality: step.causality,
        synchronized: step.synchronized,
        skipBehavior: step.skipBehavior,
        instanceId: step.instanceId,
        replacementGroup: step.replacementGroup,
      };
    case 'set-variable':
      return {
        ...base,
        kind: 'set-global-property',
        property: { kind: 'property', id: step.variable.$ref.id },
        value: step.value,
      };
    case 'run-lua':
      return {
        ...base,
        kind: 'run-lua',
        source: step.source,
        mayYield: step.mayYield,
        autosaveSafePoint: step.autosaveSafePoint,
      };
    case 'wait':
      return step.waitKind === 'duration'
        ? { ...base, kind: 'wait-duration', durationMs: step.durationMs, skippable: step.skippable }
        : { ...base, kind: 'wait-input', skippable: step.skippable };
    case 'conditional-branch':
      return {
        ...base,
        kind: 'conditional-branch',
        branches: step.branches.map((branch) => ({
          id: branch.id,
          condition: compileCondition(branch.condition),
          targetInstructionId: branch.targetStepId,
        })),
        fallbackInstructionId: step.fallbackStepId,
      };
    case 'choice':
      return {
        ...base,
        kind: 'choice',
        prompt: step.prompt ? compileText(step.prompt) : null,
        options: step.options.map((option) => ({
          id: option.id,
          label: compileText(option.label),
          ...(option.condition === undefined
            ? {}
            : { condition: compileCondition(option.condition) }),
          effects: option.effects.map(compileEffect),
          targetInstructionId: option.targetStepId,
        })),
        autosaveSafePoint: step.autosaveSafePoint,
      };
    case 'set-layout':
      return {
        ...base,
        kind: 'set-layout',
        layout: layoutRef(step.layout),
        action: step.action,
        ...(step.scaleOverrides ? { scaleOverrides: { ...step.scaleOverrides } } : {}),
        slot: step.slot,
        transition: step.transition,
        durationMs: step.durationMs,
        waitForCompletion: step.waitForCompletion,
        skippable: step.skippable,
      };
    case 'material-parameter':
      return {
        ...base,
        kind: 'material-parameter',
        target: { ...step.target },
        material: materialRef(step.material)!,
        parameter: step.parameter,
        value: compileMaterialParameterValue(
          project,
          step.material.$ref.id,
          step.parameter,
          step.value,
        ),
        transition: step.transition,
        durationMs: step.durationMs,
        easing: step.easing,
        clock: step.clock,
        waitForCompletion: step.waitForCompletion,
        skippable: step.skippable,
      };
    case 'postprocess-effect':
      return {
        ...base,
        kind: 'postprocess-effect',
        action: step.action,
        instanceId: step.instanceId,
        material: materialRef(step.material),
        scope: step.scope,
        order: step.order,
        clock: step.clock,
        parameters: step.parameters.map((parameter) => ({
          name: parameter.name,
          value: compileMaterialParameterValue(
            project,
            step.material!.$ref.id,
            parameter.name,
            parameter.value,
          ),
        })),
      };
    case 'transition-group':
      return {
        ...base,
        kind: 'transition-group',
        transitionKind: step.transitionKind,
        durationMs: step.durationMs,
        color: step.color,
        waitForCompletion: step.waitForCompletion,
        skippable: step.skippable,
        children: step.children.map(compileTransitionGroupChild),
      };
  }
}

export function lowerSceneAndRoomPrograms(
  project: AuthoringProject,
  shared: CompiledProjectSharedDraft,
): SceneRoomLoweringResult {
  const diagnostics: ProgramLoweringDiagnostic[] = [];
  const scenes: WireDefinitions['scenes'] = [];
  for (const scene of shared.definitions.scenes) {
    const data = parseSceneData(project.scenes[scene.id]?.data);
    if (!data) {
      diagnostics.push({
        code: 'COMPILER_SCENE_DATA_MISSING',
        path: `/scenes/${scene.id}/data`,
        message: 'Validated Scene data could not be lowered.',
      });
      continue;
    }
    const executableIds = new Set(
      data.steps.filter((step) => step.type !== 'comment' && step.enabled).map((step) => step.id),
    );
    data.steps.forEach((step, index) => {
      if (step.type === 'comment' || !step.enabled) return;
      const targets =
        step.type === 'conditional-branch'
          ? [...step.branches.map((branch) => branch.targetStepId), step.fallbackStepId]
          : step.type === 'choice'
            ? step.options.map((option) => option.targetStepId)
            : [];
      targets.forEach((target) => {
        if (!executableIds.has(target))
          diagnostics.push({
            code: 'COMPILER_SCENE_TARGET_NOT_EXECUTABLE',
            path: `/scenes/${scene.id}/data/steps/${index}`,
            message: `Scene target '${target}' does not name an enabled runtime instruction.`,
          });
      });
      if (step.type === 'actor-cue') {
        const character = project.characters[step.character.$ref.id];
        const characterData = character?.data;
        const poses =
          characterData &&
          typeof characterData === 'object' &&
          'poses' in characterData &&
          Array.isArray(characterData.poses)
            ? characterData.poses
            : [];
        const expressions =
          characterData &&
          typeof characterData === 'object' &&
          'expressions' in characterData &&
          Array.isArray(characterData.expressions)
            ? characterData.expressions
            : [];
        if (
          step.poseId &&
          !poses.some(
            (pose) =>
              typeof pose === 'object' && pose !== null && 'id' in pose && pose.id === step.poseId,
          )
        )
          diagnostics.push({
            code: 'COMPILER_SCENE_POSE_MISSING',
            path: `/scenes/${scene.id}/data/steps/${index}/poseId`,
            message: `Pose '${step.poseId}' does not exist on Character '${step.character.$ref.id}'.`,
          });
        if (
          step.expressionId &&
          !expressions.some(
            (expression) =>
              typeof expression === 'object' &&
              expression !== null &&
              'id' in expression &&
              expression.id === step.expressionId,
          )
        )
          diagnostics.push({
            code: 'COMPILER_SCENE_EXPRESSION_MISSING',
            path: `/scenes/${scene.id}/data/steps/${index}/expressionId`,
            message: `Expression '${step.expressionId}' does not exist on Character '${step.character.$ref.id}'.`,
          });
      }
      if (step.type === 'transition-group') {
        step.children.forEach((child, childIndex) => {
          if (child.type !== 'actor-cue') return;
          const character = project.characters[child.character.$ref.id];
          const characterData = character?.data;
          const poses =
            characterData &&
            typeof characterData === 'object' &&
            'poses' in characterData &&
            Array.isArray(characterData.poses)
              ? characterData.poses
              : [];
          const expressions =
            characterData &&
            typeof characterData === 'object' &&
            'expressions' in characterData &&
            Array.isArray(characterData.expressions)
              ? characterData.expressions
              : [];
          if (
            child.poseId &&
            !poses.some(
              (pose) =>
                typeof pose === 'object' &&
                pose !== null &&
                'id' in pose &&
                pose.id === child.poseId,
            )
          )
            diagnostics.push({
              code: 'COMPILER_SCENE_TRANSITION_GROUP_POSE_MISSING',
              path: `/scenes/${scene.id}/data/steps/${index}/children/${childIndex}/poseId`,
              message: `Pose '${child.poseId}' does not exist on Character '${child.character.$ref.id}'.`,
            });
          if (
            child.expressionId &&
            !expressions.some(
              (expression) =>
                typeof expression === 'object' &&
                expression !== null &&
                'id' in expression &&
                expression.id === child.expressionId,
            )
          )
            diagnostics.push({
              code: 'COMPILER_SCENE_TRANSITION_GROUP_EXPRESSION_MISSING',
              path: `/scenes/${scene.id}/data/steps/${index}/children/${childIndex}/expressionId`,
              message: `Expression '${child.expressionId}' does not exist on Character '${child.character.$ref.id}'.`,
            });
        });
      }
      if (step.type === 'call-dialogue' && step.startBlockId) {
        const dialogue = project.dialogues[step.dialogue.$ref.id];
        const dialogueData = dialogue?.data;
        const blocks =
          dialogueData &&
          typeof dialogueData === 'object' &&
          'blocks' in dialogueData &&
          Array.isArray(dialogueData.blocks)
            ? dialogueData.blocks
            : [];
        if (
          !blocks.some(
            (block) =>
              typeof block === 'object' &&
              block !== null &&
              'id' in block &&
              block.id === step.startBlockId,
          )
        )
          diagnostics.push({
            code: 'COMPILER_SCENE_DIALOGUE_BLOCK_MISSING',
            path: `/scenes/${scene.id}/data/steps/${index}/startBlockId`,
            message: `Dialogue block '${step.startBlockId}' does not exist in Dialogue '${step.dialogue.$ref.id}'.`,
          });
      }
    });
    scenes.push({
      ...scene,
      program: {
        instructions: data.steps
          .filter(
            (step): step is Exclude<SceneStepData, { type: 'comment' }> =>
              step.type !== 'comment' && step.enabled,
          )
          .map((step) => compileSceneStep(project, step)),
      },
      continuation: compileFlowTarget(data.continuation),
    });
  }

  const rooms: WireDefinitions['rooms'] = shared.definitions.rooms;

  if (diagnostics.length > 0) return { diagnostics };
  return {
    diagnostics,
    draft: { ...shared, definitions: { ...shared.definitions, rooms, scenes } },
  };
}
