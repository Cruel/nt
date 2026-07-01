import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue, type JsonValue } from '@/project/json-value';
import { parseSceneData, validateSceneData, type SceneData } from '../../shared/project-schema/authoring-scenes';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { JsonPatchOperation } from './json-patch';
import type { EntityOperationDiagnostic, EntityOperationResult } from './entity-operations';

export interface ReplaceSceneDataPayload {
  sceneId: string;
  data: SceneData | unknown;
}

function error(message: string, path?: string): EntityOperationDiagnostic {
  return { severity: 'error', message, path };
}

function pathForScene(sceneId: string) {
  return buildJsonPointer(['scenes', sceneId]);
}

function pathForSceneData(sceneId: string) {
  return buildJsonPointer(['scenes', sceneId, 'data']);
}

export function replaceSceneDataPatches(
  document: JsonValue | unknown,
  payload: ReplaceSceneDataPayload,
): EntityOperationResult {
  if (!isAuthoringProject(document)) return { patches: [], diagnostics: [error('Current document is not a NovelTea authoring project.')] };
  const record = document.scenes[payload.sceneId];
  if (!record) return { patches: [], diagnostics: [error('Scene record does not exist.', pathForScene(payload.sceneId))] };
  const data = parseSceneData(payload.data);
  if (!data) return { patches: [], diagnostics: [error('Scene data is invalid.', pathForSceneData(payload.sceneId))] };
  const diagnostics = validateSceneData(document, payload.sceneId, { ...record, data });
  const failure = diagnostics.find((item) => item.severity === 'error');
  if (failure) return { patches: [], diagnostics: [error(failure.message, failure.path)] };
  const patch: JsonPatchOperation = { op: 'replace', path: pathForSceneData(payload.sceneId), value: toJsonValue(data) };
  return { patches: [patch], affectedPaths: [patch.path] };
}
