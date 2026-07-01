import { z } from 'zod';
import { entityIdSchema, type AuthoringProject, type AuthoringRecordBase } from './authoring-project';

export const dialogueBlockTypeValues = ['linear', 'branch', 'link', 'comment'] as const;
export type DialogueBlockType = (typeof dialogueBlockTypeValues)[number];

export const dialogueSegmentTypeValues = ['line', 'comment', 'script'] as const;
export type DialogueSegmentType = (typeof dialogueSegmentTypeValues)[number];

export const dialogueEdgeKindValues = ['next', 'choice', 'link'] as const;
export type DialogueEdgeKind = (typeof dialogueEdgeKindValues)[number];

export const dialogueTextModeValues = ['plain', 'active-text', 'lua'] as const;
export type DialogueTextMode = (typeof dialogueTextModeValues)[number];

export const dialogueLogModeValues = ['everything', 'nothing', 'only-choices', 'only-lines'] as const;
export type DialogueLogMode = (typeof dialogueLogModeValues)[number];

export const dialoguePreviewBackgroundValues = ['dark', 'light', 'checker'] as const;
export type DialoguePreviewBackground = (typeof dialoguePreviewBackgroundValues)[number];

export const dialogueCharacterRefSchema = z.object({
  $ref: z.object({ collection: z.literal('characters'), id: z.string().min(1) }),
});

export const dialogueTextDataSchema = z.object({
  mode: z.enum(dialogueTextModeValues).default('plain'),
  source: z.string().default(''),
});

export const dialogueConditionDataSchema = z.object({
  enabled: z.boolean().default(false),
  source: z.string().default(''),
});

export const dialogueScriptDataSchema = z.object({
  enabled: z.boolean().default(false),
  source: z.string().default(''),
});

export const dialogueFlagsDataSchema = z.object({
  showOnce: z.boolean().default(false),
  autosave: z.boolean().default(false),
  logged: z.boolean().default(true),
});

export const dialogueGraphPositionSchema = z.object({
  x: z.number().finite().default(0),
  y: z.number().finite().default(0),
});

export const dialogueSegmentDataSchema = z.object({
  id: entityIdSchema,
  type: z.enum(dialogueSegmentTypeValues).default('line'),
  speaker: dialogueCharacterRefSchema.nullable().default(null),
  text: dialogueTextDataSchema.default({ mode: 'plain', source: '' }),
  condition: dialogueConditionDataSchema.default({ enabled: false, source: '' }),
  script: dialogueScriptDataSchema.default({ enabled: false, source: '' }),
  flags: dialogueFlagsDataSchema.default({ showOnce: false, autosave: false, logged: true }),
});

export const dialogueBlockDataSchema = z.object({
  id: entityIdSchema,
  type: z.enum(dialogueBlockTypeValues).default('linear'),
  label: z.string().min(1, 'Block label is required.'),
  defaultSpeaker: dialogueCharacterRefSchema.nullable().default(null),
  segments: z.array(dialogueSegmentDataSchema).default([]),
  link: z.object({
    targetBlockId: entityIdSchema.nullable().default(null),
  }).default({ targetBlockId: null }),
  graph: dialogueGraphPositionSchema.default({ x: 0, y: 0 }),
});

export const dialogueEdgeDataSchema = z.object({
  id: entityIdSchema,
  fromBlockId: entityIdSchema,
  toBlockId: entityIdSchema,
  kind: z.enum(dialogueEdgeKindValues).default('next'),
  label: z.string().default(''),
  order: z.number().int().nonnegative().default(0),
  condition: dialogueConditionDataSchema.default({ enabled: false, source: '' }),
  script: dialogueScriptDataSchema.default({ enabled: false, source: '' }),
});

export const dialogueSettingsDataSchema = z.object({
  showDisabledChoices: z.boolean().default(true),
  allowDisabledChoiceSelection: z.boolean().default(false),
  logMode: z.enum(dialogueLogModeValues).default('everything'),
});

export const dialogueDataSchema = z.object({
  kind: z.literal('dialogue').default('dialogue'),
  displayName: z.string().default(''),
  defaultSpeaker: dialogueCharacterRefSchema.nullable().default(null),
  settings: dialogueSettingsDataSchema.default({ showDisabledChoices: true, allowDisabledChoiceSelection: false, logMode: 'everything' }),
  entryBlockId: entityIdSchema.default('start'),
  blocks: z.array(dialogueBlockDataSchema).default([]),
  edges: z.array(dialogueEdgeDataSchema).default([]),
  preview: z.object({
    selectedBlockId: entityIdSchema.nullable().default(null),
    selectedSegmentId: entityIdSchema.nullable().default(null),
    showConditions: z.boolean().default(true),
    background: z.enum(dialoguePreviewBackgroundValues).default('dark'),
  }).default({ selectedBlockId: 'start', selectedSegmentId: 'line-1', showConditions: true, background: 'dark' }),
});

export type DialogueCharacterRef = z.infer<typeof dialogueCharacterRefSchema>;
export type DialogueTextData = z.infer<typeof dialogueTextDataSchema>;
export type DialogueConditionData = z.infer<typeof dialogueConditionDataSchema>;
export type DialogueScriptData = z.infer<typeof dialogueScriptDataSchema>;
export type DialogueFlagsData = z.infer<typeof dialogueFlagsDataSchema>;
export type DialogueGraphPosition = z.infer<typeof dialogueGraphPositionSchema>;
export type DialogueSegmentData = z.infer<typeof dialogueSegmentDataSchema>;
export type DialogueBlockData = z.infer<typeof dialogueBlockDataSchema>;
export type DialogueEdgeData = z.infer<typeof dialogueEdgeDataSchema>;
export type DialogueSettingsData = z.infer<typeof dialogueSettingsDataSchema>;
export type DialogueData = z.infer<typeof dialogueDataSchema>;

export interface DialogueSchemaDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
}

function diagnostic(path: string, message: string, severity: 'error' | 'warning' | 'info' = 'error'): DialogueSchemaDiagnostic {
  return { severity, path, message, category: 'authoring-dialogues' };
}

export function parseDialogueData(value: unknown): DialogueData | null {
  const parsed = dialogueDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function defaultDialogueData(label = 'Dialogue'): DialogueData {
  return dialogueDataSchema.parse({
    kind: 'dialogue',
    displayName: label,
    defaultSpeaker: null,
    settings: {
      showDisabledChoices: true,
      allowDisabledChoiceSelection: false,
      logMode: 'everything',
    },
    entryBlockId: 'start',
    blocks: [{
      id: 'start',
      type: 'linear',
      label: 'Start',
      defaultSpeaker: null,
      segments: [{
        id: 'line-1',
        type: 'line',
        speaker: null,
        text: { mode: 'plain', source: '' },
        condition: { enabled: false, source: '' },
        script: { enabled: false, source: '' },
        flags: { showOnce: false, autosave: false, logged: true },
      }],
      link: { targetBlockId: null },
      graph: { x: 0, y: 0 },
    }],
    edges: [],
    preview: { selectedBlockId: 'start', selectedSegmentId: 'line-1', showConditions: true, background: 'dark' },
  });
}

export function isDialogueRecord(record: AuthoringRecordBase | undefined | null): record is AuthoringRecordBase & { data: DialogueData } {
  return !!record && parseDialogueData(record.data) !== null;
}

function refId(ref: DialogueCharacterRef | null | undefined): string | null {
  return ref?.$ref.id ?? null;
}

function validateCharacterRef(project: AuthoringProject, ref: DialogueCharacterRef | null, path: string, diagnostics: DialogueSchemaDiagnostic[]) {
  const id = refId(ref);
  if (!id) return;
  if (!project.characters[id]) diagnostics.push(diagnostic(`${path}/$ref`, `Missing character '${id}'.`));
}

function validateUniqueIds(items: Array<{ id: string }>, path: string, label: string, diagnostics: DialogueSchemaDiagnostic[]) {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) diagnostics.push(diagnostic(`${path}/${index}/id`, `Duplicate ${label} ID '${item.id}'.`));
    seen.add(item.id);
  });
}

function reachableBlockIds(entryBlockId: string, edges: DialogueEdgeData[]): Set<string> {
  const reachable = new Set<string>();
  const stack = [entryBlockId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const edge of edges) {
      if (edge.fromBlockId === id && !reachable.has(edge.toBlockId)) stack.push(edge.toBlockId);
    }
  }
  return reachable;
}

function detectCycles(edges: DialogueEdgeData[]): Set<string> {
  const cyclic = new Set<string>();
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.fromBlockId) ?? [];
    list.push(edge.toBlockId);
    adjacency.set(edge.fromBlockId, list);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) {
      cyclic.add(id);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of adjacency.get(id) ?? []) visit(next);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of adjacency.keys()) visit(id);
  return cyclic;
}

export function validateDialogueData(
  project: AuthoringProject,
  dialogueId: string,
  record: AuthoringRecordBase,
): DialogueSchemaDiagnostic[] {
  const diagnostics: DialogueSchemaDiagnostic[] = [];
  const parsed = dialogueDataSchema.safeParse(record.data);
  const base = `/dialogues/${dialogueId}/data`;
  if (!parsed.success) {
    for (const issue of parsed.error.issues) diagnostics.push(diagnostic(`${base}/${issue.path.map(String).join('/')}`, issue.message));
    return diagnostics;
  }

  const data = parsed.data;
  if (record.inherits) {
    if (record.inherits.collection !== 'dialogues') {
      diagnostics.push(diagnostic(`/dialogues/${dialogueId}/inherits`, 'Dialogue inheritance must target another dialogue.'));
    } else if (!project.dialogues[record.inherits.id]) {
      diagnostics.push(diagnostic(`/dialogues/${dialogueId}/inherits`, `Missing inherited dialogue '${record.inherits.id}'.`));
    }
  }

  validateCharacterRef(project, data.defaultSpeaker, `${base}/defaultSpeaker`, diagnostics);

  if (data.blocks.length === 0) diagnostics.push(diagnostic(`${base}/blocks`, 'Dialogue requires at least one block.'));
  validateUniqueIds(data.blocks, `${base}/blocks`, 'block', diagnostics);
  validateUniqueIds(data.edges, `${base}/edges`, 'edge', diagnostics);

  const blockIds = new Set(data.blocks.map((block) => block.id));
  if (!blockIds.has(data.entryBlockId)) diagnostics.push(diagnostic(`${base}/entryBlockId`, `Missing entry block '${data.entryBlockId}'.`));

  data.blocks.forEach((block, blockIndex) => {
    const blockPath = `${base}/blocks/${blockIndex}`;
    validateCharacterRef(project, block.defaultSpeaker, `${blockPath}/defaultSpeaker`, diagnostics);
    validateUniqueIds(block.segments, `${blockPath}/segments`, 'segment', diagnostics);
    if (block.link.targetBlockId && !blockIds.has(block.link.targetBlockId)) {
      diagnostics.push(diagnostic(`${blockPath}/link/targetBlockId`, `Missing linked block '${block.link.targetBlockId}'.`));
    }
    if (block.segments.length === 0 && block.type !== 'link' && block.type !== 'comment') {
      diagnostics.push(diagnostic(`${blockPath}/segments`, `Block '${block.id}' has no dialogue segments.`, 'warning'));
    }
    block.segments.forEach((segment, segmentIndex) => {
      const segmentPath = `${blockPath}/segments/${segmentIndex}`;
      validateCharacterRef(project, segment.speaker, `${segmentPath}/speaker`, diagnostics);
      if (segment.type === 'line' && !segment.text.source.trim()) {
        diagnostics.push(diagnostic(`${segmentPath}/text/source`, `Line segment '${segment.id}' is empty.`, 'warning'));
      }
      if (segment.condition.enabled && !segment.condition.source.trim()) {
        diagnostics.push(diagnostic(`${segmentPath}/condition/source`, `Condition is enabled but empty.`, 'warning'));
      }
      if (segment.script.enabled && !segment.script.source.trim()) {
        diagnostics.push(diagnostic(`${segmentPath}/script/source`, `Script is enabled but empty.`, 'warning'));
      }
    });
  });

  const edgeOrderKeys = new Set<string>();
  data.edges.forEach((edge, edgeIndex) => {
    const edgePath = `${base}/edges/${edgeIndex}`;
    if (!blockIds.has(edge.fromBlockId)) diagnostics.push(diagnostic(`${edgePath}/fromBlockId`, `Missing source block '${edge.fromBlockId}'.`));
    if (!blockIds.has(edge.toBlockId)) diagnostics.push(diagnostic(`${edgePath}/toBlockId`, `Missing target block '${edge.toBlockId}'.`));
    if (edge.fromBlockId === edge.toBlockId) diagnostics.push(diagnostic(edgePath, `Edge '${edge.id}' targets its source block.`, 'warning'));
    if (edge.kind === 'choice' && !edge.label.trim()) diagnostics.push(diagnostic(`${edgePath}/label`, `Choice edge '${edge.id}' has no label.`, 'warning'));
    if (edge.condition.enabled && !edge.condition.source.trim()) diagnostics.push(diagnostic(`${edgePath}/condition/source`, `Condition is enabled but empty.`, 'warning'));
    if (edge.script.enabled && !edge.script.source.trim()) diagnostics.push(diagnostic(`${edgePath}/script/source`, `Script is enabled but empty.`, 'warning'));
    const orderKey = `${edge.fromBlockId}:${edge.kind}:${edge.order}`;
    if (edgeOrderKeys.has(orderKey)) diagnostics.push(diagnostic(`${edgePath}/order`, `Duplicate edge order ${edge.order} for ${edge.fromBlockId}/${edge.kind}.`, 'warning'));
    edgeOrderKeys.add(orderKey);
  });

  if (blockIds.has(data.entryBlockId)) {
    const reachable = reachableBlockIds(data.entryBlockId, data.edges);
    data.blocks.forEach((block, blockIndex) => {
      if (!reachable.has(block.id)) diagnostics.push(diagnostic(`${base}/blocks/${blockIndex}`, `Block '${block.id}' is not reachable from the entry block.`, 'warning'));
    });
  }

  const cycles = detectCycles(data.edges);
  if (cycles.size > 0) {
    diagnostics.push(diagnostic(`${base}/edges`, `Dialogue graph contains a cycle involving ${[...cycles].sort().join(', ')}.`, 'warning'));
  }

  return diagnostics;
}

export function dialogueCharacterRef(characterId: string): DialogueCharacterRef {
  return { $ref: { collection: 'characters', id: characterId } };
}
