import { parseSceneData, validateSceneData, type SceneStepData } from './authoring-scenes';
import type { AuthoringProject } from './authoring-project';

export const SCENE_PREVIEW_SCHEMA = 'noveltea.scene-preview.v2' as const;

function refId(ref: { $ref: { id: string } } | null | undefined): string | null { return ref?.$ref.id ?? null; }

function summarizeStep(project: AuthoringProject, step: SceneStepData): Record<string, unknown> {
  switch (step.type) {
    case 'set-background': return { ...step, assetLabel: refId(step.asset) ? project.assets[refId(step.asset)!]?.label ?? null : null };
    case 'actor-cue': return { ...step, characterLabel: project.characters[step.character.$ref.id]?.label ?? null };
    case 'call-dialogue': return { ...step, dialogueLabel: project.dialogues[step.dialogue.$ref.id]?.label ?? null };
    case 'audio-cue': return { ...step, assetLabel: refId(step.asset) ? project.assets[refId(step.asset)!]?.label ?? null : null };
    case 'set-variable': return { ...step, variableLabel: project.variables[step.variable.$ref.id]?.label ?? null };
    case 'set-layout': return { ...step, layoutLabel: refId(step.layout) ? project.layouts[refId(step.layout)!]?.label ?? null : null };
    default: return { ...step };
  }
}

export function scenePreviewRevision(project: AuthoringProject, sceneId: string): string {
  const record = project.scenes[sceneId];
  return JSON.stringify({ sceneId, record, dependencies: record ? Object.keys(project.assets).length + Object.keys(project.characters).length + Object.keys(project.dialogues).length : 0 });
}

export function buildScenePreviewDocumentData(project: AuthoringProject, sceneId: string, selectedStepId?: string | null): Record<string, unknown> {
  const record = project.scenes[sceneId];
  const data = parseSceneData(record?.data);
  if (!record || !data) return { schema: SCENE_PREVIEW_SCHEMA, sceneId, diagnostics: [{ severity: 'error', path: `/scenes/${sceneId}/data`, message: 'Invalid scene data.' }] };
  const selectedIndex = Math.max(0, data.steps.findIndex((step) => step.id === selectedStepId));
  const selected = data.steps[selectedIndex] ?? data.steps[0] ?? null;
  return {
    schema: SCENE_PREVIEW_SCHEMA,
    sceneId,
    label: record.label,
    displayName: data.displayName,
    selectedStepId: selected?.id ?? null,
    selectedStepIndex: selected ? selectedIndex : -1,
    selectedStep: selected ? summarizeStep(project, selected) : null,
    steps: data.steps.map((step, index) => ({ id: step.id, label: step.label, type: step.type, enabled: 'enabled' in step ? step.enabled : true, selected: index === selectedIndex })),
    defaults: { background: data.defaultBackground, layout: data.defaultLayout },
    continuation: data.continuation,
    diagnostics: validateSceneData(project, sceneId, record),
  };
}
