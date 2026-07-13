import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue } from '@/project/json-value';
import { parseMapData, validateMapData } from '../../shared/project-schema/authoring-maps';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { JsonValue } from './json-value';

export function replaceMapDataPatches(document: JsonValue | unknown, payload: { mapId: string; data: unknown }) {
  const path = buildJsonPointer(['maps', payload.mapId, 'data']);
  if (!isAuthoringProject(document)) return { patches: [], diagnostics: [{ severity: 'error' as const, message: 'Current document is not a NovelTea authoring project.' }] };
  const record = document.maps[payload.mapId]; const data = parseMapData(payload.data);
  if (!record) return { patches: [], diagnostics: [{ severity: 'error' as const, message: 'Map record does not exist.', path: buildJsonPointer(['maps', payload.mapId]) }] };
  if (!data) return { patches: [], diagnostics: [{ severity: 'error' as const, message: 'Map data is invalid.', path }] };
  const failure = validateMapData(document, payload.mapId, { ...record, data }).find((item) => item.severity === 'error');
  if (failure) return { patches: [], diagnostics: [{ severity: 'error' as const, message: failure.message, path: failure.path }] };
  return { patches: [{ op: 'replace' as const, path, value: toJsonValue(data) }], affectedPaths: [path] };
}
