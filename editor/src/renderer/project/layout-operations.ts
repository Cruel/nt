import { buildJsonPointer, hasJsonAtPointer } from '@/project/json-pointer';
import { toJsonValue, type JsonValue } from '@/project/json-value';
import { defaultLayoutRef, parseLayoutData, validateLayoutData } from '../../shared/project-schema/authoring-layouts';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { JsonPatchOperation } from './json-patch';
import type { EntityOperationDiagnostic, EntityOperationResult } from './entity-operations';

export interface ReplaceLayoutDataPayload {
  layoutId: string;
  data: unknown;
}

export interface SetDefaultLayoutPayload {
  layoutId: string | null;
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

export function setDefaultLayoutPatches(
  document: JsonValue | unknown,
  payload: SetDefaultLayoutPayload,
): EntityOperationResult {
  if (!isAuthoringProject(document)) return { patches: [], diagnostics: [error('Current document is not a NovelTea authoring project.')] };
  const patches: JsonPatchOperation[] = [];

  if (payload.layoutId !== null && !document.layouts[payload.layoutId]) {
    return { patches: [], diagnostics: [error('Default layout record does not exist.', pathForLayout(payload.layoutId))] };
  }

  const documentValue = toJsonValue(document);
  if (!hasJsonAtPointer(documentValue, '/settings/ui')) {
    patches.push({ op: 'add', path: '/settings/ui', value: {} });
  }

  const path = '/settings/ui/defaultLayout';
  const exists = hasJsonAtPointer(documentValue, path);
  const value = payload.layoutId === null ? null : toJsonValue(defaultLayoutRef(payload.layoutId));
  patches.push({ op: exists ? 'replace' : 'add', path, value });

  return { patches, affectedPaths: ['/settings/ui/defaultLayout'] };
}
