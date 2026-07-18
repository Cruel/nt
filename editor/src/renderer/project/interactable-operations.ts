import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue, type JsonValue } from '@/project/json-value';
import { parseInteractableData, validateInteractableData, type InteractableData } from '../../shared/project-schema/authoring-interactables';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { JsonPatchOperation } from './json-patch';
import type { EntityOperationDiagnostic, EntityOperationResult } from './entity-operations';

export function replaceInteractableDataPatches(document: JsonValue | unknown, payload: { interactableId: string; data: InteractableData | unknown }): EntityOperationResult {
  if (!isAuthoringProject(document)) return { patches: [], diagnostics: [{ severity: 'error', message: 'Current document is not a NovelTea project.' }] };
  const record = document.interactables[payload.interactableId];
  if (!record) return { patches: [], diagnostics: [{ severity: 'error', message: 'Interactable record does not exist.' }] };
  const data = parseInteractableData(payload.data);
  if (!data) return { patches: [], diagnostics: [{ severity: 'error', message: 'Interactable data is invalid.' }] };
  const issue = validateInteractableData(document, payload.interactableId, { ...record, data }).find((diagnostic) => diagnostic.severity === 'error');
  if (issue) return { patches: [], diagnostics: [issue as EntityOperationDiagnostic] };
  const patch: JsonPatchOperation = { op: 'replace', path: buildJsonPointer(['interactables', payload.interactableId, 'data']), value: toJsonValue(data) };
  return { patches: [patch], affectedPaths: [patch.path] };
}
