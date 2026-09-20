import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue } from '@/project/json-value';
import {
  parseMaterialData,
  type MaterialData,
} from '../../shared/project-schema/authoring-materials';
import {
  isAuthoringProject,
  type AuthoringProject,
} from '../../shared/project-schema/authoring-project';
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

export type MaterialDataPatchPayload = { materialId: string; data: MaterialData };

function error(message: string, path?: string): ShaderMaterialOperationDiagnostic {
  return { severity: 'error', message, path };
}

function validateProject(document: unknown): AuthoringProject | ShaderMaterialOperationDiagnostic {
  if (isAuthoringProject(document)) return document;
  return error('Current document is not a NovelTea project.');
}

function materialDataPath(materialId: string) {
  return buildJsonPointer(['materials', materialId, 'data']);
}

export function replaceMaterialDataPatches(
  document: unknown,
  payload: MaterialDataPatchPayload,
): ShaderMaterialOperationResult {
  const project = validateProject(document);
  if (!isAuthoringProject(project)) return { patches: [], diagnostics: [project] };
  if (!project.materials[payload.materialId])
    return {
      patches: [],
      diagnostics: [
        error(
          'Material record does not exist.',
          buildJsonPointer(['materials', payload.materialId]),
        ),
      ],
    };
  const parsed = parseMaterialData(payload.data);
  if (!parsed)
    return {
      patches: [],
      diagnostics: [error('Material data is invalid.', materialDataPath(payload.materialId))],
    };
  return {
    patches: [
      { op: 'replace', path: materialDataPath(payload.materialId), value: toJsonValue(parsed) },
    ],
    affectedPaths: [materialDataPath(payload.materialId)],
  };
}
