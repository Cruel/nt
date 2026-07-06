import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue, type JsonValue } from '@/project/json-value';
import { parseLayoutData, validateLayoutData } from '../../shared/project-schema/authoring-layouts';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { EntityOperationDiagnostic, EntityOperationResult } from './entity-operations';

export interface ReplaceLayoutDataPayload {
  layoutId: string;
  data: unknown;
}


function error(message: string, path?: string): EntityOperationDiagnostic {
  return { severity: 'error', message, path };
}

function pathForLayout(layoutId: string) {
  return buildJsonPointer(['layouts', layoutId]);
}

function pathForLayoutData(layoutId: string) {
  return buildJsonPointer(['layouts', layoutId, 'data']);
}

function validateLayoutTarget(document: JsonValue | unknown, layoutId: string): EntityOperationDiagnostic | null {
  if (!isAuthoringProject(document)) return error('Current document is not a NovelTea authoring project.');
  if (!document.layouts[layoutId]) return error('Layout record does not exist.', pathForLayout(layoutId));
  return null;
}

export function replaceLayoutDataPatches(
  document: JsonValue | unknown,
  payload: ReplaceLayoutDataPayload,
): EntityOperationResult {
  const targetError = validateLayoutTarget(document, payload.layoutId);
  if (targetError) return { patches: [], diagnostics: [targetError] };
  if (!isAuthoringProject(document)) return { patches: [], diagnostics: [error('Current document is not a NovelTea authoring project.')] };
  const data = parseLayoutData(payload.data);
  if (!data) return { patches: [], diagnostics: [error('Layout data is invalid.', pathForLayoutData(payload.layoutId))] };
  const diagnostics = validateLayoutData(document, payload.layoutId, { ...document.layouts[payload.layoutId], data });
  const failure = diagnostics.find((item) => item.severity === 'error');
  if (failure) return { patches: [], diagnostics: [error(failure.message, failure.path)] };
  return {
    patches: [{ op: 'replace', path: pathForLayoutData(payload.layoutId), value: toJsonValue(data) }],
    affectedPaths: [pathForLayoutData(payload.layoutId)],
  };
}
