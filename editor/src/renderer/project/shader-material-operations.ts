import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue, type JsonValue } from '@/project/json-value';
import { parseMaterialData, type MaterialData } from '../../shared/project-schema/authoring-materials';
import { parseShaderData, type ShaderData } from '../../shared/project-schema/authoring-shaders';
import { isAuthoringProject, type AuthoringProject } from '../../shared/project-schema/authoring-project';
import type { JsonPatchOperation } from './json-patch';

export interface ShaderMaterialOperationDiagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  path?: string;
}

export interface ShaderMaterialOperationResult {
  patches: JsonPatchOperation[];
  diagnostics?: ShaderMaterialOperationDiagnostic[];
  affectedPaths?: string[];
}

export type ShaderDataPatchPayload = { shaderId: string; data: ShaderData };
export type MaterialDataPatchPayload = { materialId: string; data: MaterialData };
export type MaterialBasePayload = { materialId: string; baseMaterialId: string | null };
export type ShaderCompiledOutputsPayload = {
  outputs: Array<{ shader: string; stage: 'vertex' | 'fragment' | string; variant: string; runtimePath: string }>;
};

function error(message: string, path?: string): ShaderMaterialOperationDiagnostic {
  return { severity: 'error', message, path };
}

function validateProject(document: JsonValue | unknown): AuthoringProject | ShaderMaterialOperationDiagnostic {
  if (isAuthoringProject(document)) return document;
  return error('Current document is not a NovelTea authoring project.');
}

function shaderDataPath(shaderId: string) {
  return buildJsonPointer(['shaders', shaderId, 'data']);
}

function materialDataPath(materialId: string) {
  return buildJsonPointer(['materials', materialId, 'data']);
}

function shaderStageCompiledPath(shaderId: string, stageIndex: number) {
  return buildJsonPointer(['shaders', shaderId, 'data', 'stages', String(stageIndex), 'compiled']);
}

export function replaceShaderDataPatches(document: JsonValue | unknown, payload: ShaderDataPatchPayload): ShaderMaterialOperationResult {
  const project = validateProject(document);
  if (!isAuthoringProject(project)) return { patches: [], diagnostics: [project] };
  if (!project.shaders[payload.shaderId]) return { patches: [], diagnostics: [error('Shader record does not exist.', buildJsonPointer(['shaders', payload.shaderId]))] };
  const parsed = parseShaderData(payload.data);
  if (!parsed) return { patches: [], diagnostics: [error('Shader data is invalid.', shaderDataPath(payload.shaderId))] };
  return { patches: [{ op: 'replace', path: shaderDataPath(payload.shaderId), value: toJsonValue(parsed) }], affectedPaths: [shaderDataPath(payload.shaderId)] };
}

export function replaceMaterialDataPatches(document: JsonValue | unknown, payload: MaterialDataPatchPayload): ShaderMaterialOperationResult {
  const project = validateProject(document);
  if (!isAuthoringProject(project)) return { patches: [], diagnostics: [project] };
  if (!project.materials[payload.materialId]) return { patches: [], diagnostics: [error('Material record does not exist.', buildJsonPointer(['materials', payload.materialId]))] };
  const parsed = parseMaterialData(payload.data);
  if (!parsed) return { patches: [], diagnostics: [error('Material data is invalid.', materialDataPath(payload.materialId))] };
  return { patches: [{ op: 'replace', path: materialDataPath(payload.materialId), value: toJsonValue(parsed) }], affectedPaths: [materialDataPath(payload.materialId)] };
}

export function setMaterialBasePatches(document: JsonValue | unknown, payload: MaterialBasePayload): ShaderMaterialOperationResult {
  const project = validateProject(document);
  if (!isAuthoringProject(project)) return { patches: [], diagnostics: [project] };
  const record = project.materials[payload.materialId];
  if (!record) return { patches: [], diagnostics: [error('Material record does not exist.', buildJsonPointer(['materials', payload.materialId]))] };
  if (payload.baseMaterialId === payload.materialId) return { patches: [], diagnostics: [error('Material cannot inherit from itself.', buildJsonPointer(['materials', payload.materialId, 'data', 'baseMaterialId']))] };
  if (payload.baseMaterialId && !project.materials[payload.baseMaterialId]) return { patches: [], diagnostics: [error('Base material does not exist.', buildJsonPointer(['materials', payload.baseMaterialId]))] };
  const data = parseMaterialData(record.data);
  if (!data) return { patches: [], diagnostics: [error('Material data is invalid.', materialDataPath(payload.materialId))] };
  const path = buildJsonPointer(['materials', payload.materialId, 'data', 'baseMaterialId']);
  return { patches: [{ op: 'replace', path, value: payload.baseMaterialId }], affectedPaths: [path] };
}

export function applyShaderCompiledOutputsPatches(document: JsonValue | unknown, payload: ShaderCompiledOutputsPayload): ShaderMaterialOperationResult {
  const project = validateProject(document);
  if (!isAuthoringProject(project)) return { patches: [], diagnostics: [project] };
  const patches: JsonPatchOperation[] = [];
  const affectedPaths: string[] = [];
  const diagnostics: ShaderMaterialOperationDiagnostic[] = [];
  for (const output of payload.outputs) {
    const shaderRecord = project.shaders[output.shader];
    const shader = parseShaderData(shaderRecord?.data);
    if (!shader) {
      diagnostics.push(error(`Shader '${output.shader}' is missing or invalid.`, buildJsonPointer(['shaders', output.shader, 'data'])));
      continue;
    }
    const stageIndex = shader.stages.findIndex((stage) => stage.stage === output.stage);
    if (stageIndex < 0) {
      diagnostics.push(error(`Shader '${output.shader}' has no '${output.stage}' stage.`, buildJsonPointer(['shaders', output.shader, 'data', 'stages'])));
      continue;
    }
    const stage = shader.stages[stageIndex]!;
    const current = stage.compiled ?? {};
    const next = { ...current, [output.variant]: output.runtimePath };
    const path = shaderStageCompiledPath(output.shader, stageIndex);
    patches.push(Object.prototype.hasOwnProperty.call(stage, 'compiled') ? { op: 'replace', path, value: toJsonValue(next) } : { op: 'add', path, value: toJsonValue(next) });
    affectedPaths.push(path);
  }
  return { patches, diagnostics, affectedPaths };
}
