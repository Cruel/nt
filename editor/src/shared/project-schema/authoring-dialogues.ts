import { z } from 'zod';
import { entityIdSchema } from './authoring-common';
import {
  characterRefSchema,
  conditionSchema,
  effectSchema,
  flowTargetSchema,
  inlineTextContent,
  textContentSchema,
  type CharacterRef,
  type Condition,
  type Effect,
  type FlowTarget,
  type TextContent,
} from './authoring-flow';
import type { AuthoringProject, AuthoringRecordBase } from './authoring-project';
import { validateVariableRuntimeValue } from './authoring-variable-usage';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const dialogueBlockTypeValues = ['sequence', 'choice', 'redirect', 'comment'] as const;
export type DialogueBlockType = (typeof dialogueBlockTypeValues)[number];

export const dialogueSegmentTypeValues = ['line', 'run-lua', 'comment'] as const;
export type DialogueSegmentType = (typeof dialogueSegmentTypeValues)[number];

export const dialogueEdgeKindValues = ['next', 'choice'] as const;
export type DialogueEdgeKind = (typeof dialogueEdgeKindValues)[number];

export const dialogueLogModeValues = ['everything', 'nothing', 'only-choices', 'only-lines'] as const;
export type DialogueLogMode = (typeof dialogueLogModeValues)[number];

export const dialoguePreviewBackgroundValues = ['dark', 'light', 'checker'] as const;
export type DialoguePreviewBackground = (typeof dialoguePreviewBackgroundValues)[number];

export const dialogueCharacterRefSchema = characterRefSchema;
export const dialogueTextDataSchema = textContentSchema;
export const dialogueConditionDataSchema = conditionSchema;
export const dialogueEffectDataSchema = effectSchema;
export const dialogueCompletionTargetSchema = flowTargetSchema;

const lineSegmentSchema = strict({
  id: entityIdSchema,
  type: z.literal('line'),
  speaker: dialogueCharacterRefSchema.nullable(),
  text: dialogueTextDataSchema,
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

const commentSegmentSchema = strict({
  id: entityIdSchema,
  type: z.literal('comment'),
  text: z.string(),
});

export const dialogueSegmentDataSchema = z.discriminatedUnion('type', [
  lineSegmentSchema,
  runLuaSegmentSchema,
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
  settings: dialogueSettingsDataSchema,
  entryBlockId: entityIdSchema,
  blocks: z.array(dialogueBlockDataSchema).min(1),
  edges: z.array(dialogueEdgeDataSchema),
  completion: dialogueCompletionTargetSchema,
});

export type DialogueCharacterRef = CharacterRef;
export type DialogueTextData = TextContent;
export type DialogueConditionData = Condition;
export type DialogueEffectData = Effect;
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
): DialogueSchemaDiagnostic => ({ severity, path, message, category: 'authoring-dialogues' });

export function parseDialogueData(value: unknown): DialogueData | null {
  const parsed = dialogueDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function defaultDialogueSegment<T extends DialogueSegmentType = 'line'>(
  type: T = 'line' as T,
  id = type === 'line' ? 'line-1' : type,
): Extract<DialogueSegmentData, { type: T }> {
  const segment: DialogueSegmentData = type === 'line'
    ? {
      id,
      type,
      speaker: null,
      text: inlineTextContent(),
      effects: [],
      showOnce: false,
      logged: true,
      autosaveSafePoint: false,
    }
    : type === 'run-lua'
      ? { id, type, source: '-- Lua', mayYield: true }
      : { id, type, text: '' };
  return segment as Extract<DialogueSegmentData, { type: T }>;
}

export function defaultDialogueBlock<T extends DialogueBlockType = 'sequence'>(
  type: T = 'sequence' as T,
  id = type === 'sequence' ? 'start' : type,
  label = type[0]!.toUpperCase() + type.slice(1),
): Extract<DialogueBlockData, { type: T }> {
  const block: DialogueBlockData = type === 'sequence'
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
    if (seen.has(item.id)) diagnostics.push(diagnostic(`${path}/${index}/id`, `Duplicate ${label} ID '${item.id}'.`));
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
    data.blocks.filter((block): block is DialogueRedirectBlockData => block.type === 'redirect')
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
    return parsed.error.issues.map((issue) => diagnostic(`${base}/${issue.path.join('/')}`, issue.message));
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
  const validateVariableValue = (variableId: string, value: unknown, path: string) => {
    const result = validateVariableRuntimeValue(project, variableId, value);
    if (!result.ok) diagnostics.push(diagnostic(path, result.message));
  };
  const validateCondition = (condition: DialogueConditionData | undefined, path: string) => {
    if (condition?.kind === 'variable-comparison') {
      const variableId = condition.variable.$ref.id;
      if (condition.value === undefined) requireRecord('variables', variableId, `${path}/variable`);
      else validateVariableValue(variableId, condition.value, `${path}/value`);
    }
  };
  const validateEffects = (effects: readonly DialogueEffectData[], path: string) => {
    effects.forEach((effect, index) => {
      if (effect.kind === 'set-variable') {
        validateVariableValue(effect.variable.$ref.id, effect.value, `${path}/${index}/value`);
      }
    });
  };

  validateCharacter(data.defaultSpeaker, `${base}/defaultSpeaker`);
  validateUniqueIds(data.blocks, `${base}/blocks`, 'block', diagnostics);
  validateUniqueIds(data.edges, `${base}/edges`, 'edge', diagnostics);
  const segmentIds = new Set<string>();
  data.blocks.forEach((block, blockIndex) => {
    if (block.type !== 'sequence') return;
    block.segments.forEach((segment, segmentIndex) => {
      if (segmentIds.has(segment.id)) {
        diagnostics.push(diagnostic(
          `${base}/blocks/${blockIndex}/segments/${segmentIndex}/id`,
          `Duplicate segment ID '${segment.id}'.`,
        ));
      }
      segmentIds.add(segment.id);
    });
  });

  const entryBlock = blockById.get(data.entryBlockId);
  if (!entryBlock) diagnostics.push(diagnostic(`${base}/entryBlockId`, `Missing entry block '${data.entryBlockId}'.`));
  else if (entryBlock.type === 'comment') diagnostics.push(diagnostic(`${base}/entryBlockId`, 'A Comment block cannot be the Dialogue entry block.'));

  data.blocks.forEach((block, blockIndex) => {
    const path = `${base}/blocks/${blockIndex}`;
    const outgoing = data.edges.filter((edge) => edge.fromBlockId === block.id);
    if (block.type === 'sequence') {
      validateCharacter(block.defaultSpeaker, `${path}/defaultSpeaker`);
      if (outgoing.length > 1 || outgoing.some((edge) => edge.kind !== 'next')) {
        diagnostics.push(diagnostic(path, `Sequence block '${block.id}' may have at most one Next edge and no Choice edges.`));
      }
      block.segments.forEach((segment, segmentIndex) => {
        const segmentPath = `${path}/segments/${segmentIndex}`;
        if (segment.type === 'line') {
          validateCharacter(segment.speaker, `${segmentPath}/speaker`);
          validateCondition(segment.condition, `${segmentPath}/condition`);
          validateEffects(segment.effects, `${segmentPath}/effects`);
          if (inlineTextIsEmpty(segment.text)) diagnostics.push(diagnostic(`${segmentPath}/text`, `Line segment '${segment.id}' is empty.`, 'warning'));
        } else if (segment.type === 'run-lua') {
          validateCondition(segment.condition, `${segmentPath}/condition`);
        }
      });
    } else if (block.type === 'choice') {
      if (outgoing.length === 0) diagnostics.push(diagnostic(path, `Choice block '${block.id}' requires at least one Choice edge.`));
      if (outgoing.some((edge) => edge.kind !== 'choice')) diagnostics.push(diagnostic(path, `Choice block '${block.id}' may contain only Choice edges.`));
    } else if (block.type === 'redirect') {
      if (outgoing.length > 0) diagnostics.push(diagnostic(path, `Redirect block '${block.id}' cannot have outgoing edges.`));
      const target = blockById.get(block.targetBlockId);
      if (!target) diagnostics.push(diagnostic(`${path}/targetBlockId`, `Missing redirect target '${block.targetBlockId}'.`));
      else if (target.type === 'comment') diagnostics.push(diagnostic(`${path}/targetBlockId`, 'A Redirect cannot target a Comment block.'));
    } else if (outgoing.length > 0) {
      diagnostics.push(diagnostic(path, `Comment block '${block.id}' cannot have outgoing edges.`));
    }
  });

  data.edges.forEach((edge, edgeIndex) => {
    const path = `${base}/edges/${edgeIndex}`;
    const source = blockById.get(edge.fromBlockId);
    const target = blockById.get(edge.toBlockId);
    if (!source) diagnostics.push(diagnostic(`${path}/fromBlockId`, `Missing source block '${edge.fromBlockId}'.`));
    if (!target) diagnostics.push(diagnostic(`${path}/toBlockId`, `Missing target block '${edge.toBlockId}'.`));
    else if (target.type === 'comment') diagnostics.push(diagnostic(`${path}/toBlockId`, 'An edge cannot target a Comment block.'));
    if (source?.type === 'sequence' && edge.kind !== 'next') diagnostics.push(diagnostic(`${path}/kind`, 'A Sequence block may emit only a Next edge.'));
    if (source?.type === 'choice' && edge.kind !== 'choice') diagnostics.push(diagnostic(`${path}/kind`, 'A Choice block may emit only Choice edges.'));
    if (source && source.type !== 'sequence' && source.type !== 'choice') diagnostics.push(diagnostic(`${path}/fromBlockId`, `Block '${source.id}' cannot own edges.`));
    if (edge.kind === 'choice') {
      validateCondition(edge.condition, `${path}/condition`);
      validateEffects(edge.effects, `${path}/effects`);
      if (inlineTextIsEmpty(edge.label)) diagnostics.push(diagnostic(`${path}/label`, `Choice edge '${edge.id}' requires a label.`));
    }
  });

  for (const cycle of redirectCycles(data)) {
    diagnostics.push(diagnostic(`${base}/blocks`, `Redirect-only cycle detected: ${cycle.join(' -> ')} -> ${cycle[0]}.`));
  }

  if (entryBlock) {
    const reachable = reachableBlockIds(data);
    data.blocks.forEach((block, blockIndex) => {
      if (block.type !== 'comment' && !reachable.has(block.id)) {
        diagnostics.push(diagnostic(`${base}/blocks/${blockIndex}`, `Block '${block.id}' is not reachable from the entry block.`, 'warning'));
      }
    });
  }

  const completion = data.completion;
  if (completion.kind === 'scene') requireRecord('scenes', completion.id, `${base}/completion/id`);
  if (completion.kind === 'dialogue') requireRecord('dialogues', completion.id, `${base}/completion/id`);
  if (completion.kind === 'room') requireRecord('rooms', completion.id, `${base}/completion/id`);
  if (completion.kind === 'return' && project.entrypoint?.kind === 'dialogue' && project.entrypoint.id === dialogueId) {
    diagnostics.push(diagnostic(`${base}/completion`, 'A direct Dialogue entrypoint cannot complete with Return.'));
  }

  return diagnostics;
}
