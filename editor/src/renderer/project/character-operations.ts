import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue } from '@/project/json-value';
import { parseCharacterData } from '../../shared/project-schema/authoring-characters';
import { isAuthoringProjectView } from '../../shared/project-schema/authoring-project-view';
import { overridesForGameplayInstanceEdit } from './archetype-operations';
import type { EntityOperationDiagnostic, EntityOperationResult } from './entity-operations';
import type { JsonPatchOperation } from './json-patch';

export interface ReplaceCharacterDataPayload {
  characterId: string;
  data: unknown;
}

function error(message: string, path?: string): EntityOperationDiagnostic {
  return { severity: 'error', message, path };
}

function pathForCharacter(characterId: string) {
  return buildJsonPointer(['characters', characterId]);
}

function pathForCharacterData(characterId: string) {
  return buildJsonPointer(['characters', characterId, 'data']);
}

export function replaceCharacterDataPatches(
  document: unknown,
  payload: ReplaceCharacterDataPayload,
): EntityOperationResult {
  if (!isAuthoringProjectView(document))
    return { patches: [], diagnostics: [error('Current document is not a NovelTea project.')] };
  const record = document.characters[payload.characterId];
  if (!record)
    return {
      patches: [],
      diagnostics: [
        error('Character record does not exist.', pathForCharacter(payload.characterId)),
      ],
    };
  const data = parseCharacterData(payload.data);
  if (!data)
    return {
      patches: [],
      diagnostics: [error('Character data is invalid.', pathForCharacterData(payload.characterId))],
    };
  const overrides = overridesForGameplayInstanceEdit(document, 'characters', payload.characterId, {
    ...record,
    data,
  });
  if (overrides === null)
    return {
      patches: [],
      diagnostics: [error('Character Archetype configuration cannot be resolved.')],
    };
  const patches: JsonPatchOperation[] = [
    {
      op: 'replace',
      path: pathForCharacterData(payload.characterId),
      value: toJsonValue(data),
    },
  ];
  if (record.archetype)
    patches.push({
      op: Object.prototype.hasOwnProperty.call(record, 'archetypeOverrides') ? 'replace' : 'add',
      path: buildJsonPointer(['characters', payload.characterId, 'archetypeOverrides']),
      value: toJsonValue(overrides),
    });
  return { patches, affectedPaths: patches.map((patch) => patch.path) };
}
