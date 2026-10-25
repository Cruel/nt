import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue } from '@/project/json-value';
import { parseLayoutData } from '../../shared/project-schema/authoring-layouts';
import { isAuthoringProjectView } from '../../shared/project-schema/authoring-project-view';
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

function validateLayoutTarget(
  document: unknown,
  layoutId: string,
): EntityOperationDiagnostic | null {
  if (!isAuthoringProjectView(document))
    return error('Current document is not a NovelTea project.');
  if (!document.layouts[layoutId])
    return error('Layout record does not exist.', pathForLayout(layoutId));
  return null;
}

export function replaceLayoutDataPatches(
  document: unknown,
  payload: ReplaceLayoutDataPayload,
): EntityOperationResult {
  const targetError = validateLayoutTarget(document, payload.layoutId);
  if (targetError) return { patches: [], diagnostics: [targetError] };
  if (!isAuthoringProjectView(document))
    return { patches: [], diagnostics: [error('Current document is not a NovelTea project.')] };
  const data = parseLayoutData(payload.data);
  if (!data)
    return {
      patches: [],
      diagnostics: [error('Layout data is invalid.', pathForLayoutData(payload.layoutId))],
    };
  return {
    patches: [
      { op: 'replace', path: pathForLayoutData(payload.layoutId), value: toJsonValue(data) },
    ],
    affectedPaths: [pathForLayoutData(payload.layoutId)],
  };
}
