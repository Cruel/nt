import { z } from 'zod';
import { entityIdSchema } from './authoring-common';
import {
  audioCausalityValues,
  audioLifetimeValues,
  audioPanSourceSchema,
  audioPausePolicyValues,
  audioPurposeValues,
  audioSkipBehaviorValues,
} from './authoring-audio';
import {
  assetRefSchema,
  characterRefSchema,
  conditionSchema,
  dialogueRefSchema,
  effectSchema,
  inlineTextContent,
  layoutRefSchema,
  materialRefSchema,
  roomRefSchema,
  runtimeScalarSchema,
  sceneRefSchema,
  scriptRefSchema,
  textContentSchema,
  textSourceSchema,
  variableRefSchema,
} from './authoring-flow';
import type { AuthoringProject, AuthoringRecordBase } from './authoring-project';
import { validateVariableRuntimeValue } from './authoring-variable-usage';
import { resolveMaterialData } from './authoring-materials';
import {
  isUniformValueCompatible,
  parseShaderData,
  shaderUniformValueSchema,
} from './authoring-shaders';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const sceneStepTypeValues = [
  'set-background',
  'actor-cue',
  'call-scene',
  'start-detached-scene',
  'call-dialogue',
  'show-text',
  'audio-cue',
  'set-variable',
  'run-lua',
  'wait',
  'conditional-branch',
  'choice',
  'set-layout',
  'material-parameter',
  'postprocess-effect',
  'transition-group',
  'comment',
] as const;
export type SceneStepType = (typeof sceneStepTypeValues)[number];

export const sceneBackgroundFitValues = ['cover', 'contain', 'stretch', 'center'] as const;
export const sceneBackgroundTransitionValues = ['none', 'fade', 'cut'] as const;
export const sceneCharacterActionValues = [
  'show',
  'hide',
  'move',
  'profile',
  'pose',
  'expression',
  'appearance',
] as const;
export const sceneCharacterPositionValues = ['left', 'center', 'right', 'custom'] as const;
export const sceneCharacterTransitionValues = ['none', 'fade', 'slide'] as const;
export const sceneAudioPurposeValues = audioPurposeValues;
export const sceneAudioActionValues = ['play', 'stop', 'fade-in', 'fade-out'] as const;
export const sceneLayoutActionValues = ['show', 'hide', 'swap'] as const;
export const sceneLayoutSlotValues = ['hud', 'dialogue-box', 'overlay', 'custom'] as const;
export const sceneLayoutTransitionValues = ['none', 'fade'] as const;
export const sceneTransitionKindValues = ['fade', 'cut', 'dissolve'] as const;
export const sceneMaterialClockValues = ['gameplay', 'unscaled-presentation'] as const;
export const sceneMaterialEasingValues = ['linear', 'ease-in', 'ease-out', 'ease-in-out'] as const;
export const scenePostprocessScopeValues = ['world', 'full-game-viewport'] as const;
export const sceneTransitionGroupChildTypeValues = [
  'set-background',
  'clear-background',
  'actor-cue',
  'set-layout',
] as const;

export const sceneAssetRefSchema = assetRefSchema;
export const sceneMaterialRefSchema = materialRefSchema;
export const sceneCharacterRefSchema = characterRefSchema;
export const sceneDialogueRefSchema = dialogueRefSchema;
export const sceneLayoutRefSchema = layoutRefSchema;
export const sceneVariableRefSchema = variableRefSchema;
export const sceneRoomRefSchema = roomRefSchema;
export const sceneSceneRefSchema = sceneRefSchema;
export const sceneScriptRefSchema = scriptRefSchema;
export const sceneTextSourceSchema = textSourceSchema;
export const sceneTextContentSchema = textContentSchema;
export const sceneConditionSchema = conditionSchema;
export const sceneEffectSchema = effectSchema;

const commonRuntimeStep = {
  id: entityIdSchema,
  label: z.string().min(1),
  enabled: z.boolean().default(true),
  condition: sceneConditionSchema.optional(),
  timeline: strict({
    trackId: entityIdSchema,
    startMs: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
  }),
  completionDependencies: z.array(entityIdSchema).default([]),
};
const safePoint = { autosaveSafePoint: z.boolean().default(false) };

export const sceneInputTypeValues = ['boolean', 'integer', 'number', 'string'] as const;
export const sceneDetachedOwnerValues = ['flow', 'active-room', 'runtime-session'] as const;

export const sceneInputDefinitionSchema = strict({
  id: entityIdSchema,
  label: z.string().min(1),
  type: z.enum(sceneInputTypeValues),
  nullable: z.boolean(),
  defaultValue: runtimeScalarSchema.optional(),
});
export const sceneOutcomeDefinitionSchema = strict({
  id: entityIdSchema,
  label: z.string().min(1),
});
export const sceneInputBindingSchema = strict({
  inputId: entityIdSchema,
  value: runtimeScalarSchema,
});
export const sceneTerminalSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('return'), outcome: entityIdSchema.nullable() }),
  strict({
    kind: z.literal('continue-scene'),
    scene: sceneSceneRefSchema,
    inputs: z.array(sceneInputBindingSchema),
  }),
  strict({ kind: z.literal('continue-dialogue'), dialogue: sceneDialogueRefSchema }),
  strict({ kind: z.literal('release-to-exploration') }),
  strict({ kind: z.literal('complete-game') }),
]);

const setBackgroundStepSchema = strict({
  ...commonRuntimeStep,
  type: z.literal('set-background'),
  asset: sceneAssetRefSchema.nullable(),
  material: sceneMaterialRefSchema.nullable(),
  color: z.string().nullable(),
  fit: z.enum(sceneBackgroundFitValues),
  transition: z.enum(sceneBackgroundTransitionValues),
  durationMs: z.number().int().nonnegative(),
  waitForCompletion: z.boolean(),
  skippable: z.boolean(),
});
const actorCueStepSchema = strict({
  ...commonRuntimeStep,
  type: z.literal('actor-cue'),
  slotId: entityIdSchema,
  character: sceneCharacterRefSchema,
  action: z.enum(sceneCharacterActionValues),
  profileId: entityIdSchema.nullable().optional(),
  poseId: entityIdSchema.nullable(),
  expressionId: entityIdSchema.nullable(),
  appearanceId: entityIdSchema.nullable().optional(),
  position: z.enum(sceneCharacterPositionValues),
  offset: strict({ x: z.number().finite(), y: z.number().finite() }),
  scale: z.number().finite().positive(),
  transition: z.enum(sceneCharacterTransitionValues),
  durationMs: z.number().int().nonnegative(),
  waitForCompletion: z.boolean(),
  skippable: z.boolean(),
});
const callSceneStepSchema = strict({
  ...commonRuntimeStep,
  ...safePoint,
  type: z.literal('call-scene'),
  scene: sceneSceneRefSchema,
  inputs: z.array(sceneInputBindingSchema),
});
const startDetachedSceneStepSchema = strict({
  ...commonRuntimeStep,
  ...safePoint,
  type: z.literal('start-detached-scene'),
  scene: sceneSceneRefSchema,
  inputs: z.array(sceneInputBindingSchema),
  owner: z.enum(sceneDetachedOwnerValues),
});
const callDialogueStepSchema = strict({
  ...commonRuntimeStep,
  ...safePoint,
  type: z.literal('call-dialogue'),
  dialogue: sceneDialogueRefSchema,
  startBlockId: entityIdSchema.nullable(),
});
const showTextStepSchema = strict({
  ...commonRuntimeStep,
  ...safePoint,
  type: z.literal('show-text'),
  text: sceneTextContentSchema,
  speaker: sceneCharacterRefSchema.nullable(),
  wait: z.enum(['input', 'immediate']),
});
const audioCueStepSchema = strict({
  ...commonRuntimeStep,
  type: z.literal('audio-cue'),
  asset: sceneAssetRefSchema.nullable(),
  purpose: z.enum(audioPurposeValues),
  action: z.enum(sceneAudioActionValues),
  lifetime: z.enum(audioLifetimeValues),
  pausePolicy: z.enum(audioPausePolicyValues),
  gain: z.number().finite().min(0).max(1),
  pan: z.number().finite().min(-1).max(1),
  panSource: audioPanSourceSchema.nullable(),
  fadeMs: z.number().int().nonnegative(),
  waitForCompletion: z.boolean(),
  causality: z.enum(audioCausalityValues),
  synchronized: z.boolean(),
  skipBehavior: z.enum(audioSkipBehaviorValues),
  instanceId: entityIdSchema.nullable(),
  replacementGroup: entityIdSchema.nullable(),
});
const setVariableStepSchema = strict({
  ...commonRuntimeStep,
  type: z.literal('set-variable'),
  variable: sceneVariableRefSchema,
  value: runtimeScalarSchema,
});
const runLuaStepSchema = strict({
  ...commonRuntimeStep,
  ...safePoint,
  type: z.literal('run-lua'),
  source: z.string().min(1),
  mayYield: z.boolean(),
});
const waitStepSchema = z.discriminatedUnion('waitKind', [
  strict({
    ...commonRuntimeStep,
    type: z.literal('wait'),
    waitKind: z.literal('duration'),
    durationMs: z.number().int().nonnegative(),
    skippable: z.boolean(),
  }),
  strict({
    ...commonRuntimeStep,
    type: z.literal('wait'),
    waitKind: z.literal('input'),
    skippable: z.boolean(),
  }),
]);
const branchArmSchema = strict({
  id: entityIdSchema,
  condition: sceneConditionSchema,
  targetStepId: entityIdSchema,
});
const conditionalBranchStepSchema = strict({
  ...commonRuntimeStep,
  type: z.literal('conditional-branch'),
  branches: z.array(branchArmSchema),
  fallbackStepId: entityIdSchema,
});
const choiceOptionSchema = strict({
  id: entityIdSchema,
  label: sceneTextContentSchema,
  condition: sceneConditionSchema.optional(),
  effects: z.array(sceneEffectSchema),
  targetStepId: entityIdSchema,
});
const choiceStepSchema = strict({
  ...commonRuntimeStep,
  ...safePoint,
  type: z.literal('choice'),
  prompt: sceneTextContentSchema.nullable(),
  options: z.array(choiceOptionSchema).min(1),
});
const layoutScaleOverridesSchema = strict({
  ui: z.enum(['inherit', 'ignore']).optional(),
  text: z.enum(['inherit', 'ignore']).optional(),
});
const setLayoutStepSchema = strict({
  ...commonRuntimeStep,
  type: z.literal('set-layout'),
  layout: sceneLayoutRefSchema.nullable(),
  scaleOverrides: layoutScaleOverridesSchema.optional(),
  action: z.enum(sceneLayoutActionValues),
  slot: z.enum(sceneLayoutSlotValues),
  transition: z.enum(sceneLayoutTransitionValues),
  durationMs: z.number().int().nonnegative(),
  waitForCompletion: z.boolean(),
  skippable: z.boolean(),
});
const materialOccurrenceTargetSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('background') }),
  strict({
    kind: z.literal('actor'),
    slotId: entityIdSchema,
    layerId: entityIdSchema,
  }),
  strict({ kind: z.literal('layout'), slot: z.enum(sceneLayoutSlotValues) }),
  strict({ kind: z.literal('postprocess'), instanceId: entityIdSchema }),
]);
const materialParameterValueSchema = shaderUniformValueSchema.refine(
  (value) => value !== null,
  'Occurrence Material Parameters require a concrete value.',
);
const materialParameterStepSchema = strict({
  ...commonRuntimeStep,
  type: z.literal('material-parameter'),
  target: materialOccurrenceTargetSchema,
  material: sceneMaterialRefSchema,
  parameter: z.string().min(1),
  value: materialParameterValueSchema,
  transition: z.enum(['none', 'tween']),
  durationMs: z.number().int().nonnegative(),
  easing: z.enum(sceneMaterialEasingValues),
  clock: z.enum(sceneMaterialClockValues),
  waitForCompletion: z.boolean(),
  skippable: z.boolean(),
});
const postprocessParameterSchema = strict({
  name: z.string().min(1),
  value: materialParameterValueSchema,
});
const postprocessEffectStepSchema = strict({
  ...commonRuntimeStep,
  type: z.literal('postprocess-effect'),
  action: z.enum(['upsert', 'remove']),
  instanceId: entityIdSchema,
  material: sceneMaterialRefSchema.nullable(),
  scope: z.enum(scenePostprocessScopeValues),
  order: z.number().int(),
  clock: z.enum(sceneMaterialClockValues),
  parameters: z.array(postprocessParameterSchema),
});
const transitionGroupChildSchema = z.discriminatedUnion('type', [
  strict({
    id: entityIdSchema,
    type: z.literal('set-background'),
    asset: sceneAssetRefSchema.nullable(),
    material: sceneMaterialRefSchema.nullable(),
    color: z.string().nullable(),
    fit: z.enum(sceneBackgroundFitValues),
  }),
  strict({ id: entityIdSchema, type: z.literal('clear-background') }),
  strict({
    id: entityIdSchema,
    type: z.literal('actor-cue'),
    slotId: entityIdSchema,
    character: sceneCharacterRefSchema,
    action: z.enum(sceneCharacterActionValues),
    profileId: entityIdSchema.nullable().optional(),
    poseId: entityIdSchema.nullable(),
    expressionId: entityIdSchema.nullable(),
    appearanceId: entityIdSchema.nullable().optional(),
    position: z.enum(sceneCharacterPositionValues),
    offset: strict({ x: z.number().finite(), y: z.number().finite() }),
    scale: z.number().finite().positive(),
  }),
  strict({
    id: entityIdSchema,
    type: z.literal('set-layout'),
    layout: sceneLayoutRefSchema.nullable(),
    scaleOverrides: layoutScaleOverridesSchema.optional(),
    action: z.enum(sceneLayoutActionValues),
    slot: z.enum(sceneLayoutSlotValues),
  }),
]);
const transitionGroupStepSchema = strict({
  ...commonRuntimeStep,
  type: z.literal('transition-group'),
  transitionKind: z.enum(sceneTransitionKindValues),
  durationMs: z.number().int().nonnegative(),
  color: z.string().nullable(),
  waitForCompletion: z.boolean(),
  skippable: z.boolean(),
  children: z.array(transitionGroupChildSchema).min(1),
});
const commentStepSchema = strict({
  id: entityIdSchema,
  label: z.string().min(1),
  type: z.literal('comment'),
  text: z.string(),
  timeline: strict({
    trackId: entityIdSchema,
    startMs: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
  }),
});

export const sceneStepDataSchema = z.discriminatedUnion('type', [
  setBackgroundStepSchema,
  actorCueStepSchema,
  callSceneStepSchema,
  startDetachedSceneStepSchema,
  callDialogueStepSchema,
  showTextStepSchema,
  audioCueStepSchema,
  setVariableStepSchema,
  runLuaStepSchema,
  waitStepSchema,
  conditionalBranchStepSchema,
  choiceStepSchema,
  setLayoutStepSchema,
  materialParameterStepSchema,
  postprocessEffectStepSchema,
  transitionGroupStepSchema,
  commentStepSchema,
]);

export const sceneStageSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('inherited') }),
  strict({ kind: z.literal('staged-room'), room: sceneRoomRefSchema }),
  strict({
    kind: z.literal('blank'),
    background: strict({
      asset: sceneAssetRefSchema.nullable(),
      material: sceneMaterialRefSchema.nullable(),
      color: z.string().nullable(),
      fit: z.enum(sceneBackgroundFitValues),
    }),
    layout: sceneLayoutRefSchema.nullable(),
  }),
]);

export const sceneDataSchema = strict({
  kind: z.literal('scene'),
  displayName: z.string(),
  stage: sceneStageSchema,
  inputs: z.array(sceneInputDefinitionSchema),
  outcomes: z.array(sceneOutcomeDefinitionSchema),
  events: z.array(sceneStepDataSchema).min(1),
  terminal: sceneTerminalSchema,
});

export type SceneAssetRef = z.infer<typeof sceneAssetRefSchema>;
export type SceneCharacterRef = z.infer<typeof sceneCharacterRefSchema>;
export type SceneDialogueRef = z.infer<typeof sceneDialogueRefSchema>;
export type SceneLayoutRef = z.infer<typeof sceneLayoutRefSchema>;
export type SceneVariableRef = z.infer<typeof sceneVariableRefSchema>;
export type SceneInputDefinition = z.infer<typeof sceneInputDefinitionSchema>;
export type SceneOutcomeDefinition = z.infer<typeof sceneOutcomeDefinitionSchema>;
export type SceneInputBinding = z.infer<typeof sceneInputBindingSchema>;
export type SceneTerminal = z.infer<typeof sceneTerminalSchema>;
export type SceneConditionData = z.infer<typeof sceneConditionSchema>;
export type SceneEffectData = z.infer<typeof sceneEffectSchema>;
export type SceneTransitionGroupChildData = z.infer<typeof transitionGroupChildSchema>;
export type SceneStepData = z.infer<typeof sceneStepDataSchema>;
export type SceneStageData = z.infer<typeof sceneStageSchema>;
export type SceneData = z.infer<typeof sceneDataSchema>;

export interface SceneSchemaDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
}
const diagnostic = (
  path: string,
  message: string,
  severity: SceneSchemaDiagnostic['severity'] = 'error',
): SceneSchemaDiagnostic => ({ severity, path, message, category: 'Scenes' });

export function parseSceneData(value: unknown): SceneData | null {
  const parsed = sceneDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function buildDefaultSceneStep(type: SceneStepType, label?: string): SceneStepData {
  const id = type === 'comment' ? 'start' : type;
  const common = {
    id,
    type,
    label: label ?? type.replaceAll('-', ' '),
    enabled: true,
    timeline: { trackId: 'main', startMs: 0, durationMs: 0 },
    completionDependencies: [],
  };
  switch (type) {
    case 'set-background':
      return {
        ...common,
        type,
        asset: null,
        material: null,
        color: null,
        fit: 'cover',
        transition: 'none',
        durationMs: 0,
        waitForCompletion: false,
        skippable: true,
      };
    case 'actor-cue':
      return {
        ...common,
        type,
        slotId: 'actor',
        character: sceneCharacterRef('character'),
        action: 'show',
        profileId: null,
        poseId: null,
        expressionId: null,
        appearanceId: null,
        position: 'center',
        offset: { x: 0, y: 0 },
        scale: 1,
        transition: 'none',
        durationMs: 0,
        waitForCompletion: false,
        skippable: true,
      };
    case 'call-scene':
      return {
        ...common,
        type,
        scene: sceneSceneRef('scene'),
        inputs: [],
        autosaveSafePoint: false,
      };
    case 'start-detached-scene':
      return {
        ...common,
        type,
        scene: sceneSceneRef('scene'),
        inputs: [],
        owner: 'flow',
        autosaveSafePoint: false,
      };
    case 'call-dialogue':
      return {
        ...common,
        type,
        dialogue: sceneDialogueRef('dialogue'),
        startBlockId: null,
        autosaveSafePoint: false,
      };
    case 'show-text':
      return {
        ...common,
        type,
        text: inlineTextContent(),
        speaker: null,
        wait: 'input',
        autosaveSafePoint: true,
      };
    case 'audio-cue':
      return {
        ...common,
        type,
        asset: null,
        purpose: 'sound-effect',
        action: 'play',
        lifetime: 'one-shot',
        pausePolicy: 'gameplay',
        gain: 1,
        pan: 0,
        panSource: null,
        fadeMs: 0,
        waitForCompletion: false,
        causality: 'disposable',
        synchronized: false,
        skipBehavior: 'suppress',
        instanceId: null,
        replacementGroup: null,
      };
    case 'set-variable':
      return { ...common, type, variable: sceneVariableRef('variable'), value: false };
    case 'run-lua':
      return { ...common, type, source: '-- Lua', mayYield: true, autosaveSafePoint: false };
    case 'wait':
      return { ...common, type, waitKind: 'duration', durationMs: 1000, skippable: true };
    case 'conditional-branch':
      return { ...common, type, branches: [], fallbackStepId: 'start' };
    case 'choice':
      return {
        ...common,
        type,
        prompt: null,
        options: [
          { id: 'option', label: inlineTextContent('Option'), effects: [], targetStepId: 'start' },
        ],
        autosaveSafePoint: true,
      };
    case 'set-layout':
      return {
        ...common,
        type,
        layout: null,
        action: 'hide',
        slot: 'overlay',
        transition: 'none',
        durationMs: 0,
        waitForCompletion: false,
        skippable: true,
      };
    case 'material-parameter':
      return {
        ...common,
        type,
        target: { kind: 'background' },
        material: sceneMaterialRef('material'),
        parameter: 'u_effect',
        value: 0,
        transition: 'none',
        durationMs: 0,
        easing: 'linear',
        clock: 'gameplay',
        waitForCompletion: false,
        skippable: true,
      };
    case 'postprocess-effect':
      return {
        ...common,
        type,
        action: 'remove',
        instanceId: 'effect',
        material: null,
        scope: 'world',
        order: 0,
        clock: 'gameplay',
        parameters: [],
      };
    case 'transition-group':
      return {
        ...common,
        type,
        transitionKind: 'fade',
        durationMs: 1000,
        color: null,
        waitForCompletion: true,
        skippable: true,
        children: [
          {
            id: 'background',
            type: 'set-background',
            asset: null,
            material: null,
            color: '#0f172a',
            fit: 'cover',
          },
        ],
      };
    case 'comment':
      return {
        id,
        type,
        label: label ?? 'Start',
        text: '',
        timeline: { trackId: 'notes', startMs: 0, durationMs: 0 },
      };
  }
}

export function defaultSceneStep<T extends SceneStepType = 'comment'>(
  type: T = 'comment' as T,
  label?: string,
): Extract<SceneStepData, { type: T }> {
  return buildDefaultSceneStep(type, label) as Extract<SceneStepData, { type: T }>;
}

export function defaultSceneData(label = 'Scene'): SceneData {
  return {
    kind: 'scene',
    displayName: label,
    stage: {
      kind: 'blank',
      background: { asset: null, material: null, color: '#0f172a', fit: 'cover' },
      layout: null,
    },
    inputs: [],
    outcomes: [],
    events: [defaultSceneStep()],
    terminal: { kind: 'complete-game' },
  };
}

export function isSceneRecord(
  record: AuthoringRecordBase | undefined | null,
): record is AuthoringRecordBase & { data: SceneData } {
  return !!record && parseSceneData(record.data) !== null;
}
export const sceneAssetRef = (id: string) => ({ $ref: { collection: 'assets' as const, id } });
export const sceneMaterialRef = (id: string) => ({
  $ref: { collection: 'materials' as const, id },
});
export const sceneCharacterRef = (id: string) => ({
  $ref: { collection: 'characters' as const, id },
});
export const sceneDialogueRef = (id: string) => ({
  $ref: { collection: 'dialogues' as const, id },
});
export const sceneLayoutRef = (id: string) => ({ $ref: { collection: 'layouts' as const, id } });
export const sceneVariableRef = (id: string) => ({
  $ref: { collection: 'variables' as const, id },
});
export const sceneRoomRef = (id: string) => ({ $ref: { collection: 'rooms' as const, id } });
export const sceneSceneRef = (id: string) => ({ $ref: { collection: 'scenes' as const, id } });

export function validateSceneData(
  project: AuthoringProject,
  sceneId: string,
  record: AuthoringRecordBase,
): SceneSchemaDiagnostic[] {
  const base = `/scenes/${sceneId}/data`;
  const parsed = sceneDataSchema.safeParse(record.data);
  if (!parsed.success)
    return parsed.error.issues.map((issue) =>
      diagnostic(`${base}/${issue.path.join('/')}`, issue.message),
    );
  const data = parsed.data;
  const diagnostics: SceneSchemaDiagnostic[] = [];
  const ids = new Set<string>();
  const requireRecord = (collection: keyof AuthoringProject, id: string, path: string) => {
    const value = project[collection];
    if (typeof value !== 'object' || value === null || !(id in value))
      diagnostics.push(diagnostic(path, `Missing ${String(collection)} record '${id}'.`));
  };
  const validateVariableValue = (variableId: string, value: unknown, path: string) => {
    const result = validateVariableRuntimeValue(project, variableId, value);
    if (!result.ok) diagnostics.push(diagnostic(path, result.message));
  };
  const validateCondition = (condition: SceneConditionData | undefined, path: string) => {
    if (condition?.kind === 'variable-comparison') {
      const variableId = condition.variable.$ref.id;
      if (condition.value === undefined) requireRecord('variables', variableId, `${path}/variable`);
      else validateVariableValue(variableId, condition.value, `${path}/value`);
    }
  };
  const validateEffects = (effects: readonly SceneEffectData[], path: string) => {
    effects.forEach((effect, index) => {
      if (effect.kind === 'set-variable') {
        validateVariableValue(effect.variable.$ref.id, effect.value, `${path}/${index}/value`);
      }
    });
  };
  const sceneInputAccepts = (input: SceneInputDefinition, value: unknown) => {
    if (value === null) return input.nullable;
    switch (input.type) {
      case 'boolean':
        return typeof value === 'boolean';
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value);
      case 'number':
        return typeof value === 'number' && Number.isFinite(value);
      case 'string':
        return typeof value === 'string';
    }
  };
  const validateInputBindings = (
    targetId: string,
    bindings: readonly SceneInputBinding[],
    path: string,
  ) => {
    requireRecord('scenes', targetId, `${path}/scene`);
    const target = parseSceneData(project.scenes[targetId]?.data);
    if (!target) return;
    const supplied = new Set<string>();
    bindings.forEach((binding, index) => {
      if (supplied.has(binding.inputId))
        diagnostics.push(
          diagnostic(
            `${path}/inputs/${index}/inputId`,
            `Duplicate Scene input binding '${binding.inputId}'.`,
          ),
        );
      supplied.add(binding.inputId);
      const input = target.inputs.find((candidate) => candidate.id === binding.inputId);
      if (!input) {
        diagnostics.push(
          diagnostic(
            `${path}/inputs/${index}/inputId`,
            `Scene '${targetId}' does not declare input '${binding.inputId}'.`,
          ),
        );
      } else if (!sceneInputAccepts(input, binding.value)) {
        diagnostics.push(
          diagnostic(
            `${path}/inputs/${index}/value`,
            `Value does not match Scene input '${binding.inputId}' type '${input.type}'.`,
          ),
        );
      }
    });
    for (const input of target.inputs) {
      if (!input.nullable && input.defaultValue === undefined && !supplied.has(input.id))
        diagnostics.push(
          diagnostic(`${path}/inputs`, `Scene '${targetId}' requires input '${input.id}'.`),
        );
    }
  };
  const validateMaterialParameter = (
    materialId: string,
    parameter: string,
    value: unknown,
    path: string,
    acceptedRoles: readonly string[],
  ) => {
    const resolved = resolveMaterialData(project, materialId);
    if (!resolved.data) {
      diagnostics.push(diagnostic(`${path}/material`, `Material '${materialId}' is invalid.`));
      return;
    }
    if (!acceptedRoles.includes(resolved.data.role))
      diagnostics.push(
        diagnostic(
          `${path}/material`,
          `Material role '${resolved.data.role}' is not valid for this presentation occurrence.`,
        ),
      );
    const shaderId = resolved.data.shader?.$ref.id;
    const shader = shaderId ? parseShaderData(project.shaders[shaderId]?.data) : null;
    const uniform = shader?.uniforms.find((candidate) => candidate.name === parameter);
    if (!uniform) {
      diagnostics.push(
        diagnostic(`${path}/parameter`, `Shader does not declare uniform '${parameter}'.`),
      );
      return;
    }
    if (uniform.binding != null)
      diagnostics.push(
        diagnostic(
          `${path}/parameter`,
          `Uniform '${parameter}' is renderer-bound to '${uniform.binding}' and cannot be occurrence-controlled.`,
        ),
      );
    if (!isUniformValueCompatible(uniform.type, value))
      diagnostics.push(
        diagnostic(`${path}/value`, `Material Parameter value does not match ${uniform.type}.`),
      );
  };
  if (data.stage.kind === 'staged-room')
    requireRecord('rooms', data.stage.room.$ref.id, `${base}/stage/room`);
  if (data.stage.kind === 'blank') {
    if (data.stage.background.asset)
      requireRecord(
        'assets',
        data.stage.background.asset.$ref.id,
        `${base}/stage/background/asset`,
      );
    if (data.stage.background.material)
      requireRecord(
        'materials',
        data.stage.background.material.$ref.id,
        `${base}/stage/background/material`,
      );
    if (data.stage.layout)
      requireRecord('layouts', data.stage.layout.$ref.id, `${base}/stage/layout`);
  }
  const inputIds = new Set<string>();
  data.inputs.forEach((input, index) => {
    const path = `${base}/inputs/${index}`;
    if (inputIds.has(input.id))
      diagnostics.push(diagnostic(`${path}/id`, `Duplicate Scene input ID '${input.id}'.`));
    inputIds.add(input.id);
    if (input.defaultValue !== undefined && !sceneInputAccepts(input, input.defaultValue))
      diagnostics.push(
        diagnostic(
          `${path}/defaultValue`,
          `Default value does not match Scene input type '${input.type}'.`,
        ),
      );
  });
  const outcomeIds = new Set<string>();
  data.outcomes.forEach((outcome, index) => {
    if (outcomeIds.has(outcome.id))
      diagnostics.push(
        diagnostic(`${base}/outcomes/${index}/id`, `Duplicate Scene Outcome ID '${outcome.id}'.`),
      );
    outcomeIds.add(outcome.id);
  });
  const detachedSceneSafe = (targetSceneId: string, visiting = new Set<string>()): boolean => {
    const target = parseSceneData(project.scenes[targetSceneId]?.data);
    if (!target) return false;
    if (visiting.has(targetSceneId)) return true;
    visiting.add(targetSceneId);
    const unsafe = target.events.some((candidate) => {
      if (
        candidate.type === 'choice' ||
        candidate.type === 'call-dialogue' ||
        (candidate.type === 'show-text' && candidate.wait === 'input') ||
        (candidate.type === 'wait' && candidate.waitKind === 'input') ||
        (candidate.type === 'run-lua' && candidate.mayYield)
      )
        return true;
      if (
        (candidate.type === 'set-background' ||
          candidate.type === 'actor-cue' ||
          candidate.type === 'set-layout' ||
          candidate.type === 'material-parameter' ||
          candidate.type === 'transition-group' ||
          candidate.type === 'audio-cue') &&
        candidate.waitForCompletion
      )
        return true;
      if (candidate.type === 'call-scene' || candidate.type === 'start-detached-scene')
        return !detachedSceneSafe(candidate.scene.$ref.id, visiting);
      return false;
    });
    let terminalSafe = false;
    if (!unsafe) {
      if (target.terminal.kind === 'return') terminalSafe = true;
      else if (target.terminal.kind === 'continue-scene')
        terminalSafe = detachedSceneSafe(target.terminal.scene.$ref.id, visiting);
    }
    visiting.delete(targetSceneId);
    return !unsafe && terminalSafe;
  };
  data.events.forEach((step, index) => {
    const path = `${base}/events/${index}`;
    if (ids.has(step.id))
      diagnostics.push(diagnostic(`${path}/id`, `Duplicate Event ID '${step.id}'.`));
    ids.add(step.id);
    if (step.type !== 'comment') {
      const earlier = new Set(
        data.events
          .slice(0, index)
          .filter((candidate) => candidate.type !== 'comment' && candidate.enabled)
          .map((candidate) => candidate.id),
      );
      for (const [dependencyIndex, dependency] of step.completionDependencies.entries()) {
        if (!earlier.has(dependency))
          diagnostics.push(
            diagnostic(
              `${path}/completionDependencies/${dependencyIndex}`,
              `Completion dependency '${dependency}' must name an earlier Scene Event.`,
            ),
          );
      }
    }
    if ('condition' in step) validateCondition(step.condition, `${path}/condition`);
    if (step.type === 'set-background') {
      if (step.asset) requireRecord('assets', step.asset.$ref.id, `${path}/asset`);
      if (step.material) requireRecord('materials', step.material.$ref.id, `${path}/material`);
      if (step.transition === 'fade') {
        if (step.durationMs <= 0)
          diagnostics.push(
            diagnostic(
              `${path}/durationMs`,
              'Animated background transitions require a positive duration.',
            ),
          );
      } else {
        if (step.durationMs !== 0)
          diagnostics.push(
            diagnostic(
              `${path}/durationMs`,
              'Immediate background transitions require zero duration.',
            ),
          );
        if (step.waitForCompletion)
          diagnostics.push(
            diagnostic(
              `${path}/waitForCompletion`,
              'Immediate background transitions cannot wait for completion.',
            ),
          );
      }
    }
    if (step.type === 'actor-cue') {
      requireRecord('characters', step.character.$ref.id, `${path}/character`);
      if (step.transition === 'none') {
        if (step.durationMs !== 0)
          diagnostics.push(
            diagnostic(`${path}/durationMs`, 'Immediate actor changes require zero duration.'),
          );
        if (step.waitForCompletion)
          diagnostics.push(
            diagnostic(
              `${path}/waitForCompletion`,
              'Immediate actor changes cannot wait for completion.',
            ),
          );
      } else if (step.durationMs <= 0)
        diagnostics.push(
          diagnostic(
            `${path}/durationMs`,
            'Animated actor transitions require a positive duration.',
          ),
        );
      if (
        step.transition === 'slide' &&
        step.action !== 'show' &&
        step.action !== 'hide' &&
        step.action !== 'move'
      )
        diagnostics.push(
          diagnostic(
            `${path}/transition`,
            'Slide is valid only for show, hide, and move actor actions.',
          ),
        );
    }
    if (step.type === 'call-scene' || step.type === 'start-detached-scene')
      validateInputBindings(step.scene.$ref.id, step.inputs, path);
    if (step.type === 'start-detached-scene') {
      if (!detachedSceneSafe(step.scene.$ref.id))
        diagnostics.push(
          diagnostic(
            `${path}/scene`,
            `Detached Scene '${step.scene.$ref.id}' contains foreground-only or exclusive player-input work.`,
          ),
        );
      if (
        step.owner === 'active-room' &&
        project.entrypoint?.kind === 'scene' &&
        sceneId === project.entrypoint.id
      )
        diagnostics.push(
          diagnostic(
            `${path}/owner`,
            'Active Room detached ownership is unavailable before a Current Room exists.',
          ),
        );
    }
    if (step.type === 'call-dialogue')
      requireRecord('dialogues', step.dialogue.$ref.id, `${path}/dialogue`);
    if (step.type === 'show-text' && step.speaker)
      requireRecord('characters', step.speaker.$ref.id, `${path}/speaker`);
    if (step.type === 'audio-cue') {
      if (step.asset) requireRecord('assets', step.asset.$ref.id, `${path}/asset`);
      const playing = step.action === 'play' || step.action === 'fade-in';
      if (playing && !step.asset)
        diagnostics.push(diagnostic(`${path}/asset`, 'Audio playback requires an Audio Asset.'));
      if (!playing && step.asset)
        diagnostics.push(
          diagnostic(`${path}/asset`, 'Audio stop and fade-out actions cannot name an Asset.'),
        );
      if (step.lifetime === 'desired-loop') {
        if (!step.instanceId)
          diagnostics.push(
            diagnostic(
              `${path}/instanceId`,
              'Desired looping audio requires a stable instance ID.',
            ),
          );
        if (step.purpose !== 'music' && step.purpose !== 'ambience')
          diagnostics.push(
            diagnostic(
              `${path}/purpose`,
              'Desired looping audio is supported only for Music and Ambience.',
            ),
          );
        if (step.waitForCompletion)
          diagnostics.push(
            diagnostic(
              `${path}/waitForCompletion`,
              'Desired looping audio cannot wait for decoder completion.',
            ),
          );
        if (step.causality !== 'causal')
          diagnostics.push(
            diagnostic(
              `${path}/causality`,
              'Desired looping audio is reconstructible state, not disposable work.',
            ),
          );
        if (step.synchronized)
          diagnostics.push(
            diagnostic(
              `${path}/synchronized`,
              'Desired looping audio cannot be a synchronized one-shot cue.',
            ),
          );
        if (step.skipBehavior !== 'stop')
          diagnostics.push(
            diagnostic(
              `${path}/skipBehavior`,
              'Desired looping audio uses durable target state rather than one-shot skip behavior.',
            ),
          );
      } else {
        if (step.action === 'stop' || step.action === 'fade-out')
          diagnostics.push(
            diagnostic(
              `${path}/action`,
              'One-shot Scene audio starts a new playback; stop/fade-out require desired-loop targeting.',
            ),
          );
        if (step.replacementGroup !== null)
          diagnostics.push(
            diagnostic(
              `${path}/replacementGroup`,
              'One-shot audio cannot declare a replacement group.',
            ),
          );
        if ((step.waitForCompletion || step.synchronized) && step.causality !== 'causal')
          diagnostics.push(
            diagnostic(`${path}/causality`, 'Awaited or synchronized one-shots must be causal.'),
          );
        if (step.purpose === 'ui-sound') {
          if (step.causality !== 'disposable' || step.waitForCompletion || step.synchronized)
            diagnostics.push(
              diagnostic(
                `${path}/purpose`,
                'UI Sound is disposable and cannot await, synchronize with, or control gameplay.',
              ),
            );
          if (step.pausePolicy !== 'unscaled')
            diagnostics.push(
              diagnostic(
                `${path}/pausePolicy`,
                'UI Sound must continue on unscaled presentation time.',
              ),
            );
        }
      }
      if (step.panSource?.kind === 'room-anchor') {
        const panSource = step.panSource;
        requireRecord('rooms', panSource.room.$ref.id, `${path}/panSource/room`);
        const room = project.rooms[panSource.room.$ref.id];
        if (room && !room.data.anchors.some((anchor) => anchor.id === panSource.anchorId))
          diagnostics.push(
            diagnostic(
              `${path}/panSource/anchorId`,
              `Room Anchor '${panSource.anchorId}' does not exist.`,
            ),
          );
      } else if (step.panSource?.kind === 'scene-actor') {
        const panSource = step.panSource;
        const slotExists = data.events.some(
          (candidate) => candidate.type === 'actor-cue' && candidate.slotId === panSource.slotId,
        );
        if (!slotExists)
          diagnostics.push(
            diagnostic(
              `${path}/panSource/slotId`,
              `Scene Actor slot '${panSource.slotId}' does not exist.`,
            ),
          );
      }
    }
    if (step.type === 'set-variable')
      validateVariableValue(step.variable.$ref.id, step.value, `${path}/value`);
    if (step.type === 'set-layout') {
      if (step.layout) requireRecord('layouts', step.layout.$ref.id, `${path}/layout`);
      if (step.action === 'hide' && step.layout !== null)
        diagnostics.push(diagnostic(`${path}/layout`, 'Hide Layout actions cannot name a Layout.'));
      if (step.action !== 'hide' && step.layout === null)
        diagnostics.push(
          diagnostic(`${path}/layout`, 'Show and swap Layout actions require a Layout.'),
        );
      if (step.transition === 'fade') {
        if (step.durationMs <= 0)
          diagnostics.push(
            diagnostic(
              `${path}/durationMs`,
              'Animated Layout transitions require a positive duration.',
            ),
          );
      } else {
        if (step.durationMs !== 0)
          diagnostics.push(
            diagnostic(`${path}/durationMs`, 'Immediate Layout changes require zero duration.'),
          );
        if (step.waitForCompletion)
          diagnostics.push(
            diagnostic(
              `${path}/waitForCompletion`,
              'Immediate Layout changes cannot wait for completion.',
            ),
          );
      }
    }
    if (step.type === 'material-parameter') {
      requireRecord('materials', step.material.$ref.id, `${path}/material`);
      const acceptedRoles =
        step.target.kind === 'layout'
          ? ['rmlui-decorator']
          : step.target.kind === 'postprocess'
            ? ['postprocess']
            : ['engine-2d'];
      validateMaterialParameter(
        step.material.$ref.id,
        step.parameter,
        step.value,
        path,
        acceptedRoles,
      );
      if (step.target.kind === 'actor') {
        const target = step.target;
        const slotExists = data.events.some(
          (candidate) => candidate.type === 'actor-cue' && candidate.slotId === target.slotId,
        );
        if (!slotExists)
          diagnostics.push(
            diagnostic(
              `${path}/target/slotId`,
              `Scene Actor slot '${target.slotId}' does not exist.`,
            ),
          );
      } else if (step.target.kind === 'postprocess') {
        const target = step.target;
        const effectExists = data.events.some(
          (candidate) =>
            candidate.type === 'postprocess-effect' &&
            candidate.action === 'upsert' &&
            candidate.instanceId === target.instanceId,
        );
        if (!effectExists)
          diagnostics.push(
            diagnostic(
              `${path}/target/instanceId`,
              `Postprocess Effect '${target.instanceId}' is never authored in this Scene.`,
            ),
          );
      }
      if (step.transition === 'tween') {
        if (step.durationMs <= 0)
          diagnostics.push(
            diagnostic(
              `${path}/durationMs`,
              'Material Parameter transitions require a positive duration.',
            ),
          );
        if (typeof step.value === 'boolean' || Number.isInteger(step.value)) {
          const resolved = resolveMaterialData(project, step.material.$ref.id);
          const shaderId = resolved.data?.shader?.$ref.id;
          const uniform = shaderId
            ? parseShaderData(project.shaders[shaderId]?.data)?.uniforms.find(
                (candidate) => candidate.name === step.parameter,
              )
            : undefined;
          if (uniform?.type === 'bool' || uniform?.type === 'int')
            diagnostics.push(
              diagnostic(
                `${path}/transition`,
                'Boolean and integer Material Parameters cannot use finite interpolation.',
              ),
            );
        }
      } else {
        if (step.durationMs !== 0)
          diagnostics.push(
            diagnostic(
              `${path}/durationMs`,
              'Immediate Material Parameter assignments require zero duration.',
            ),
          );
        if (step.waitForCompletion)
          diagnostics.push(
            diagnostic(
              `${path}/waitForCompletion`,
              'Immediate Material Parameter assignments cannot wait for completion.',
            ),
          );
      }
    }
    if (step.type === 'postprocess-effect') {
      if (step.action === 'remove') {
        if (step.material !== null)
          diagnostics.push(
            diagnostic(`${path}/material`, 'Removing a Postprocess Effect cannot name a Material.'),
          );
        if (step.parameters.length !== 0)
          diagnostics.push(
            diagnostic(
              `${path}/parameters`,
              'Removing a Postprocess Effect cannot assign Material Parameters.',
            ),
          );
      } else if (!step.material) {
        diagnostics.push(
          diagnostic(`${path}/material`, 'Adding a Postprocess Effect requires a Material.'),
        );
      } else {
        requireRecord('materials', step.material.$ref.id, `${path}/material`);
        const resolved = resolveMaterialData(project, step.material.$ref.id);
        if (resolved.data) {
          if (resolved.data.role !== 'postprocess')
            diagnostics.push(
              diagnostic(`${path}/material`, 'Postprocess Effects require postprocess Materials.'),
            );
          if (resolved.data.postprocessScope !== step.scope)
            diagnostics.push(
              diagnostic(
                `${path}/scope`,
                `Effect scope must match Material scope '${resolved.data.postprocessScope}'.`,
              ),
            );
        }
        const names = new Set<string>();
        step.parameters.forEach((parameter, parameterIndex) => {
          const parameterPath = `${path}/parameters/${parameterIndex}`;
          if (names.has(parameter.name))
            diagnostics.push(
              diagnostic(`${parameterPath}/name`, `Duplicate parameter '${parameter.name}'.`),
            );
          names.add(parameter.name);
          validateMaterialParameter(
            step.material!.$ref.id,
            parameter.name,
            parameter.value,
            parameterPath,
            ['postprocess'],
          );
        });
      }
    }
    if (step.type === 'transition-group') {
      if (step.transitionKind === 'cut') {
        if (step.durationMs !== 0)
          diagnostics.push(
            diagnostic(`${path}/durationMs`, 'Cut transition groups require zero duration.'),
          );
        if (step.waitForCompletion)
          diagnostics.push(
            diagnostic(
              `${path}/waitForCompletion`,
              'Cut transition groups cannot wait for completion.',
            ),
          );
        if (step.color !== null)
          diagnostics.push(
            diagnostic(`${path}/color`, 'Cut transition groups do not accept a color.'),
          );
      } else {
        if (step.durationMs <= 0)
          diagnostics.push(
            diagnostic(
              `${path}/durationMs`,
              'Animated transition groups require a positive duration.',
            ),
          );
        if (step.transitionKind === 'dissolve' && step.color !== null)
          diagnostics.push(
            diagnostic(`${path}/color`, 'Dissolve transition groups do not accept a color.'),
          );
      }
      const childIds = new Set<string>();
      step.children.forEach((child, childIndex) => {
        const childPath = `${path}/children/${childIndex}`;
        if (childIds.has(child.id))
          diagnostics.push(
            diagnostic(`${childPath}/id`, `Duplicate transition-group child ID '${child.id}'.`),
          );
        childIds.add(child.id);
        if (child.type === 'set-background') {
          if (child.asset) requireRecord('assets', child.asset.$ref.id, `${childPath}/asset`);
          if (child.material)
            requireRecord('materials', child.material.$ref.id, `${childPath}/material`);
        }
        if (child.type === 'actor-cue')
          requireRecord('characters', child.character.$ref.id, `${childPath}/character`);
        if (child.type === 'set-layout') {
          if (child.action === 'hide' && child.layout !== null)
            diagnostics.push(
              diagnostic(
                `${childPath}/layout`,
                'Hide transition-group Layout mutations cannot name a Layout.',
              ),
            );
          if (child.action !== 'hide' && child.layout === null)
            diagnostics.push(
              diagnostic(
                `${childPath}/layout`,
                'Show and swap transition-group Layout mutations require a Layout.',
              ),
            );
          if (child.slot !== 'overlay' && child.slot !== 'custom')
            diagnostics.push(
              diagnostic(
                `${childPath}/slot`,
                'Transition-group Layout mutations may target only WorldOverlay slots.',
              ),
            );
          if (child.layout) {
            requireRecord('layouts', child.layout.$ref.id, `${childPath}/layout`);
            const layoutData = project.layouts[child.layout.$ref.id]?.data;
            const target =
              layoutData && typeof layoutData === 'object' && 'target' in layoutData
                ? layoutData.target
                : null;
            if (
              target !== 'scene-overlay' &&
              target !== 'room-overlay' &&
              target !== 'custom-overlay'
            )
              diagnostics.push(
                diagnostic(
                  `${childPath}/layout`,
                  'Transition-group Layout mutations require a Layout whose resolved authored target participates in WorldOverlay.',
                ),
              );
          }
        }
      });
    }
    if (step.type === 'conditional-branch') {
      const armIds = new Set<string>();
      for (const [armIndex, arm] of step.branches.entries()) {
        if (armIds.has(arm.id))
          diagnostics.push(
            diagnostic(`${path}/branches/${armIndex}/id`, `Duplicate branch ID '${arm.id}'.`),
          );
        armIds.add(arm.id);
        validateCondition(arm.condition, `${path}/branches/${armIndex}/condition`);
        if (!data.events.some((candidate) => candidate.id === arm.targetStepId))
          diagnostics.push(
            diagnostic(
              `${path}/branches/${armIndex}/targetStepId`,
              `Missing target step '${arm.targetStepId}'.`,
            ),
          );
      }
      if (!data.events.some((candidate) => candidate.id === step.fallbackStepId))
        diagnostics.push(
          diagnostic(`${path}/fallbackStepId`, `Missing fallback step '${step.fallbackStepId}'.`),
        );
    }
    if (step.type === 'choice') {
      const optionIds = new Set<string>();
      for (const [optionIndex, option] of step.options.entries()) {
        if (optionIds.has(option.id))
          diagnostics.push(
            diagnostic(`${path}/options/${optionIndex}/id`, `Duplicate option ID '${option.id}'.`),
          );
        optionIds.add(option.id);
        validateCondition(option.condition, `${path}/options/${optionIndex}/condition`);
        validateEffects(option.effects, `${path}/options/${optionIndex}/effects`);
        if (!data.events.some((candidate) => candidate.id === option.targetStepId))
          diagnostics.push(
            diagnostic(
              `${path}/options/${optionIndex}/targetStepId`,
              `Missing target step '${option.targetStepId}'.`,
            ),
          );
      }
    }
  });
  const terminal = data.terminal;
  if (terminal.kind === 'return') {
    if (terminal.outcome !== null && !outcomeIds.has(terminal.outcome))
      diagnostics.push(
        diagnostic(
          `${base}/terminal/outcome`,
          `Return Outcome '${terminal.outcome}' is not declared by this Scene.`,
        ),
      );
    if (project.entrypoint?.kind === 'scene' && project.entrypoint.id === sceneId)
      diagnostics.push(
        diagnostic(
          `${base}/terminal`,
          'A project-entrypoint Scene cannot Return without a caller.',
        ),
      );
  }
  if (project.entrypoint?.kind === 'scene' && project.entrypoint.id === sceneId) {
    for (let index = 0; index < data.inputs.length; index += 1) {
      const input = data.inputs[index]!;
      if (!input.nullable && input.defaultValue === undefined)
        diagnostics.push(
          diagnostic(
            `${base}/inputs/${index}`,
            `Project-entrypoint Scene input '${input.id}' requires a default value or nullable type.`,
          ),
        );
    }
  }
  if (terminal.kind === 'continue-scene')
    validateInputBindings(terminal.scene.$ref.id, terminal.inputs, `${base}/terminal`);
  if (terminal.kind === 'continue-dialogue')
    requireRecord('dialogues', terminal.dialogue.$ref.id, `${base}/terminal/dialogue`);
  if (
    terminal.kind === 'release-to-exploration' &&
    project.entrypoint?.kind === 'scene' &&
    project.entrypoint.id === sceneId
  )
    diagnostics.push(
      diagnostic(
        `${base}/terminal`,
        'A project-entrypoint Scene cannot release to Exploration before a Current Room exists.',
      ),
    );

  const unconditionalTargets = (candidateId: string): string[] => {
    const candidate = parseSceneData(project.scenes[candidateId]?.data);
    if (!candidate) return [];
    const hasDynamicControl = candidate.events.some(
      (step) => step.type === 'conditional-branch' || step.type === 'choice',
    );
    const called = hasDynamicControl
      ? []
      : candidate.events.flatMap((step) =>
          step.type === 'call-scene' && step.enabled && step.condition === undefined
            ? [step.scene.$ref.id]
            : [],
        );
    if (candidate.terminal.kind === 'continue-scene') called.push(candidate.terminal.scene.$ref.id);
    return called;
  };
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const findCycle = (candidateId: string): boolean => {
    if (visiting.has(candidateId)) return true;
    if (visited.has(candidateId)) return false;
    visiting.add(candidateId);
    for (const targetId of unconditionalTargets(candidateId)) if (findCycle(targetId)) return true;
    visiting.delete(candidateId);
    visited.add(candidateId);
    return false;
  };
  if (findCycle(sceneId))
    diagnostics.push(
      diagnostic(
        `${base}/terminal`,
        'Scene participates in a statically unconditional Scene call/continue cycle.',
      ),
    );
  return diagnostics;
}
