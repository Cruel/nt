import { parseAssetData } from './authoring-assets';
import { parseCharacterData } from './authoring-characters';
import { parseDialogueData } from './authoring-dialogues';
import { parseLayoutData } from './authoring-layouts';
import { parseMaterialData } from './authoring-materials';
import { parseVariableData } from './authoring-variables';
import {
  parseSceneData,
  validateSceneData,
  type SceneData,
  type SceneStepData,
} from './authoring-scenes';
import type { AuthoringProject } from './authoring-project';

export const SCENE_PREVIEW_SCHEMA = 'noveltea.scene-preview.v1' as const;

export interface SceneProjectDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
}

function diagnostic(path: string, message: string, severity: 'error' | 'warning' | 'info' = 'error'): SceneProjectDiagnostic {
  return { severity, path, message, category: 'scene-project' };
}

function assetMetadata(project: AuthoringProject, id: string | null | undefined): Record<string, unknown> | null {
  if (!id) return null;
  const record = project.assets[id];
  const data = parseAssetData(record?.data);
  return { id, label: record?.label ?? id, kind: data?.kind ?? 'missing', path: data?.source.path ?? null, contentHash: data?.contentHash ?? null };
}

function materialMetadata(project: AuthoringProject, id: string | null | undefined): Record<string, unknown> | null {
  if (!id) return null;
  const record = project.materials[id];
  const data = parseMaterialData(record?.data);
  return { id, label: record?.label ?? id, role: data?.role ?? null, shader: data?.shader?.$ref.id ?? null };
}

function layoutMetadata(project: AuthoringProject, id: string | null | undefined): Record<string, unknown> | null {
  if (!id) return null;
  const record = project.layouts[id];
  const data = parseLayoutData(record?.data);
  return { id, label: record?.label ?? id, layoutKind: data?.layoutKind ?? null };
}

function characterMetadata(project: AuthoringProject, id: string | null | undefined, poseId?: string | null, expressionId?: string | null): Record<string, unknown> | null {
  if (!id) return null;
  const record = project.characters[id];
  const data = parseCharacterData(record?.data);
  const pose = poseId ? data?.poses.find((item) => item.id === poseId) : null;
  const expression = expressionId ? data?.expressions.find((item) => item.id === expressionId) : null;
  return { id, label: record?.label ?? id, displayName: data?.displayName ?? record?.label ?? id, pose: pose?.label ?? poseId ?? null, expression: expression?.label ?? expressionId ?? null };
}

function dialogueMetadata(project: AuthoringProject, id: string | null | undefined, blockId?: string | null): Record<string, unknown> | null {
  if (!id) return null;
  const record = project.dialogues[id];
  const data = parseDialogueData(record?.data);
  const block = blockId ? data?.blocks.find((item) => item.id === blockId) : data?.blocks.find((item) => item.id === data.entryBlockId);
  return { id, label: record?.label ?? id, displayName: data?.displayName ?? record?.label ?? id, blockId: block?.id ?? blockId ?? null, blockLabel: block?.label ?? null };
}

function variableMetadata(project: AuthoringProject, id: string | null | undefined): Record<string, unknown> | null {
  if (!id) return null;
  const record = project.variables[id];
  const data = parseVariableData(record?.data);
  return { id, label: record?.label ?? id, type: data?.type ?? null, defaultValue: data?.defaultValue ?? null };
}

function refId(ref: { $ref: { id: string } } | null | undefined): string | null {
  return ref?.$ref.id ?? null;
}

function activeStepPayloadSummary(project: AuthoringProject, step: SceneStepData): Record<string, unknown> {
  if (step.type === 'background') {
    return {
      ...step.background,
      assetMetadata: assetMetadata(project, refId(step.background.asset)),
      materialMetadata: materialMetadata(project, refId(step.background.material)),
    };
  }
  if (step.type === 'character') {
    return {
      ...step.character,
      characterMetadata: characterMetadata(project, refId(step.character.character), step.character.poseId, step.character.expressionId),
    };
  }
  if (step.type === 'dialogue') {
    return { ...step.dialogue, dialogueMetadata: dialogueMetadata(project, refId(step.dialogue.dialogue), step.dialogue.startBlockId) };
  }
  if (step.type === 'audio') {
    return { ...step.audio, assetMetadata: assetMetadata(project, refId(step.audio.asset)) };
  }
  if (step.type === 'variable') {
    return { ...step.variable, variableMetadata: variableMetadata(project, refId(step.variable.variable)) };
  }
  if (step.type === 'layout') {
    return { ...step.layout, layoutMetadata: layoutMetadata(project, refId(step.layout.layout)) };
  }
  return step[step.type] as Record<string, unknown>;
}

function selectedStep(data: SceneData): { step: SceneStepData | null; index: number } {
  let index = data.steps.findIndex((step) => step.id === data.preview.selectedStepId);
  if (index < 0) index = 0;
  return { step: data.steps[index] ?? null, index };
}

function approximateState(project: AuthoringProject, data: SceneData, selectedIndex: number): Record<string, unknown> {
  const state: Record<string, unknown> = {
    background: {
      ...data.defaults.background,
      assetMetadata: assetMetadata(project, refId(data.defaults.background.asset)),
      materialMetadata: materialMetadata(project, refId(data.defaults.background.material)),
    },
    layout: layoutMetadata(project, refId(data.defaults.layout)),
    characters: [] as Record<string, unknown>[],
    audio: [] as Record<string, unknown>[],
    dialogue: null,
    variables: [] as Record<string, unknown>[],
    scripts: [] as Record<string, unknown>[],
  };
  const characters = new Map<string, Record<string, unknown>>();
  const start = data.preview.playback === 'from-selected' ? selectedIndex : 0;
  const end = Math.max(selectedIndex, start);
  for (let index = start; index <= end && index < data.steps.length; index += 1) {
    const step = data.steps[index]!;
    if (!step.enabled && !data.preview.showDisabledSteps) continue;
    if (step.type === 'background') state.background = activeStepPayloadSummary(project, step);
    else if (step.type === 'layout') state.layout = activeStepPayloadSummary(project, step);
    else if (step.type === 'dialogue') state.dialogue = activeStepPayloadSummary(project, step);
    else if (step.type === 'audio') (state.audio as Record<string, unknown>[]).push(activeStepPayloadSummary(project, step));
    else if (step.type === 'variable') (state.variables as Record<string, unknown>[]).push(activeStepPayloadSummary(project, step));
    else if (step.type === 'script') (state.scripts as Record<string, unknown>[]).push({ id: step.id, label: step.label, comment: step.script.comment });
    else if (step.type === 'character') {
      const id = refId(step.character.character);
      if (id) {
        if (step.character.action === 'hide') characters.delete(id);
        else characters.set(id, activeStepPayloadSummary(project, step));
      }
    }
  }
  state.characters = [...characters.values()];
  return state;
}

function dependencyRevision(project: AuthoringProject, data: SceneData): string[] {
  const dependencies = new Set<string>();
  function add(collection: keyof Pick<AuthoringProject, 'assets' | 'materials' | 'characters' | 'dialogues' | 'layouts' | 'variables' | 'rooms' | 'scenes'>, id: string | null) {
    if (!id) return;
    dependencies.add(`${collection}:${id}:${JSON.stringify(project[collection][id] ?? null)}`);
  }
  add('assets', refId(data.defaults.background.asset));
  add('materials', refId(data.defaults.background.material));
  add('layouts', refId(data.defaults.layout));
  if (data.settings.next) add(data.settings.next.$ref.collection, data.settings.next.$ref.id);
  for (const step of data.steps) {
    add('assets', refId(step.background.asset));
    add('assets', refId(step.audio.asset));
    add('materials', refId(step.background.material));
    add('characters', refId(step.character.character));
    add('dialogues', refId(step.dialogue.dialogue));
    add('layouts', refId(step.layout.layout));
    add('variables', refId(step.variable.variable));
  }
  return [...dependencies].sort();
}

export function scenePreviewRevision(project: AuthoringProject, sceneId: string): string {
  const record = project.scenes[sceneId];
  const data = parseSceneData(record?.data);
  if (!record || !data) return `${sceneId}:missing-or-invalid`;
  return JSON.stringify({ sceneId, label: record.label, data, dependencies: dependencyRevision(project, data) });
}

export function buildScenePreviewDocumentData(project: AuthoringProject, sceneId: string): Record<string, unknown> {
  const record = project.scenes[sceneId];
  const data = parseSceneData(record?.data);
  if (!record || !data) {
    return {
      schema: SCENE_PREVIEW_SCHEMA,
      sceneId,
      label: sceneId,
      diagnostics: [diagnostic(`/scenes/${sceneId}/data`, 'Invalid scene data.')],
    };
  }
  const { step, index } = selectedStep(data);
  const steps = data.steps.map((item, stepIndex) => ({
    id: item.id,
    label: item.label,
    type: item.type,
    enabled: item.enabled,
    selected: stepIndex === index,
    indicators: {
      condition: item.condition.enabled,
      script: item.type === 'script' && !!item.script.source.trim(),
      autosaveBefore: item.autosave.before,
      autosaveAfter: item.autosave.after,
    },
  }));
  return {
    schema: SCENE_PREVIEW_SCHEMA,
    sceneId,
    label: record.label,
    displayName: data.displayName,
    selectedStepId: step?.id ?? null,
    selectedStepIndex: step ? index : -1,
    selectedStep: step ? { ...step, activePayload: activeStepPayloadSummary(project, step) } : null,
    steps,
    state: step ? approximateState(project, data, index) : null,
    settings: data.settings,
    defaults: data.defaults,
    preview: data.preview,
    diagnostics: validateSceneData(project, sceneId, record),
  };
}
