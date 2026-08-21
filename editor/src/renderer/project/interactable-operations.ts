import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue } from '@/project/json-value';
import {
  parseInteractableData,
  validateInteractableData,
} from '../../shared/project-schema/authoring-interactables';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { JsonPatchOperation } from './json-patch';
import { overridesForGameplayInstanceEdit } from './archetype-operations';
import type { EntityOperationDiagnostic, EntityOperationResult } from './entity-operations';

export function replaceInteractableDataPatches(
  document: unknown,
  payload: { interactableId: string; data: unknown },
): EntityOperationResult {
  if (!isAuthoringProject(document))
    return {
      patches: [],
      diagnostics: [{ severity: 'error', message: 'Current document is not a NovelTea project.' }],
    };
  const record = document.interactables[payload.interactableId];
  if (!record)
    return {
      patches: [],
      diagnostics: [{ severity: 'error', message: 'Interactable record does not exist.' }],
    };
  const data = parseInteractableData(payload.data);
  if (!data)
    return {
      patches: [],
      diagnostics: [{ severity: 'error', message: 'Interactable data is invalid.' }],
    };
  const issue = validateInteractableData(document, payload.interactableId, {
    ...record,
    data,
  }).find((diagnostic) => diagnostic.severity === 'error');
  if (issue) return { patches: [], diagnostics: [issue as EntityOperationDiagnostic] };
  const overrides = overridesForGameplayInstanceEdit(
    document,
    'interactables',
    payload.interactableId,
    { ...record, data },
  );
  if (overrides === null)
    return {
      patches: [],
      diagnostics: [
        { severity: 'error', message: 'Interactable Archetype configuration cannot be resolved.' },
      ],
    };
  const patches: JsonPatchOperation[] = [
    {
      op: 'replace',
      path: buildJsonPointer(['interactables', payload.interactableId, 'data']),
      value: toJsonValue(data),
    },
  ];
  if (record.archetype)
    patches.push({
      op: Object.prototype.hasOwnProperty.call(record, 'archetypeOverrides') ? 'replace' : 'add',
      path: buildJsonPointer(['interactables', payload.interactableId, 'archetypeOverrides']),
      value: toJsonValue(overrides),
    });
  return { patches, affectedPaths: patches.map((patch) => patch.path) };
}
