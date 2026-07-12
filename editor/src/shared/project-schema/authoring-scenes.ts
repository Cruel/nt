import { z } from 'zod';
import { entityIdSchema } from './authoring-common';
import {
  assetRefSchema,
  characterRefSchema,
  conditionSchema,
  dialogueRefSchema,
  effectSchema,
  flowTargetSchema,
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
import { isVariableDefaultValueCompatible, parseVariableData } from './authoring-variables';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const sceneStepTypeValues = [
  'set-background', 'actor-cue', 'call-dialogue', 'show-text', 'audio-cue',
  'set-variable', 'run-lua', 'wait', 'conditional-branch', 'choice',
  'set-layout', 'transition', 'comment',
] as const;
export type SceneStepType = (typeof sceneStepTypeValues)[number];

export const sceneBackgroundFitValues = ['cover', 'contain', 'stretch', 'center'] as const;
export const sceneBackgroundTransitionValues = ['none', 'fade', 'cut'] as const;
export const sceneCharacterActionValues = ['show', 'hide', 'move', 'pose', 'expression'] as const;
export const sceneCharacterPositionValues = ['left', 'center', 'right', 'custom'] as const;
export const sceneCharacterTransitionValues = ['none', 'fade', 'slide'] as const;
export const sceneAudioChannelValues = ['sound-effect', 'music', 'voice', 'ambient'] as const;
export const sceneAudioActionValues = ['play', 'stop', 'fade-in', 'fade-out'] as const;
export const sceneLayoutActionValues = ['show', 'hide', 'swap'] as const;
export const sceneLayoutSlotValues = ['hud', 'dialogue-box', 'overlay', 'custom'] as const;
export const sceneTransitionKindValues = ['fade', 'cut', 'dissolve'] as const;

export const sceneAssetRefSchema = assetRefSchema;
export const sceneMaterialRefSchema = materialRefSchema;
export const sceneCharacterRefSchema = characterRefSchema;
export const sceneDialogueRefSchema = dialogueRefSchema;
export const sceneLayoutRefSchema = layoutRefSchema;
export const sceneVariableRefSchema = variableRefSchema;
export const sceneRoomRefSchema = roomRefSchema;
export const sceneSceneRefSchema = sceneRefSchema;
export const sceneScriptRefSchema = scriptRefSchema;
export const sceneFlowTargetSchema = flowTargetSchema;
export const sceneTextSourceSchema = textSourceSchema;
export const sceneTextContentSchema = textContentSchema;
export const sceneConditionSchema = conditionSchema;
export const sceneEffectSchema = effectSchema;

const commonRuntimeStep = {
  id: entityIdSchema,
  label: z.string().min(1),
  enabled: z.boolean().default(true),
  condition: sceneConditionSchema.optional(),
};
const safePoint = { autosaveSafePoint: z.boolean().default(false) };

const setBackgroundStepSchema = strict({
  ...commonRuntimeStep,
  type: z.literal('set-background'),
  asset: sceneAssetRefSchema.nullable(), material: sceneMaterialRefSchema.nullable(), color: z.string().nullable(),
  fit: z.enum(sceneBackgroundFitValues), transition: z.enum(sceneBackgroundTransitionValues),
});
const actorCueStepSchema = strict({
  ...commonRuntimeStep,
  type: z.literal('actor-cue'), slotId: entityIdSchema, character: sceneCharacterRefSchema,
  action: z.enum(sceneCharacterActionValues), poseId: entityIdSchema.nullable(), expressionId: entityIdSchema.nullable(),
  position: z.enum(sceneCharacterPositionValues), offset: strict({ x: z.number().finite(), y: z.number().finite() }),
  scale: z.number().finite().positive(), transition: z.enum(sceneCharacterTransitionValues),
});
const callDialogueStepSchema = strict({
  ...commonRuntimeStep, ...safePoint, type: z.literal('call-dialogue'), dialogue: sceneDialogueRefSchema,
  startBlockId: entityIdSchema.nullable(),
});
const showTextStepSchema = strict({
  ...commonRuntimeStep, ...safePoint, type: z.literal('show-text'), text: sceneTextContentSchema,
  speaker: sceneCharacterRefSchema.nullable(), wait: z.enum(['input', 'immediate']),
});
const audioCueStepSchema = strict({
  ...commonRuntimeStep, type: z.literal('audio-cue'), asset: sceneAssetRefSchema.nullable(),
  channel: z.enum(sceneAudioChannelValues), action: z.enum(sceneAudioActionValues), loop: z.boolean(),
  volume: z.number().finite().min(0).max(1), fadeMs: z.number().finite().nonnegative(), waitForCompletion: z.boolean(),
});
const setVariableStepSchema = strict({
  ...commonRuntimeStep, type: z.literal('set-variable'), variable: sceneVariableRefSchema,
  value: runtimeScalarSchema,
});
const runLuaStepSchema = strict({
  ...commonRuntimeStep, ...safePoint, type: z.literal('run-lua'), source: z.string().min(1), mayYield: z.boolean(),
});
const waitStepSchema = z.discriminatedUnion('waitKind', [
  strict({ ...commonRuntimeStep, type: z.literal('wait'), waitKind: z.literal('duration'), durationMs: z.number().finite().nonnegative(), skippable: z.boolean() }),
  strict({ ...commonRuntimeStep, type: z.literal('wait'), waitKind: z.literal('input'), skippable: z.boolean() }),
]);
const branchArmSchema = strict({ id: entityIdSchema, condition: sceneConditionSchema, targetStepId: entityIdSchema });
const conditionalBranchStepSchema = strict({
  ...commonRuntimeStep, type: z.literal('conditional-branch'), branches: z.array(branchArmSchema), fallbackStepId: entityIdSchema,
});
const choiceOptionSchema = strict({
  id: entityIdSchema, label: sceneTextContentSchema, condition: sceneConditionSchema.optional(),
  effects: z.array(sceneEffectSchema), targetStepId: entityIdSchema,
});
const choiceStepSchema = strict({
  ...commonRuntimeStep, ...safePoint, type: z.literal('choice'), prompt: sceneTextContentSchema.nullable(), options: z.array(choiceOptionSchema).min(1),
});
const setLayoutStepSchema = strict({
  ...commonRuntimeStep, type: z.literal('set-layout'), layout: sceneLayoutRefSchema.nullable(),
  action: z.enum(sceneLayoutActionValues), slot: z.enum(sceneLayoutSlotValues),
});
const transitionStepSchema = strict({
  ...commonRuntimeStep, type: z.literal('transition'), transitionKind: z.enum(sceneTransitionKindValues),
  durationMs: z.number().finite().nonnegative(), color: z.string().nullable(), waitForCompletion: z.boolean(),
});
const commentStepSchema = strict({ id: entityIdSchema, label: z.string().min(1), type: z.literal('comment'), text: z.string() });

export const sceneStepDataSchema = z.discriminatedUnion('type', [
  setBackgroundStepSchema, actorCueStepSchema, callDialogueStepSchema, showTextStepSchema,
  audioCueStepSchema, setVariableStepSchema, runLuaStepSchema, waitStepSchema,
  conditionalBranchStepSchema, choiceStepSchema, setLayoutStepSchema, transitionStepSchema, commentStepSchema,
]);

export const sceneDataSchema = strict({
  kind: z.literal('scene'),
  displayName: z.string(),
  defaultBackground: strict({ asset: sceneAssetRefSchema.nullable(), material: sceneMaterialRefSchema.nullable(), color: z.string().nullable(), fit: z.enum(sceneBackgroundFitValues) }),
  defaultLayout: sceneLayoutRefSchema.nullable(),
  steps: z.array(sceneStepDataSchema).min(1),
  continuation: sceneFlowTargetSchema,
});

export type SceneAssetRef = z.infer<typeof sceneAssetRefSchema>;
export type SceneCharacterRef = z.infer<typeof sceneCharacterRefSchema>;
export type SceneDialogueRef = z.infer<typeof sceneDialogueRefSchema>;
export type SceneLayoutRef = z.infer<typeof sceneLayoutRefSchema>;
export type SceneVariableRef = z.infer<typeof sceneVariableRefSchema>;
export type SceneFlowTarget = z.infer<typeof sceneFlowTargetSchema>;
export type SceneConditionData = z.infer<typeof sceneConditionSchema>;
export type SceneEffectData = z.infer<typeof sceneEffectSchema>;
export type SceneStepData = z.infer<typeof sceneStepDataSchema>;
export type SceneData = z.infer<typeof sceneDataSchema>;

export interface SceneSchemaDiagnostic { severity: 'error' | 'warning' | 'info'; path: string; message: string; category?: string }
const diagnostic = (path: string, message: string, severity: SceneSchemaDiagnostic['severity'] = 'error'): SceneSchemaDiagnostic => ({ severity, path, message, category: 'authoring-scenes' });

export function parseSceneData(value: unknown): SceneData | null {
  const parsed = sceneDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function buildDefaultSceneStep(type: SceneStepType, label?: string): SceneStepData {
  const id = type === 'comment' ? 'start' : type;
  const common = { id, type, label: label ?? type.replaceAll('-', ' '), enabled: true } as const;
  switch (type) {
    case 'set-background': return { ...common, type, asset: null, material: null, color: null, fit: 'cover', transition: 'fade' };
    case 'actor-cue': return { ...common, type, slotId: 'actor', character: sceneCharacterRef('character'), action: 'show', poseId: null, expressionId: null, position: 'center', offset: { x: 0, y: 0 }, scale: 1, transition: 'fade' };
    case 'call-dialogue': return { ...common, type, dialogue: sceneDialogueRef('dialogue'), startBlockId: null, autosaveSafePoint: false };
    case 'show-text': return { ...common, type, text: inlineTextContent(), speaker: null, wait: 'input', autosaveSafePoint: true };
    case 'audio-cue': return { ...common, type, asset: null, channel: 'sound-effect', action: 'play', loop: false, volume: 1, fadeMs: 0, waitForCompletion: false };
    case 'set-variable': return { ...common, type, variable: sceneVariableRef('variable'), value: false };
    case 'run-lua': return { ...common, type, source: '-- Lua', mayYield: true, autosaveSafePoint: false };
    case 'wait': return { ...common, type, waitKind: 'duration', durationMs: 1000, skippable: true };
    case 'conditional-branch': return { ...common, type, branches: [], fallbackStepId: 'start' };
    case 'choice': return { ...common, type, prompt: null, options: [{ id: 'option', label: inlineTextContent('Option'), effects: [], targetStepId: 'start' }], autosaveSafePoint: true };
    case 'set-layout': return { ...common, type, layout: null, action: 'show', slot: 'overlay' };
    case 'transition': return { ...common, type, transitionKind: 'fade', durationMs: 1000, color: null, waitForCompletion: true };
    case 'comment': return { id, type, label: label ?? 'Start', text: '' };
  }
}

export function defaultSceneStep<T extends SceneStepType = 'comment'>(type: T = 'comment' as T, label?: string): Extract<SceneStepData, { type: T }> {
  return buildDefaultSceneStep(type, label) as Extract<SceneStepData, { type: T }>;
}

export function defaultSceneData(label = 'Scene'): SceneData {
  return { kind: 'scene', displayName: label, defaultBackground: { asset: null, material: null, color: '#0f172a', fit: 'cover' }, defaultLayout: null, steps: [defaultSceneStep()], continuation: { kind: 'end' } };
}

export function isSceneRecord(record: AuthoringRecordBase | undefined | null): record is AuthoringRecordBase & { data: SceneData } { return !!record && parseSceneData(record.data) !== null; }
export const sceneAssetRef = (id: string) => ({ $ref: { collection: 'assets' as const, id } });
export const sceneMaterialRef = (id: string) => ({ $ref: { collection: 'materials' as const, id } });
export const sceneCharacterRef = (id: string) => ({ $ref: { collection: 'characters' as const, id } });
export const sceneDialogueRef = (id: string) => ({ $ref: { collection: 'dialogues' as const, id } });
export const sceneLayoutRef = (id: string) => ({ $ref: { collection: 'layouts' as const, id } });
export const sceneVariableRef = (id: string) => ({ $ref: { collection: 'variables' as const, id } });
export const sceneRoomRef = (id: string) => ({ $ref: { collection: 'rooms' as const, id } });

export function validateSceneData(project: AuthoringProject, sceneId: string, record: AuthoringRecordBase): SceneSchemaDiagnostic[] {
  const base = `/scenes/${sceneId}/data`;
  const parsed = sceneDataSchema.safeParse(record.data);
  if (!parsed.success) return parsed.error.issues.map((issue) => diagnostic(`${base}/${issue.path.join('/')}`, issue.message));
  const data = parsed.data;
  const diagnostics: SceneSchemaDiagnostic[] = [];
  const ids = new Set<string>();
  const requireRecord = (collection: keyof AuthoringProject, id: string, path: string) => {
    const value = project[collection];
    if (typeof value !== 'object' || value === null || !(id in value)) diagnostics.push(diagnostic(path, `Missing ${String(collection)} record '${id}'.`));
  };
  const validateVariableValue = (variableId: string, value: unknown, path: string) => {
    const record = project.variables[variableId];
    if (!record) {
      requireRecord('variables', variableId, path);
      return;
    }
    const variable = parseVariableData(record.data);
    if (!variable || !isVariableDefaultValueCompatible(variable.type, value, variable.enumValues)) {
      diagnostics.push(diagnostic(path, `Value does not match variable '${variableId}'.`));
    }
  };
  const validateCondition = (condition: SceneConditionData | undefined, path: string) => {
    if (condition?.kind === 'variable-comparison') {
      requireRecord('variables', condition.variable.$ref.id, `${path}/variable`);
    }
  };
  const validateEffects = (effects: readonly SceneEffectData[], path: string) => {
    effects.forEach((effect, index) => {
      if (effect.kind === 'set-variable') {
        validateVariableValue(effect.variable.$ref.id, effect.value, `${path}/${index}/value`);
      }
    });
  };
  if (data.defaultBackground.asset) requireRecord('assets', data.defaultBackground.asset.$ref.id, `${base}/defaultBackground/asset`);
  if (data.defaultBackground.material) requireRecord('materials', data.defaultBackground.material.$ref.id, `${base}/defaultBackground/material`);
  if (data.defaultLayout) requireRecord('layouts', data.defaultLayout.$ref.id, `${base}/defaultLayout`);
  data.steps.forEach((step, index) => {
    const path = `${base}/steps/${index}`;
    if (ids.has(step.id)) diagnostics.push(diagnostic(`${path}/id`, `Duplicate step ID '${step.id}'.`));
    ids.add(step.id);
    if ('condition' in step) validateCondition(step.condition, `${path}/condition`);
    if (step.type === 'set-background') {
      if (step.asset) requireRecord('assets', step.asset.$ref.id, `${path}/asset`);
      if (step.material) requireRecord('materials', step.material.$ref.id, `${path}/material`);
    }
    if (step.type === 'actor-cue') requireRecord('characters', step.character.$ref.id, `${path}/character`);
    if (step.type === 'call-dialogue') requireRecord('dialogues', step.dialogue.$ref.id, `${path}/dialogue`);
    if (step.type === 'show-text' && step.speaker) requireRecord('characters', step.speaker.$ref.id, `${path}/speaker`);
    if (step.type === 'audio-cue' && step.asset) requireRecord('assets', step.asset.$ref.id, `${path}/asset`);
    if (step.type === 'set-variable') validateVariableValue(step.variable.$ref.id, step.value, `${path}/value`);
    if (step.type === 'set-layout' && step.layout) requireRecord('layouts', step.layout.$ref.id, `${path}/layout`);
    if (step.type === 'conditional-branch') {
      const armIds = new Set<string>();
      for (const [armIndex, arm] of step.branches.entries()) {
        if (armIds.has(arm.id)) diagnostics.push(diagnostic(`${path}/branches/${armIndex}/id`, `Duplicate branch ID '${arm.id}'.`));
        armIds.add(arm.id);
        validateCondition(arm.condition, `${path}/branches/${armIndex}/condition`);
        if (!data.steps.some((candidate) => candidate.id === arm.targetStepId)) diagnostics.push(diagnostic(`${path}/branches/${armIndex}/targetStepId`, `Missing target step '${arm.targetStepId}'.`));
      }
      if (!data.steps.some((candidate) => candidate.id === step.fallbackStepId)) diagnostics.push(diagnostic(`${path}/fallbackStepId`, `Missing fallback step '${step.fallbackStepId}'.`));
    }
    if (step.type === 'choice') {
      const optionIds = new Set<string>();
      for (const [optionIndex, option] of step.options.entries()) {
        if (optionIds.has(option.id)) diagnostics.push(diagnostic(`${path}/options/${optionIndex}/id`, `Duplicate option ID '${option.id}'.`));
        optionIds.add(option.id);
        validateCondition(option.condition, `${path}/options/${optionIndex}/condition`);
        validateEffects(option.effects, `${path}/options/${optionIndex}/effects`);
        if (!data.steps.some((candidate) => candidate.id === option.targetStepId)) diagnostics.push(diagnostic(`${path}/options/${optionIndex}/targetStepId`, `Missing target step '${option.targetStepId}'.`));
      }
    }
  });
  const target = data.continuation;
  if (target.kind === 'scene') requireRecord('scenes', target.id, `${base}/continuation/id`);
  if (target.kind === 'dialogue') requireRecord('dialogues', target.id, `${base}/continuation/id`);
  if (target.kind === 'room') requireRecord('rooms', target.id, `${base}/continuation/id`);
  return diagnostics;
}
