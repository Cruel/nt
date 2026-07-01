import { z } from 'zod';
import { parseAssetData } from './authoring-assets';
import { parseCharacterData } from './authoring-characters';
import { parseDialogueData } from './authoring-dialogues';
import { parseLayoutData } from './authoring-layouts';
import { parseMaterialData } from './authoring-materials';
import { parseVariableData } from './authoring-variables';
import { entityIdSchema, type AuthoringProject, type AuthoringRecordBase } from './authoring-project';

export const sceneStepTypeValues = [
  'background',
  'character',
  'dialogue',
  'audio',
  'variable',
  'script',
  'wait',
  'branch',
  'layout',
  'transition',
  'comment',
] as const;
export type SceneStepType = (typeof sceneStepTypeValues)[number];

export const sceneBackgroundFitValues = ['cover', 'contain', 'stretch', 'center'] as const;
export const sceneBackgroundTransitionValues = ['none', 'fade', 'cut'] as const;
export const sceneCharacterActionValues = ['show', 'hide', 'move', 'pose', 'expression'] as const;
export const sceneCharacterPositionValues = ['left', 'center', 'right', 'custom'] as const;
export const sceneCharacterTransitionValues = ['none', 'fade', 'slide'] as const;
export const sceneDialogueModeValues = ['play', 'preview-block'] as const;
export const sceneAudioChannelValues = ['sound-effect', 'music', 'voice', 'ambient'] as const;
export const sceneAudioActionValues = ['play', 'stop', 'fade-in', 'fade-out'] as const;
export const sceneVariableOperationValues = ['set', 'check'] as const;
export const sceneVariableComparisonValues = ['equals', 'not-equals', 'greater-than', 'less-than', 'truthy', 'falsy'] as const;
export const sceneWaitModeValues = ['duration', 'input'] as const;
export const sceneLayoutActionValues = ['show', 'hide', 'swap'] as const;
export const sceneLayoutSlotValues = ['hud', 'dialogue-box', 'overlay', 'custom'] as const;
export const sceneTransitionKindValues = ['fade', 'cut', 'dissolve'] as const;
export const scenePreviewPlaybackValues = ['from-start', 'from-selected'] as const;
export const scenePreviewBackgroundValues = ['dark', 'light', 'checker'] as const;

export const sceneAssetRefSchema = z.object({ $ref: z.object({ collection: z.literal('assets'), id: z.string().min(1) }) });
export const sceneMaterialRefSchema = z.object({ $ref: z.object({ collection: z.literal('materials'), id: z.string().min(1) }) });
export const sceneCharacterRefSchema = z.object({ $ref: z.object({ collection: z.literal('characters'), id: z.string().min(1) }) });
export const sceneDialogueRefSchema = z.object({ $ref: z.object({ collection: z.literal('dialogues'), id: z.string().min(1) }) });
export const sceneLayoutRefSchema = z.object({ $ref: z.object({ collection: z.literal('layouts'), id: z.string().min(1) }) });
export const sceneVariableRefSchema = z.object({ $ref: z.object({ collection: z.literal('variables'), id: z.string().min(1) }) });
export const sceneRoomRefSchema = z.object({ $ref: z.object({ collection: z.literal('rooms'), id: z.string().min(1) }) });
export const sceneSceneRefSchema = z.object({ $ref: z.object({ collection: z.literal('scenes'), id: z.string().min(1) }) });
export const sceneNextTargetSchema = z.union([sceneSceneRefSchema, sceneRoomRefSchema, sceneDialogueRefSchema]);

export const sceneConditionDataSchema = z.object({ enabled: z.boolean().default(false), source: z.string().default('') });
export const sceneTimingDataSchema = z.object({
  delayMs: z.number().finite().nonnegative().default(0),
  durationMs: z.number().finite().nonnegative().default(1000),
  waitForInput: z.boolean().default(false),
  canSkip: z.boolean().default(true),
});
export const sceneAutosaveDataSchema = z.object({ before: z.boolean().default(false), after: z.boolean().default(false) });
export const sceneVector2Schema = z.object({ x: z.number().finite().default(0), y: z.number().finite().default(0) });

export const sceneBackgroundStepDataSchema = z.object({
  asset: sceneAssetRefSchema.nullable().default(null),
  material: sceneMaterialRefSchema.nullable().default(null),
  color: z.string().nullable().default(null),
  fit: z.enum(sceneBackgroundFitValues).default('cover'),
  transition: z.enum(sceneBackgroundTransitionValues).default('fade'),
});

export const sceneCharacterStepDataSchema = z.object({
  character: sceneCharacterRefSchema.nullable().default(null),
  action: z.enum(sceneCharacterActionValues).default('show'),
  poseId: entityIdSchema.nullable().default(null),
  expressionId: entityIdSchema.nullable().default(null),
  position: z.enum(sceneCharacterPositionValues).default('center'),
  offset: sceneVector2Schema.default({ x: 0, y: 0 }),
  scale: z.number().finite().positive().default(1),
  transition: z.enum(sceneCharacterTransitionValues).default('fade'),
});

export const sceneDialogueStepDataSchema = z.object({
  dialogue: sceneDialogueRefSchema.nullable().default(null),
  startBlockId: entityIdSchema.nullable().default(null),
  mode: z.enum(sceneDialogueModeValues).default('play'),
});

export const sceneAudioStepDataSchema = z.object({
  asset: sceneAssetRefSchema.nullable().default(null),
  channel: z.enum(sceneAudioChannelValues).default('sound-effect'),
  action: z.enum(sceneAudioActionValues).default('play'),
  loop: z.boolean().default(false),
  volume: z.number().finite().min(0).max(1).default(1),
  fadeMs: z.number().finite().nonnegative().default(0),
});

export const sceneVariableStepDataSchema = z.object({
  variable: sceneVariableRefSchema.nullable().default(null),
  operation: z.enum(sceneVariableOperationValues).default('set'),
  value: z.unknown().default(false),
  comparison: z.enum(sceneVariableComparisonValues).default('equals'),
});

export const sceneScriptStepDataSchema = z.object({ source: z.string().default(''), comment: z.string().default('') });
export const sceneWaitStepDataSchema = z.object({ mode: z.enum(sceneWaitModeValues).default('duration'), durationMs: z.number().finite().nonnegative().default(1000) });
export const sceneBranchChoiceDataSchema = z.object({
  id: entityIdSchema,
  label: z.string().default(''),
  targetStepId: entityIdSchema.nullable().default(null),
  condition: sceneConditionDataSchema.default({ enabled: false, source: '' }),
  order: z.number().int().nonnegative().default(0),
});
export const sceneBranchStepDataSchema = z.object({ choices: z.array(sceneBranchChoiceDataSchema).default([]) });
export const sceneLayoutStepDataSchema = z.object({
  layout: sceneLayoutRefSchema.nullable().default(null),
  action: z.enum(sceneLayoutActionValues).default('show'),
  slot: z.enum(sceneLayoutSlotValues).default('overlay'),
});
export const sceneTransitionStepDataSchema = z.object({
  kind: z.enum(sceneTransitionKindValues).default('fade'),
  durationMs: z.number().finite().nonnegative().default(1000),
  color: z.string().nullable().default(null),
});
export const sceneCommentStepDataSchema = z.object({ source: z.string().default('') });

export const sceneStepDataSchema = z.object({
  id: entityIdSchema,
  type: z.enum(sceneStepTypeValues).default('comment'),
  label: z.string().min(1, 'Step label is required.'),
  enabled: z.boolean().default(true),
  condition: sceneConditionDataSchema.default({ enabled: false, source: '' }),
  timing: sceneTimingDataSchema.default({ delayMs: 0, durationMs: 1000, waitForInput: false, canSkip: true }),
  autosave: sceneAutosaveDataSchema.default({ before: false, after: false }),
  background: sceneBackgroundStepDataSchema.default({ asset: null, material: null, color: null, fit: 'cover', transition: 'fade' }),
  character: sceneCharacterStepDataSchema.default({ character: null, action: 'show', poseId: null, expressionId: null, position: 'center', offset: { x: 0, y: 0 }, scale: 1, transition: 'fade' }),
  dialogue: sceneDialogueStepDataSchema.default({ dialogue: null, startBlockId: null, mode: 'play' }),
  audio: sceneAudioStepDataSchema.default({ asset: null, channel: 'sound-effect', action: 'play', loop: false, volume: 1, fadeMs: 0 }),
  variable: sceneVariableStepDataSchema.default({ variable: null, operation: 'set', value: false, comparison: 'equals' }),
  script: sceneScriptStepDataSchema.default({ source: '', comment: '' }),
  wait: sceneWaitStepDataSchema.default({ mode: 'duration', durationMs: 1000 }),
  branch: sceneBranchStepDataSchema.default({ choices: [] }),
  layout: sceneLayoutStepDataSchema.default({ layout: null, action: 'show', slot: 'overlay' }),
  transition: sceneTransitionStepDataSchema.default({ kind: 'fade', durationMs: 1000, color: null }),
  comment: sceneCommentStepDataSchema.default({ source: '' }),
});

export const sceneSettingsDataSchema = z.object({
  fullScreen: z.boolean().default(true),
  canFastForward: z.boolean().default(true),
  speedFactor: z.number().finite().positive().default(1),
  next: sceneNextTargetSchema.nullable().default(null),
});

export const sceneDefaultsDataSchema = z.object({
  background: z.object({
    asset: sceneAssetRefSchema.nullable().default(null),
    material: sceneMaterialRefSchema.nullable().default(null),
    color: z.string().nullable().default('#0f172a'),
    fit: z.enum(sceneBackgroundFitValues).default('cover'),
  }).default({ asset: null, material: null, color: '#0f172a', fit: 'cover' }),
  layout: sceneLayoutRefSchema.nullable().default(null),
});

export const sceneDataSchema = z.object({
  kind: z.literal('scene').default('scene'),
  displayName: z.string().default(''),
  settings: sceneSettingsDataSchema.default({ fullScreen: true, canFastForward: true, speedFactor: 1, next: null }),
  defaults: sceneDefaultsDataSchema.default({ background: { asset: null, material: null, color: '#0f172a', fit: 'cover' }, layout: null }),
  steps: z.array(sceneStepDataSchema).default([]),
  preview: z.object({
    selectedStepId: entityIdSchema.nullable().default(null),
    playback: z.enum(scenePreviewPlaybackValues).default('from-start'),
    showDisabledSteps: z.boolean().default(true),
    background: z.enum(scenePreviewBackgroundValues).default('dark'),
  }).default({ selectedStepId: 'start', playback: 'from-start', showDisabledSteps: true, background: 'dark' }),
});

export type SceneAssetRef = z.infer<typeof sceneAssetRefSchema>;
export type SceneMaterialRef = z.infer<typeof sceneMaterialRefSchema>;
export type SceneCharacterRef = z.infer<typeof sceneCharacterRefSchema>;
export type SceneDialogueRef = z.infer<typeof sceneDialogueRefSchema>;
export type SceneLayoutRef = z.infer<typeof sceneLayoutRefSchema>;
export type SceneVariableRef = z.infer<typeof sceneVariableRefSchema>;
export type SceneRoomRef = z.infer<typeof sceneRoomRefSchema>;
export type SceneSceneRef = z.infer<typeof sceneSceneRefSchema>;
export type SceneNextTarget = z.infer<typeof sceneNextTargetSchema>;
export type SceneConditionData = z.infer<typeof sceneConditionDataSchema>;
export type SceneTimingData = z.infer<typeof sceneTimingDataSchema>;
export type SceneAutosaveData = z.infer<typeof sceneAutosaveDataSchema>;
export type SceneBranchChoiceData = z.infer<typeof sceneBranchChoiceDataSchema>;
export type SceneStepData = z.infer<typeof sceneStepDataSchema>;
export type SceneSettingsData = z.infer<typeof sceneSettingsDataSchema>;
export type SceneDefaultsData = z.infer<typeof sceneDefaultsDataSchema>;
export type SceneData = z.infer<typeof sceneDataSchema>;

export interface SceneSchemaDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
}

function diagnostic(path: string, message: string, severity: 'error' | 'warning' | 'info' = 'error'): SceneSchemaDiagnostic {
  return { severity, path, message, category: 'authoring-scenes' };
}

export function parseSceneData(value: unknown): SceneData | null {
  const parsed = sceneDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function defaultSceneStep(type: SceneStepType = 'comment', label?: string): SceneStepData {
  const stepLabel = label ?? (type === 'comment' ? 'Start' : type[0]!.toUpperCase() + type.slice(1));
  return sceneStepDataSchema.parse({ id: type === 'comment' ? 'start' : type, type, label: stepLabel });
}

export function defaultSceneData(label = 'Scene'): SceneData {
  return sceneDataSchema.parse({
    kind: 'scene',
    displayName: label,
    settings: { fullScreen: true, canFastForward: true, speedFactor: 1, next: null },
    defaults: { background: { asset: null, material: null, color: '#0f172a', fit: 'cover' }, layout: null },
    steps: [defaultSceneStep('comment', 'Start')],
    preview: { selectedStepId: 'start', playback: 'from-start', showDisabledSteps: true, background: 'dark' },
  });
}

export function isSceneRecord(record: AuthoringRecordBase | undefined | null): record is AuthoringRecordBase & { data: SceneData } {
  return !!record && parseSceneData(record.data) !== null;
}

export function sceneAssetRef(id: string): SceneAssetRef { return { $ref: { collection: 'assets', id } }; }
export function sceneMaterialRef(id: string): SceneMaterialRef { return { $ref: { collection: 'materials', id } }; }
export function sceneCharacterRef(id: string): SceneCharacterRef { return { $ref: { collection: 'characters', id } }; }
export function sceneDialogueRef(id: string): SceneDialogueRef { return { $ref: { collection: 'dialogues', id } }; }
export function sceneLayoutRef(id: string): SceneLayoutRef { return { $ref: { collection: 'layouts', id } }; }
export function sceneVariableRef(id: string): SceneVariableRef { return { $ref: { collection: 'variables', id } }; }
export function sceneRoomRef(id: string): SceneRoomRef { return { $ref: { collection: 'rooms', id } }; }
export function sceneSceneRef(id: string): SceneSceneRef { return { $ref: { collection: 'scenes', id } }; }

function refId(ref: { $ref: { id: string } } | null | undefined): string | null {
  return ref?.$ref.id ?? null;
}

function validateUniqueIds(items: Array<{ id: string }>, path: string, label: string, diagnostics: SceneSchemaDiagnostic[]) {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) diagnostics.push(diagnostic(`${path}/${index}/id`, `Duplicate ${label} ID '${item.id}'.`));
    seen.add(item.id);
  });
}

function validateAssetRef(project: AuthoringProject, ref: SceneAssetRef | null, path: string, expectedKind: 'image' | 'audio' | null, diagnostics: SceneSchemaDiagnostic[]) {
  const id = refId(ref);
  if (!id) return;
  const record = project.assets[id];
  if (!record) {
    diagnostics.push(diagnostic(`${path}/$ref`, `Missing asset '${id}'.`));
    return;
  }
  const data = parseAssetData(record.data);
  if (!data) diagnostics.push(diagnostic(`${path}/$ref`, `Asset '${id}' has invalid asset data.`, 'warning'));
  else if (expectedKind && data.kind !== expectedKind) diagnostics.push(diagnostic(`${path}/$ref`, `Asset '${id}' is ${data.kind}, not ${expectedKind}.`, 'warning'));
}

function validateMaterialRef(project: AuthoringProject, ref: SceneMaterialRef | null, path: string, diagnostics: SceneSchemaDiagnostic[]) {
  const id = refId(ref);
  if (!id) return;
  const record = project.materials[id];
  if (!record) diagnostics.push(diagnostic(`${path}/$ref`, `Missing material '${id}'.`));
  else if (!parseMaterialData(record.data)) diagnostics.push(diagnostic(`${path}/$ref`, `Material '${id}' has invalid material data.`, 'warning'));
}

function validateLayoutRef(project: AuthoringProject, ref: SceneLayoutRef | null, path: string, diagnostics: SceneSchemaDiagnostic[]) {
  const id = refId(ref);
  if (!id) return;
  const record = project.layouts[id];
  if (!record) diagnostics.push(diagnostic(`${path}/$ref`, `Missing layout '${id}'.`));
  else if (!parseLayoutData(record.data)) diagnostics.push(diagnostic(`${path}/$ref`, `Layout '${id}' has invalid layout data.`, 'warning'));
}

function validateVariableRef(project: AuthoringProject, ref: SceneVariableRef | null, path: string, diagnostics: SceneSchemaDiagnostic[]) {
  const id = refId(ref);
  if (!id) return;
  const record = project.variables[id];
  if (!record) diagnostics.push(diagnostic(`${path}/$ref`, `Missing variable '${id}'.`));
  else if (!parseVariableData(record.data)) diagnostics.push(diagnostic(`${path}/$ref`, `Variable '${id}' has invalid variable data.`, 'warning'));
}

function validateCharacterStep(project: AuthoringProject, step: SceneStepData, path: string, diagnostics: SceneSchemaDiagnostic[]) {
  const id = refId(step.character.character);
  if (!id) return;
  const record = project.characters[id];
  if (!record) {
    diagnostics.push(diagnostic(`${path}/character/character/$ref`, `Missing character '${id}'.`));
    return;
  }
  const data = parseCharacterData(record.data);
  if (!data) {
    diagnostics.push(diagnostic(`${path}/character/character/$ref`, `Character '${id}' has invalid character data.`, 'warning'));
    return;
  }
  const poses = new Set(data.poses.map((pose) => pose.id));
  const expressions = new Set(data.expressions.map((expression) => expression.id));
  if (step.character.poseId && !poses.has(step.character.poseId)) diagnostics.push(diagnostic(`${path}/character/poseId`, `Character '${id}' has no pose '${step.character.poseId}'.`, 'warning'));
  if (step.character.expressionId && !expressions.has(step.character.expressionId)) diagnostics.push(diagnostic(`${path}/character/expressionId`, `Character '${id}' has no expression '${step.character.expressionId}'.`, 'warning'));
}

function validateDialogueStep(project: AuthoringProject, step: SceneStepData, path: string, diagnostics: SceneSchemaDiagnostic[]) {
  const id = refId(step.dialogue.dialogue);
  if (!id) return;
  const record = project.dialogues[id];
  if (!record) {
    diagnostics.push(diagnostic(`${path}/dialogue/dialogue/$ref`, `Missing dialogue '${id}'.`));
    return;
  }
  const data = parseDialogueData(record.data);
  if (!data) {
    diagnostics.push(diagnostic(`${path}/dialogue/dialogue/$ref`, `Dialogue '${id}' has invalid dialogue data.`, 'warning'));
    return;
  }
  if (step.dialogue.startBlockId && !data.blocks.some((block) => block.id === step.dialogue.startBlockId)) {
    diagnostics.push(diagnostic(`${path}/dialogue/startBlockId`, `Dialogue '${id}' has no block '${step.dialogue.startBlockId}'.`));
  }
}

function validateNextTarget(project: AuthoringProject, target: SceneNextTarget | null, path: string, sceneId: string, diagnostics: SceneSchemaDiagnostic[]) {
  if (!target) return;
  const { collection, id } = target.$ref;
  if (collection === 'scenes' && id === sceneId) diagnostics.push(diagnostic(path, 'Scene next target points to itself.', 'warning'));
  if (!project[collection][id]) diagnostics.push(diagnostic(`${path}/$ref`, `Missing next target '${collection}:${id}'.`));
}

export function validateSceneData(project: AuthoringProject, sceneId: string, record: AuthoringRecordBase): SceneSchemaDiagnostic[] {
  const diagnostics: SceneSchemaDiagnostic[] = [];
  const parsed = sceneDataSchema.safeParse(record.data);
  const base = `/scenes/${sceneId}/data`;
  if (!parsed.success) {
    for (const issue of parsed.error.issues) diagnostics.push(diagnostic(`${base}/${issue.path.map(String).join('/')}`, issue.message));
    return diagnostics;
  }

  const data = parsed.data;
  if (record.inherits) {
    if (record.inherits.collection !== 'scenes') diagnostics.push(diagnostic(`/scenes/${sceneId}/inherits`, 'Scene inheritance must target another scene.'));
    else if (!project.scenes[record.inherits.id]) diagnostics.push(diagnostic(`/scenes/${sceneId}/inherits`, `Missing inherited scene '${record.inherits.id}'.`));
  }

  validateNextTarget(project, data.settings.next, `${base}/settings/next`, sceneId, diagnostics);
  validateAssetRef(project, data.defaults.background.asset, `${base}/defaults/background/asset`, 'image', diagnostics);
  validateMaterialRef(project, data.defaults.background.material, `${base}/defaults/background/material`, diagnostics);
  validateLayoutRef(project, data.defaults.layout, `${base}/defaults/layout`, diagnostics);

  if (data.steps.length === 0) diagnostics.push(diagnostic(`${base}/steps`, 'Scene requires at least one step.'));
  validateUniqueIds(data.steps, `${base}/steps`, 'step', diagnostics);
  const stepIds = new Set(data.steps.map((step) => step.id));
  if (data.preview.selectedStepId && !stepIds.has(data.preview.selectedStepId)) diagnostics.push(diagnostic(`${base}/preview/selectedStepId`, `Missing preview step '${data.preview.selectedStepId}'.`, 'warning'));

  data.steps.forEach((step, index) => {
    const stepPath = `${base}/steps/${index}`;
    if (step.condition.enabled && !step.condition.source.trim()) diagnostics.push(diagnostic(`${stepPath}/condition/source`, 'Condition is enabled but empty.', 'warning'));
    if (step.timing.delayMs < 0) diagnostics.push(diagnostic(`${stepPath}/timing/delayMs`, 'Step delay cannot be negative.'));
    if (step.timing.durationMs < 0) diagnostics.push(diagnostic(`${stepPath}/timing/durationMs`, 'Step duration cannot be negative.'));

    if (step.type === 'background') {
      validateAssetRef(project, step.background.asset, `${stepPath}/background/asset`, 'image', diagnostics);
      validateMaterialRef(project, step.background.material, `${stepPath}/background/material`, diagnostics);
    } else if (step.type === 'character') {
      validateCharacterStep(project, step, stepPath, diagnostics);
    } else if (step.type === 'dialogue') {
      validateDialogueStep(project, step, stepPath, diagnostics);
    } else if (step.type === 'audio') {
      validateAssetRef(project, step.audio.asset, `${stepPath}/audio/asset`, 'audio', diagnostics);
    } else if (step.type === 'variable') {
      validateVariableRef(project, step.variable.variable, `${stepPath}/variable/variable`, diagnostics);
    } else if (step.type === 'script' && !step.script.source.trim()) {
      diagnostics.push(diagnostic(`${stepPath}/script/source`, 'Script step has no source.', 'warning'));
    } else if (step.type === 'branch') {
      validateUniqueIds(step.branch.choices, `${stepPath}/branch/choices`, 'branch choice', diagnostics);
      const orderKeys = new Set<number>();
      step.branch.choices.forEach((choice, choiceIndex) => {
        const choicePath = `${stepPath}/branch/choices/${choiceIndex}`;
        if (!choice.label.trim()) diagnostics.push(diagnostic(`${choicePath}/label`, 'Branch choice label is required.'));
        if (choice.targetStepId && !stepIds.has(choice.targetStepId)) diagnostics.push(diagnostic(`${choicePath}/targetStepId`, `Missing target step '${choice.targetStepId}'.`));
        if (choice.condition.enabled && !choice.condition.source.trim()) diagnostics.push(diagnostic(`${choicePath}/condition/source`, 'Choice condition is enabled but empty.', 'warning'));
        if (orderKeys.has(choice.order)) diagnostics.push(diagnostic(`${choicePath}/order`, `Duplicate branch choice order ${choice.order}.`, 'warning'));
        orderKeys.add(choice.order);
      });
    } else if (step.type === 'layout') {
      if (step.layout.action !== 'hide') validateLayoutRef(project, step.layout.layout, `${stepPath}/layout/layout`, diagnostics);
    }
  });

  return diagnostics;
}
