import { z } from 'zod';
import { entityIdSchema } from './authoring-common';
import {
  assetRefSchema,
  characterRefSchema,
  conditionSchema,
  flowTargetSchema,
  gameplayCommandSchema,
  inlineTextContent,
  runtimeScalarSchema,
  sceneRefSchema,
  textContentSchema,
  type CharacterRef,
  type Condition,
  type FlowTarget,
  type GameplayCommand,
  type TextContent,
} from './authoring-flow';
import { parseCharacterData } from './authoring-characters';
import { parseSceneData } from './authoring-scenes';
import {
  audioCausalityValues,
  audioPausePolicyValues,
  audioSkipBehaviorValues,
} from './authoring-audio';
import type { AuthoringProject, AuthoringRecordBase } from './authoring-project';
import { validateVariableRuntimeValue } from './authoring-variable-usage';
import { validateCondition as validateSharedCondition } from './authoring-condition-validation';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const dialogueBlockTypeValues = ['sequence', 'choice', 'redirect', 'comment'] as const;
export type DialogueBlockType = (typeof dialogueBlockTypeValues)[number];

export const dialogueSegmentTypeValues = [
  'line',
  'run-lua',
  'call-scene',
  'handoff',
  'comment',
] as const;
export type DialogueSegmentType = (typeof dialogueSegmentTypeValues)[number];

export const dialogueEdgeKindValues = ['next', 'choice'] as const;
export type DialogueEdgeKind = (typeof dialogueEdgeKindValues)[number];

export const dialogueLogModeValues = [
  'everything',
  'nothing',
  'only-choices',
  'only-lines',
] as const;
export type DialogueLogMode = (typeof dialogueLogModeValues)[number];

export const dialoguePreviewBackgroundValues = ['dark', 'light', 'checker'] as const;
export type DialoguePreviewBackground = (typeof dialoguePreviewBackgroundValues)[number];

export const dialogueCharacterRefSchema = characterRefSchema;
export const dialogueTextDataSchema = textContentSchema;
export const dialogueConditionDataSchema = conditionSchema;
export const dialogueEffectDataSchema = gameplayCommandSchema;
export const dialogueCompletionTargetSchema = flowTargetSchema;

export const dialogueActorPositionValues = ['left', 'center', 'right'] as const;
export const dialogueChildSceneUiPolicyValues = ['preserve', 'conceal'] as const;

const dialogueStageSlotStateSchema = strict({
  character: dialogueCharacterRefSchema,
  profileId: entityIdSchema,
  poseId: entityIdSchema,
  expressionId: entityIdSchema,
  appearanceId: entityIdSchema.nullable(),
  position: z.enum(dialogueActorPositionValues),
  offset: strict({ x: z.number().finite(), y: z.number().finite() }),
  scale: z.number().finite().positive(),
  visible: z.boolean(),
});

const dialogueStageSlotSchema = strict({
  id: entityIdSchema,
  label: z.string().min(1),
  speakerSync: z.boolean(),
  initial: dialogueStageSlotStateSchema.nullable(),
});

const dialogueCharacterMediaSchema = strict({
  kind: z.literal('character'),
  character: dialogueCharacterRefSchema,
  profileId: entityIdSchema,
  poseId: entityIdSchema,
  expressionId: entityIdSchema,
  appearanceId: entityIdSchema.nullable(),
});
const dialogueImageMediaSchema = strict({
  kind: z.literal('image'),
  asset: assetRefSchema,
});
export const dialogueMediaContentSchema = z.discriminatedUnion('kind', [
  dialogueCharacterMediaSchema,
  dialogueImageMediaSchema,
]);

const dialogueMediaSlotSchema = strict({
  id: entityIdSchema,
  label: z.string().min(1),
  initial: dialogueMediaContentSchema.nullable(),
  visible: z.boolean(),
});

const dialogueStageMutationSchema = strict({
  slotId: entityIdSchema,
  action: z.enum(['update', 'show', 'hide', 'clear']),
  character: dialogueCharacterRefSchema.optional(),
  profileId: entityIdSchema.optional(),
  poseId: entityIdSchema.optional(),
  expressionId: entityIdSchema.optional(),
  appearanceId: entityIdSchema.nullable().optional(),
  position: z.enum(dialogueActorPositionValues).optional(),
  offset: strict({ x: z.number().finite(), y: z.number().finite() }).optional(),
  scale: z.number().finite().positive().optional(),
});

const dialogueMediaMutationSchema = strict({
  slotId: entityIdSchema,
  action: z.enum(['update', 'show', 'hide', 'clear']),
  content: dialogueMediaContentSchema.optional(),
});

const dialogueCuePositionSchema = strict({
  offset: z.number().int().nonnegative(),
  order: z.number().int().nonnegative(),
});

const dialogueActiveTextCueSchema = strict({
  id: entityIdSchema,
  kind: z.literal('active-text'),
  position: dialogueCuePositionSchema,
  token: z.string().min(1),
});
const dialogueInvalidMarkupCueSchema = strict({
  id: entityIdSchema,
  kind: z.literal('invalid-markup'),
  position: dialogueCuePositionSchema,
  token: z.string().min(1),
  message: z.string().min(1),
});
const dialogueSpeakerExpressionCueSchema = strict({
  id: entityIdSchema,
  kind: z.literal('speaker-expression'),
  position: dialogueCuePositionSchema,
  expressionId: entityIdSchema,
});
const dialogueStageCueSchema = strict({
  id: entityIdSchema,
  kind: z.literal('stage'),
  position: dialogueCuePositionSchema,
  mutation: dialogueStageMutationSchema,
});
const dialogueMediaCueSchema = strict({
  id: entityIdSchema,
  kind: z.literal('media'),
  position: dialogueCuePositionSchema,
  mutation: dialogueMediaMutationSchema,
});
const dialogueGestureCueSchema = strict({
  id: entityIdSchema,
  kind: z.literal('gesture'),
  position: dialogueCuePositionSchema,
  slotId: entityIdSchema,
  gestureId: entityIdSchema,
  waitForCompletion: z.boolean(),
  skippable: z.boolean(),
});
const dialogueVoiceCueSchema = strict({
  id: entityIdSchema,
  kind: z.literal('voice'),
  position: dialogueCuePositionSchema,
  asset: assetRefSchema,
  pausePolicy: z.enum(audioPausePolicyValues),
  gain: z.number().finite().min(0).max(1),
  pan: z.number().finite().min(-1).max(1),
  waitForCompletion: z.boolean(),
  skipBehavior: z.enum(audioSkipBehaviorValues),
});
const dialogueSoundEffectCueSchema = strict({
  id: entityIdSchema,
  kind: z.literal('sound-effect'),
  position: dialogueCuePositionSchema,
  asset: assetRefSchema,
  pausePolicy: z.enum(audioPausePolicyValues),
  gain: z.number().finite().min(0).max(1),
  pan: z.number().finite().min(-1).max(1),
  waitForCompletion: z.boolean(),
  causality: z.enum(audioCausalityValues),
  synchronized: z.boolean(),
  skipBehavior: z.enum(audioSkipBehaviorValues),
});
const dialogueCameraEmphasisSchema = z.discriminatedUnion('kind', [
  strict({
    kind: z.literal('shake'),
    amplitude: strict({ x: z.number().finite(), y: z.number().finite() }),
    frequencyHz: z.number().finite().positive(),
    durationMs: z.number().int().positive(),
    skippable: z.boolean(),
    waitForCompletion: z.boolean(),
  }),
  strict({
    kind: z.literal('punch'),
    translation: strict({ x: z.number().finite(), y: z.number().finite() }),
    zoomDelta: z.number().finite(),
    rotationDegrees: z.number().finite(),
    durationMs: z.number().int().positive(),
    skippable: z.boolean(),
    waitForCompletion: z.boolean(),
  }),
  strict({
    kind: z.literal('flash'),
    color: z.string().min(1),
    opacity: z.number().finite().min(0).max(1),
    durationMs: z.number().int().positive(),
    skippable: z.boolean(),
    waitForCompletion: z.boolean(),
  }),
]);
const dialogueCameraCueSchema = strict({
  id: entityIdSchema,
  kind: z.literal('camera'),
  position: dialogueCuePositionSchema,
  emphasis: dialogueCameraEmphasisSchema,
});

export const dialogueLineCueSchema = z.discriminatedUnion('kind', [
  dialogueActiveTextCueSchema,
  dialogueInvalidMarkupCueSchema,
  dialogueSpeakerExpressionCueSchema,
  dialogueStageCueSchema,
  dialogueMediaCueSchema,
  dialogueGestureCueSchema,
  dialogueVoiceCueSchema,
  dialogueSoundEffectCueSchema,
  dialogueCameraCueSchema,
]);

const lineSegmentSchema = strict({
  id: entityIdSchema,
  type: z.literal('line'),
  speaker: dialogueCharacterRefSchema.nullable(),
  text: dialogueTextDataSchema,
  cues: z.array(dialogueLineCueSchema),
  condition: dialogueConditionDataSchema.optional(),
  effects: z.array(dialogueEffectDataSchema),
  showOnce: z.boolean(),
  logged: z.boolean(),
  autosaveSafePoint: z.boolean(),
});

const runLuaSegmentSchema = strict({
  id: entityIdSchema,
  type: z.literal('run-lua'),
  condition: dialogueConditionDataSchema.optional(),
  source: z.string().min(1),
  mayYield: z.boolean(),
});

const dialogueSceneInputBindingSchema = strict({
  inputId: entityIdSchema,
  value: runtimeScalarSchema,
});

const callSceneSegmentSchema = strict({
  id: entityIdSchema,
  type: z.literal('call-scene'),
  condition: dialogueConditionDataSchema.optional(),
  scene: sceneRefSchema,
  inputs: z.array(dialogueSceneInputBindingSchema),
  uiPolicy: z.enum(dialogueChildSceneUiPolicyValues),
});

const handoffSegmentSchema = strict({
  id: entityIdSchema,
  type: z.literal('handoff'),
  condition: dialogueConditionDataSchema.optional(),
  payload: runtimeScalarSchema.optional(),
});

const commentSegmentSchema = strict({
  id: entityIdSchema,
  type: z.literal('comment'),
  text: z.string(),
});

export const dialogueSegmentDataSchema = z.discriminatedUnion('type', [
  lineSegmentSchema,
  runLuaSegmentSchema,
  callSceneSegmentSchema,
  handoffSegmentSchema,
  commentSegmentSchema,
]);

const sequenceBlockSchema = strict({
  id: entityIdSchema,
  type: z.literal('sequence'),
  label: z.string().min(1, 'Block label is required.'),
  defaultSpeaker: dialogueCharacterRefSchema.nullable(),
  segments: z.array(dialogueSegmentDataSchema),
});

const choiceBlockSchema = strict({
  id: entityIdSchema,
  type: z.literal('choice'),
  label: z.string().min(1, 'Block label is required.'),
});

const redirectBlockSchema = strict({
  id: entityIdSchema,
  type: z.literal('redirect'),
  label: z.string().min(1, 'Block label is required.'),
  targetBlockId: entityIdSchema,
});

const commentBlockSchema = strict({
  id: entityIdSchema,
  type: z.literal('comment'),
  label: z.string().min(1, 'Block label is required.'),
  text: z.string(),
});

export const dialogueBlockDataSchema = z.discriminatedUnion('type', [
  sequenceBlockSchema,
  choiceBlockSchema,
  redirectBlockSchema,
  commentBlockSchema,
]);

const nextEdgeSchema = strict({
  id: entityIdSchema,
  kind: z.literal('next'),
  fromBlockId: entityIdSchema,
  toBlockId: entityIdSchema,
});

const choiceEdgeSchema = strict({
  id: entityIdSchema,
  kind: z.literal('choice'),
  fromBlockId: entityIdSchema,
  toBlockId: entityIdSchema,
  label: dialogueTextDataSchema,
  condition: dialogueConditionDataSchema.optional(),
  effects: z.array(dialogueEffectDataSchema),
  logged: z.boolean(),
  autosaveSafePoint: z.boolean(),
});

export const dialogueEdgeDataSchema = z.discriminatedUnion('kind', [
  nextEdgeSchema,
  choiceEdgeSchema,
]);

export const dialogueSettingsDataSchema = strict({
  showDisabledChoices: z.boolean(),
  logMode: z.enum(dialogueLogModeValues),
});

export const dialogueDataSchema = strict({
  kind: z.literal('dialogue'),
  displayName: z.string(),
  defaultSpeaker: dialogueCharacterRefSchema.nullable(),
  stageSlots: z.array(dialogueStageSlotSchema),
  mediaSlots: z.array(dialogueMediaSlotSchema),
  settings: dialogueSettingsDataSchema,
  entryBlockId: entityIdSchema,
  blocks: z.array(dialogueBlockDataSchema).min(1),
  edges: z.array(dialogueEdgeDataSchema),
  completion: dialogueCompletionTargetSchema,
});

export type DialogueCharacterRef = CharacterRef;
export type DialogueTextData = TextContent;
export type DialogueConditionData = Condition;
export type DialogueCompletionTarget = FlowTarget;
export type DialogueSegmentData = z.infer<typeof dialogueSegmentDataSchema>;
export type DialogueBlockData = z.infer<typeof dialogueBlockDataSchema>;
export type DialogueSequenceBlockData = Extract<DialogueBlockData, { type: 'sequence' }>;
export type DialogueChoiceBlockData = Extract<DialogueBlockData, { type: 'choice' }>;
export type DialogueRedirectBlockData = Extract<DialogueBlockData, { type: 'redirect' }>;
export type DialogueEdgeData = z.infer<typeof dialogueEdgeDataSchema>;
export type DialogueNextEdgeData = Extract<DialogueEdgeData, { kind: 'next' }>;
export type DialogueChoiceEdgeData = Extract<DialogueEdgeData, { kind: 'choice' }>;
export type DialogueSettingsData = z.infer<typeof dialogueSettingsDataSchema>;
export type DialogueData = z.infer<typeof dialogueDataSchema>;
export type DialogueStageSlotState = z.infer<typeof dialogueStageSlotStateSchema>;
export type DialogueStageSlotData = z.infer<typeof dialogueStageSlotSchema>;
export type DialogueStageMutation = z.infer<typeof dialogueStageMutationSchema>;
export type DialogueMediaContent = z.infer<typeof dialogueMediaContentSchema>;
export type DialogueMediaSlotData = z.infer<typeof dialogueMediaSlotSchema>;
export type DialogueMediaMutation = z.infer<typeof dialogueMediaMutationSchema>;
export type DialogueLineCue = z.infer<typeof dialogueLineCueSchema>;

export interface DialogueSchemaDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
}

const diagnostic = (
  path: string,
  message: string,
  severity: DialogueSchemaDiagnostic['severity'] = 'error',
): DialogueSchemaDiagnostic => ({ severity, path, message, category: 'Dialogues' });

export function parseDialogueData(value: unknown): DialogueData | null {
  const parsed = dialogueDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function defaultDialogueSegment<T extends DialogueSegmentType = 'line'>(
  type: T = 'line' as T,
  id = type === 'line' ? 'line-1' : type,
): Extract<DialogueSegmentData, { type: T }> {
  const segment: DialogueSegmentData =
    type === 'line'
      ? {
          id,
          type,
          speaker: null,
          text: inlineTextContent(),
          cues: [],
          effects: [],
          showOnce: false,
          logged: true,
          autosaveSafePoint: false,
        }
      : type === 'run-lua'
        ? { id, type, source: '-- Lua', mayYield: true }
        : type === 'call-scene'
          ? {
              id,
              type,
              scene: { $ref: { collection: 'scenes', id: 'scene' } },
              inputs: [],
              uiPolicy: 'conceal',
            }
          : type === 'handoff'
            ? { id, type }
            : { id, type, text: '' };
  return segment as Extract<DialogueSegmentData, { type: T }>;
}

export function defaultDialogueBlock<T extends DialogueBlockType = 'sequence'>(
  type: T = 'sequence' as T,
  id = type === 'sequence' ? 'start' : type,
  label = type[0]!.toUpperCase() + type.slice(1),
): Extract<DialogueBlockData, { type: T }> {
  const block: DialogueBlockData =
    type === 'sequence'
      ? { id, type, label, defaultSpeaker: null, segments: [defaultDialogueSegment()] }
      : type === 'choice'
        ? { id, type, label }
        : type === 'redirect'
          ? { id, type, label, targetBlockId: 'start' }
          : { id, type, label, text: '' };
  return block as Extract<DialogueBlockData, { type: T }>;
}

export function defaultDialogueData(label = 'Dialogue'): DialogueData {
  return {
    kind: 'dialogue',
    displayName: label,
    defaultSpeaker: null,
    stageSlots: [],
    mediaSlots: [],
    settings: { showDisabledChoices: true, logMode: 'everything' },
    entryBlockId: 'start',
    blocks: [defaultDialogueBlock()],
    edges: [],
    completion: { kind: 'end' },
  };
}

export function isDialogueRecord(
  record: AuthoringRecordBase | undefined | null,
): record is AuthoringRecordBase & { data: DialogueData } {
  return !!record && parseDialogueData(record.data) !== null;
}

export const dialogueCharacterRef = (id: string): DialogueCharacterRef => ({
  $ref: { collection: 'characters', id },
});

function validateUniqueIds(
  items: readonly { id: string }[],
  path: string,
  label: string,
  diagnostics: DialogueSchemaDiagnostic[],
) {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id))
      diagnostics.push(diagnostic(`${path}/${index}/id`, `Duplicate ${label} ID '${item.id}'.`));
    seen.add(item.id);
  });
}

function inlineTextIsEmpty(text: DialogueTextData): boolean {
  return text.source.kind === 'inline' && !text.source.text.trim();
}

function graphTargets(data: DialogueData, blockId: string): string[] {
  const block = data.blocks.find((candidate) => candidate.id === blockId);
  if (block?.type === 'redirect') return [block.targetBlockId];
  return data.edges.filter((edge) => edge.fromBlockId === blockId).map((edge) => edge.toBlockId);
}

function reachableBlockIds(data: DialogueData): Set<string> {
  const reachable = new Set<string>();
  const stack = [data.entryBlockId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const target of graphTargets(data, id)) if (!reachable.has(target)) stack.push(target);
  }
  return reachable;
}

function redirectCycles(data: DialogueData): string[][] {
  const redirects = new Map(
    data.blocks
      .filter((block): block is DialogueRedirectBlockData => block.type === 'redirect')
      .map((block) => [block.id, block.targetBlockId]),
  );
  const cycles = new Map<string, string[]>();
  for (const start of redirects.keys()) {
    const order: string[] = [];
    const indexes = new Map<string, number>();
    let current: string | undefined = start;
    while (current && redirects.has(current)) {
      const previous = indexes.get(current);
      if (previous !== undefined) {
        const cycle = order.slice(previous);
        const key = [...cycle].sort().join('|');
        cycles.set(key, cycle);
        break;
      }
      indexes.set(current, order.length);
      order.push(current);
      current = redirects.get(current);
    }
  }
  return [...cycles.values()];
}

export function validateDialogueData(
  project: AuthoringProject,
  dialogueId: string,
  record: AuthoringRecordBase,
): DialogueSchemaDiagnostic[] {
  const base = `/dialogues/${dialogueId}/data`;
  const parsed = dialogueDataSchema.safeParse(record.data);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) =>
      diagnostic(`${base}/${issue.path.join('/')}`, issue.message),
    );
  }

  const data = parsed.data;
  const diagnostics: DialogueSchemaDiagnostic[] = [];
  const blockById = new Map(data.blocks.map((block) => [block.id, block]));

  const requireRecord = (collection: keyof AuthoringProject, id: string, path: string) => {
    const value = project[collection];
    if (typeof value !== 'object' || value === null || !(id in value)) {
      diagnostics.push(diagnostic(path, `Missing ${String(collection)} record '${id}'.`));
    }
  };
  const validateCharacter = (ref: DialogueCharacterRef | null, path: string) => {
    if (ref) requireRecord('characters', ref.$ref.id, path);
  };
  const validateCharacterPresentation = (
    ref: DialogueCharacterRef,
    profileId: string,
    poseId: string,
    expressionId: string,
    appearanceId: string | null,
    path: string,
  ) => {
    validateCharacter(ref, `${path}/character`);
    const character = parseCharacterData(project.characters[ref.$ref.id]?.data);
    if (!character) return;
    const profile = character.profiles.find((candidate) => candidate.id === profileId);
    if (!profile)
      diagnostics.push(
        diagnostic(`${path}/profileId`, `Missing Character profile '${profileId}'.`),
      );
    else if (!profile.poses.some((candidate) => candidate.id === poseId))
      diagnostics.push(
        diagnostic(`${path}/poseId`, `Missing Pose '${poseId}' in profile '${profileId}'.`),
      );
    if (!character.expressions.some((candidate) => candidate.id === expressionId))
      diagnostics.push(diagnostic(`${path}/expressionId`, `Missing Expression '${expressionId}'.`));
    if (appearanceId && !character.appearances.some((candidate) => candidate.id === appearanceId))
      diagnostics.push(diagnostic(`${path}/appearanceId`, `Missing Appearance '${appearanceId}'.`));
  };
  const validateMedia = (media: DialogueMediaContent, path: string) => {
    if (media.kind === 'image') {
      requireRecord('assets', media.asset.$ref.id, `${path}/asset`);
      const asset = project.assets[media.asset.$ref.id];
      if (
        asset &&
        asset.data &&
        typeof asset.data === 'object' &&
        'kind' in asset.data &&
        asset.data.kind !== 'image'
      )
        diagnostics.push(
          diagnostic(`${path}/asset`, 'Dialogue image media must reference an image asset.'),
        );
      return;
    }
    validateCharacterPresentation(
      media.character,
      media.profileId,
      media.poseId,
      media.expressionId,
      media.appearanceId,
      path,
    );
  };
  const validateVariableValue = (variableId: string, value: unknown, path: string) => {
    const result = validateVariableRuntimeValue(project, variableId, value);
    if (!result.ok) diagnostics.push(diagnostic(path, result.message));
  };
  const validateCondition = (condition: DialogueConditionData | undefined, path: string) => {
    if (condition) diagnostics.push(...validateSharedCondition(project, condition, path));
  };
  const validateEffects = (effects: readonly GameplayCommand[], path: string) => {
    effects.forEach((effect, index) => {
      if (effect.kind === 'set-global-property') {
        validateVariableValue(effect.variable.$ref.id, effect.value, `${path}/${index}/value`);
      }
      if (effect.kind === 'if') {
        validateCondition(effect.condition, `${path}/${index}/condition`);
        validateEffects(effect.then, `${path}/${index}/then`);
        validateEffects(effect.else, `${path}/${index}/else`);
      }
    });
  };
  const validateSceneCall = (
    segment: Extract<DialogueSegmentData, { type: 'call-scene' }>,
    path: string,
  ) => {
    const sceneId = segment.scene.$ref.id;
    requireRecord('scenes', sceneId, `${path}/scene`);
    const scene = parseSceneData(project.scenes[sceneId]?.data);
    if (!scene) return;
    const supplied = new Set<string>();
    segment.inputs.forEach((binding, inputIndex) => {
      const bindingPath = `${path}/inputs/${inputIndex}`;
      if (supplied.has(binding.inputId))
        diagnostics.push(
          diagnostic(`${bindingPath}/inputId`, `Duplicate Scene input '${binding.inputId}'.`),
        );
      supplied.add(binding.inputId);
      const declaration = scene.inputs.find((input) => input.id === binding.inputId);
      if (!declaration) {
        diagnostics.push(
          diagnostic(
            `${bindingPath}/inputId`,
            `Scene '${sceneId}' has no input '${binding.inputId}'.`,
          ),
        );
        return;
      }
      const value = binding.value;
      const valid =
        value === null
          ? declaration.nullable
          : declaration.type === 'boolean'
            ? typeof value === 'boolean'
            : declaration.type === 'string'
              ? typeof value === 'string'
              : declaration.type === 'integer'
                ? typeof value === 'number' && Number.isInteger(value)
                : typeof value === 'number' && Number.isFinite(value);
      if (!valid)
        diagnostics.push(
          diagnostic(
            `${bindingPath}/value`,
            `Scene input '${binding.inputId}' does not match type '${declaration.type}'.`,
          ),
        );
    });
    scene.inputs.forEach((input) => {
      if (!input.nullable && input.defaultValue === undefined && !supplied.has(input.id))
        diagnostics.push(
          diagnostic(`${path}/inputs`, `Missing required Scene input '${input.id}'.`),
        );
    });
  };

  validateCharacter(data.defaultSpeaker, `${base}/defaultSpeaker`);
  validateUniqueIds(data.stageSlots, `${base}/stageSlots`, 'stage slot', diagnostics);
  validateUniqueIds(data.mediaSlots, `${base}/mediaSlots`, 'media slot', diagnostics);
  data.stageSlots.forEach((slot, index) => {
    if (slot.initial)
      validateCharacterPresentation(
        slot.initial.character,
        slot.initial.profileId,
        slot.initial.poseId,
        slot.initial.expressionId,
        slot.initial.appearanceId,
        `${base}/stageSlots/${index}/initial`,
      );
  });
  data.mediaSlots.forEach((slot, index) => {
    if (slot.initial) validateMedia(slot.initial, `${base}/mediaSlots/${index}/initial`);
  });
  validateUniqueIds(data.blocks, `${base}/blocks`, 'block', diagnostics);
  validateUniqueIds(data.edges, `${base}/edges`, 'edge', diagnostics);
  const segmentIds = new Set<string>();
  const cueIds = new Set<string>();
  data.blocks.forEach((block, blockIndex) => {
    if (block.type !== 'sequence') return;
    block.segments.forEach((segment, segmentIndex) => {
      if (segmentIds.has(segment.id)) {
        diagnostics.push(
          diagnostic(
            `${base}/blocks/${blockIndex}/segments/${segmentIndex}/id`,
            `Duplicate segment ID '${segment.id}'.`,
          ),
        );
      }
      segmentIds.add(segment.id);
    });
  });

  const entryBlock = blockById.get(data.entryBlockId);
  if (!entryBlock)
    diagnostics.push(
      diagnostic(`${base}/entryBlockId`, `Missing entry block '${data.entryBlockId}'.`),
    );
  else if (entryBlock.type === 'comment')
    diagnostics.push(
      diagnostic(`${base}/entryBlockId`, 'A Comment block cannot be the Dialogue entry block.'),
    );

  data.blocks.forEach((block, blockIndex) => {
    const path = `${base}/blocks/${blockIndex}`;
    const outgoing = data.edges.filter((edge) => edge.fromBlockId === block.id);
    if (block.type === 'sequence') {
      validateCharacter(block.defaultSpeaker, `${path}/defaultSpeaker`);
      if (outgoing.length > 1 || outgoing.some((edge) => edge.kind !== 'next')) {
        diagnostics.push(
          diagnostic(
            path,
            `Sequence block '${block.id}' may have at most one Next edge and no Choice edges.`,
          ),
        );
      }
      block.segments.forEach((segment, segmentIndex) => {
        const segmentPath = `${path}/segments/${segmentIndex}`;
        if (segment.type === 'line') {
          validateCharacter(segment.speaker, `${segmentPath}/speaker`);
          validateCondition(segment.condition, `${segmentPath}/condition`);
          validateEffects(segment.effects, `${segmentPath}/effects`);
          const inlineLength =
            segment.text.source.kind === 'inline'
              ? Array.from(segment.text.source.text).length
              : null;
          const occupiedPositions = new Set<string>();
          segment.cues.forEach((cue, cueIndex) => {
            const cuePath = `${segmentPath}/cues/${cueIndex}`;
            if (cueIds.has(cue.id))
              diagnostics.push(
                diagnostic(`${cuePath}/id`, `Duplicate Dialogue cue ID '${cue.id}'.`),
              );
            cueIds.add(cue.id);
            if (inlineLength === null) {
              diagnostics.push(
                diagnostic(
                  cuePath,
                  'Positioned Dialogue cues currently require an inline text source.',
                ),
              );
            } else if (cue.position.offset > inlineLength) {
              diagnostics.push(
                diagnostic(
                  `${cuePath}/position/offset`,
                  `Cue offset ${cue.position.offset} is beyond the line text length ${inlineLength}.`,
                ),
              );
            }
            const positionKey = `${cue.position.offset}:${cue.position.order}`;
            if (occupiedPositions.has(positionKey))
              diagnostics.push(
                diagnostic(
                  `${cuePath}/position/order`,
                  `Cue position ${cue.position.offset}:${cue.position.order} is already occupied.`,
                ),
              );
            occupiedPositions.add(positionKey);

            if (cue.kind === 'active-text') {
              if (segment.text.markup !== 'active-text')
                diagnostics.push(
                  diagnostic(
                    cuePath,
                    'ActiveText presentation cues require ActiveText markup mode.',
                  ),
                );
              return;
            }
            if (cue.kind === 'invalid-markup') {
              diagnostics.push(diagnostic(cuePath, `Malformed Dialogue markup: ${cue.message}`));
              return;
            }
            if (cue.kind === 'speaker-expression') return;
            if (cue.kind === 'stage') {
              const mutation = cue.mutation;
              const slot = data.stageSlots.find((candidate) => candidate.id === mutation.slotId);
              if (!slot)
                diagnostics.push(
                  diagnostic(
                    `${cuePath}/mutation/slotId`,
                    `Missing Stage Slot '${mutation.slotId}'.`,
                  ),
                );
              if (mutation.character)
                validateCharacter(mutation.character, `${cuePath}/mutation/character`);
              if (
                mutation.action === 'clear' &&
                Object.keys(mutation).some((key) => !['slotId', 'action'].includes(key))
              )
                diagnostics.push(
                  diagnostic(
                    `${cuePath}/mutation`,
                    'Clear Stage Slot cues cannot include presentation fields.',
                  ),
                );
              return;
            }
            if (cue.kind === 'media') {
              const mutation = cue.mutation;
              if (!data.mediaSlots.some((candidate) => candidate.id === mutation.slotId))
                diagnostics.push(
                  diagnostic(
                    `${cuePath}/mutation/slotId`,
                    `Missing Media Slot '${mutation.slotId}'.`,
                  ),
                );
              if (mutation.content) validateMedia(mutation.content, `${cuePath}/mutation/content`);
              if (mutation.action === 'clear' && mutation.content)
                diagnostics.push(
                  diagnostic(
                    `${cuePath}/mutation`,
                    'Clear Media Slot cues cannot include content.',
                  ),
                );
              return;
            }

            if (cue.kind === 'gesture') {
              const slot = data.stageSlots.find((candidate) => candidate.id === cue.slotId);
              if (!slot)
                diagnostics.push(
                  diagnostic(`${cuePath}/slotId`, `Missing Stage Slot '${cue.slotId}'.`),
                );
              const character = slot?.initial
                ? parseCharacterData(project.characters[slot.initial.character.$ref.id]?.data)
                : null;
              if (character && !character.gestures.some((gesture) => gesture.id === cue.gestureId))
                diagnostics.push(
                  diagnostic(
                    `${cuePath}/gestureId`,
                    `Missing Gesture '${cue.gestureId}' on the Stage Slot's initial Character.`,
                  ),
                );
              return;
            }
            if (cue.kind === 'voice' || cue.kind === 'sound-effect') {
              const asset = project.assets[cue.asset.$ref.id];
              if (!asset)
                diagnostics.push(
                  diagnostic(`${cuePath}/asset`, `Missing Audio Asset '${cue.asset.$ref.id}'.`),
                );
              else if (asset.data.kind !== 'audio')
                diagnostics.push(
                  diagnostic(`${cuePath}/asset`, `Cue Asset '${cue.asset.$ref.id}' is not audio.`),
                );
              if (
                cue.kind === 'sound-effect' &&
                (cue.waitForCompletion || cue.synchronized) &&
                cue.causality !== 'causal'
              )
                diagnostics.push(
                  diagnostic(
                    `${cuePath}/causality`,
                    'Awaited or synchronized Sound Effect cues must be causal.',
                  ),
                );
              if (
                cue.kind === 'sound-effect' &&
                cue.skipBehavior === 'play' &&
                cue.causality !== 'causal'
              )
                diagnostics.push(
                  diagnostic(
                    `${cuePath}/causality`,
                    'Play-on-skip Sound Effect cues must be causal.',
                  ),
                );
              return;
            }
          });
          if (inlineTextIsEmpty(segment.text))
            diagnostics.push(
              diagnostic(
                `${segmentPath}/text`,
                `Line segment '${segment.id}' is empty.`,
                'warning',
              ),
            );
        } else if (segment.type === 'run-lua') {
          validateCondition(segment.condition, `${segmentPath}/condition`);
        } else if (segment.type === 'call-scene') {
          validateCondition(segment.condition, `${segmentPath}/condition`);
          validateSceneCall(segment, segmentPath);
        } else if (segment.type === 'handoff') {
          validateCondition(segment.condition, `${segmentPath}/condition`);
        }
      });
    } else if (block.type === 'choice') {
      if (outgoing.length === 0)
        diagnostics.push(
          diagnostic(path, `Choice block '${block.id}' requires at least one Choice edge.`),
        );
      if (outgoing.some((edge) => edge.kind !== 'choice'))
        diagnostics.push(
          diagnostic(path, `Choice block '${block.id}' may contain only Choice edges.`),
        );
    } else if (block.type === 'redirect') {
      if (outgoing.length > 0)
        diagnostics.push(
          diagnostic(path, `Redirect block '${block.id}' cannot have outgoing edges.`),
        );
      const target = blockById.get(block.targetBlockId);
      if (!target)
        diagnostics.push(
          diagnostic(`${path}/targetBlockId`, `Missing redirect target '${block.targetBlockId}'.`),
        );
      else if (target.type === 'comment')
        diagnostics.push(
          diagnostic(`${path}/targetBlockId`, 'A Redirect cannot target a Comment block.'),
        );
    } else if (outgoing.length > 0) {
      diagnostics.push(diagnostic(path, `Comment block '${block.id}' cannot have outgoing edges.`));
    }
  });

  data.edges.forEach((edge, edgeIndex) => {
    const path = `${base}/edges/${edgeIndex}`;
    const source = blockById.get(edge.fromBlockId);
    const target = blockById.get(edge.toBlockId);
    if (!source)
      diagnostics.push(
        diagnostic(`${path}/fromBlockId`, `Missing source block '${edge.fromBlockId}'.`),
      );
    if (!target)
      diagnostics.push(
        diagnostic(`${path}/toBlockId`, `Missing target block '${edge.toBlockId}'.`),
      );
    else if (target.type === 'comment')
      diagnostics.push(diagnostic(`${path}/toBlockId`, 'An edge cannot target a Comment block.'));
    if (source?.type === 'sequence' && edge.kind !== 'next')
      diagnostics.push(diagnostic(`${path}/kind`, 'A Sequence block may emit only a Next edge.'));
    if (source?.type === 'choice' && edge.kind !== 'choice')
      diagnostics.push(diagnostic(`${path}/kind`, 'A Choice block may emit only Choice edges.'));
    if (source && source.type !== 'sequence' && source.type !== 'choice')
      diagnostics.push(diagnostic(`${path}/fromBlockId`, `Block '${source.id}' cannot own edges.`));
    if (edge.kind === 'choice') {
      validateCondition(edge.condition, `${path}/condition`);
      validateEffects(edge.effects, `${path}/effects`);
      if (inlineTextIsEmpty(edge.label))
        diagnostics.push(diagnostic(`${path}/label`, `Choice edge '${edge.id}' requires a label.`));
    }
  });

  for (const cycle of redirectCycles(data)) {
    diagnostics.push(
      diagnostic(
        `${base}/blocks`,
        `Redirect-only cycle detected: ${cycle.join(' -> ')} -> ${cycle[0]}.`,
      ),
    );
  }

  if (entryBlock) {
    const reachable = reachableBlockIds(data);
    data.blocks.forEach((block, blockIndex) => {
      if (block.type !== 'comment' && !reachable.has(block.id)) {
        diagnostics.push(
          diagnostic(
            `${base}/blocks/${blockIndex}`,
            `Block '${block.id}' is not reachable from the entry block.`,
            'warning',
          ),
        );
      }
    });
  }

  const completion = data.completion;
  if (completion.kind === 'scene') requireRecord('scenes', completion.id, `${base}/completion/id`);
  if (completion.kind === 'dialogue')
    requireRecord('dialogues', completion.id, `${base}/completion/id`);
  if (completion.kind === 'room') requireRecord('rooms', completion.id, `${base}/completion/id`);
  if (
    completion.kind === 'return' &&
    project.entrypoint?.kind === 'dialogue' &&
    project.entrypoint.id === dialogueId
  ) {
    diagnostics.push(
      diagnostic(`${base}/completion`, 'A direct Dialogue entrypoint cannot complete with Return.'),
    );
  }

  return diagnostics;
}
