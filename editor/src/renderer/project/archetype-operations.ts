import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue } from '@/project/json-value';
import {
  defaultArchetypeConfiguration,
  deriveArchetypeOverrides,
  gameplayInstanceKindForCollection,
  inheritableConfigurationFromRecord,
  parseArchetypeData,
  resolveArchetypeConfiguration,
  resolveGameplayInstanceRecord,
  type GameplayInstanceKind,
  type InheritableConfiguration,
} from '../../shared/project-schema/authoring-archetypes';
import {
  isAuthoringProject,
  type AuthoringProject,
  type AuthoringRecordBase,
} from '../../shared/project-schema/authoring-project';
import type { AuthoringCollectionKey } from '../../shared/project-schema/authoring-collections';
import type { JsonPatchOperation } from './json-patch';
import type { EntityOperationDiagnostic, EntityOperationResult } from './entity-operations';

export type GameplayInstanceCollection = 'rooms' | 'characters' | 'interactables';

function error(message: string, path?: string): EntityOperationDiagnostic {
  return { severity: 'error', message, path };
}

function instancePath(collection: GameplayInstanceCollection, entityId: string, field?: string) {
  return buildJsonPointer(field ? [collection, entityId, field] : [collection, entityId]);
}

function replaceOrAdd(
  record: AuthoringRecordBase,
  collection: GameplayInstanceCollection,
  entityId: string,
  field: 'archetype' | 'archetypeOverrides' | 'traits' | 'properties' | 'data',
  value: unknown,
): JsonPatchOperation {
  return {
    op: Object.prototype.hasOwnProperty.call(record, field) ? 'replace' : 'add',
    path: instancePath(collection, entityId, field),
    value: toJsonValue(value),
  };
}

function gameplayRecord(
  project: AuthoringProject,
  collection: GameplayInstanceCollection,
  entityId: string,
): { record: AuthoringRecordBase; kind: GameplayInstanceKind } | null {
  const kind = gameplayInstanceKindForCollection(collection);
  const record = project[collection][entityId] as AuthoringRecordBase | undefined;
  return kind && record ? { record, kind } : null;
}

export function setGameplayInstanceArchetypePatches(
  document: unknown,
  payload: {
    collection: GameplayInstanceCollection;
    entityId: string;
    archetypeId: string | null;
  },
): EntityOperationResult {
  if (!isAuthoringProject(document))
    return { patches: [], diagnostics: [error('Current document is not a NovelTea project.')] };
  const target = gameplayRecord(document, payload.collection, payload.entityId);
  if (!target)
    return {
      patches: [],
      diagnostics: [
        error(
          'Gameplay Instance record does not exist.',
          instancePath(payload.collection, payload.entityId),
        ),
      ],
    };

  if (payload.archetypeId) {
    const archetype = document.archetypes[payload.archetypeId];
    const data = parseArchetypeData(archetype?.data);
    if (!archetype)
      return {
        patches: [],
        diagnostics: [error(`Archetype '${payload.archetypeId}' does not exist.`)],
      };
    if (!data || data.instanceKind !== target.kind)
      return {
        patches: [],
        diagnostics: [
          error(`Archetype '${payload.archetypeId}' is not a ${target.kind} Archetype.`),
        ],
      };
    if (!resolveArchetypeConfiguration(document, payload.archetypeId))
      return { patches: [], diagnostics: [error('Archetype configuration cannot be resolved.')] };
    const patches = [
      replaceOrAdd(target.record, payload.collection, payload.entityId, 'archetype', {
        $ref: { collection: 'archetypes', id: payload.archetypeId },
      }),
      replaceOrAdd(target.record, payload.collection, payload.entityId, 'archetypeOverrides', {}),
    ];
    return { patches, affectedPaths: patches.map((patch) => patch.path) };
  }

  if (!target.record.archetype) return { patches: [], affectedPaths: [] };
  const effective = resolveGameplayInstanceRecord(document, target.kind, target.record);
  if (!effective)
    return {
      patches: [],
      diagnostics: [error('Effective Gameplay Instance configuration cannot be resolved.')],
    };
  const patches = [
    replaceOrAdd(
      target.record,
      payload.collection,
      payload.entityId,
      'traits',
      effective.traits ?? [],
    ),
    replaceOrAdd(
      target.record,
      payload.collection,
      payload.entityId,
      'properties',
      effective.properties ?? {},
    ),
    replaceOrAdd(target.record, payload.collection, payload.entityId, 'data', effective.data),
    replaceOrAdd(target.record, payload.collection, payload.entityId, 'archetype', null),
    replaceOrAdd(target.record, payload.collection, payload.entityId, 'archetypeOverrides', {}),
  ];
  return { patches, affectedPaths: patches.map((patch) => patch.path) };
}

export function clearGameplayInstanceArchetypeOverridesPatches(
  document: unknown,
  payload: { collection: GameplayInstanceCollection; entityId: string },
): EntityOperationResult {
  if (!isAuthoringProject(document))
    return { patches: [], diagnostics: [error('Current document is not a NovelTea project.')] };
  const target = gameplayRecord(document, payload.collection, payload.entityId);
  if (!target)
    return { patches: [], diagnostics: [error('Gameplay Instance record does not exist.')] };
  if (!target.record.archetype)
    return {
      patches: [],
      diagnostics: [error('Gameplay Instance is not attached to an Archetype.')],
    };
  const patch = replaceOrAdd(
    target.record,
    payload.collection,
    payload.entityId,
    'archetypeOverrides',
    {},
  );
  return { patches: [patch], affectedPaths: [patch.path] };
}

export function overridesForGameplayInstanceEdit(
  project: AuthoringProject,
  collection: GameplayInstanceCollection,
  entityId: string,
  nextRecord: AuthoringRecordBase,
): Record<string, unknown> | null {
  const target = gameplayRecord(project, collection, entityId);
  if (!target?.record.archetype) return {};
  const base = resolveArchetypeConfiguration(project, target.record.archetype.$ref.id);
  const next = inheritableConfigurationFromRecord(target.kind, nextRecord);
  return base && next ? deriveArchetypeOverrides(base, next) : null;
}

export function replaceArchetypeConfigurationPatches(
  document: unknown,
  payload: { archetypeId: string; configuration: InheritableConfiguration },
): EntityOperationResult {
  if (!isAuthoringProject(document))
    return { patches: [], diagnostics: [error('Current document is not a NovelTea project.')] };
  const record = document.archetypes[payload.archetypeId];
  const data = parseArchetypeData(record?.data);
  if (!record || !data)
    return { patches: [], diagnostics: [error('Archetype record does not exist or is invalid.')] };
  const base = data.base
    ? resolveArchetypeConfiguration(document, data.base.$ref.id)
    : defaultArchetypeConfiguration(data.instanceKind);
  if (!base) return { patches: [], diagnostics: [error('Base Archetype cannot be resolved.')] };
  const overrides = deriveArchetypeOverrides(base, payload.configuration);
  const candidateProject = {
    ...document,
    archetypes: {
      ...document.archetypes,
      [payload.archetypeId]: { ...record, data: { ...data, overrides } },
    },
  } as AuthoringProject;
  if (!resolveArchetypeConfiguration(candidateProject, payload.archetypeId))
    return {
      patches: [],
      diagnostics: [error('Archetype configuration is invalid for its gameplay-instance kind.')],
    };
  const patch: JsonPatchOperation = {
    op: 'replace',
    path: buildJsonPointer(['archetypes', payload.archetypeId, 'data', 'overrides']),
    value: toJsonValue(overrides),
  };
  return { patches: [patch], affectedPaths: [patch.path] };
}

export function setArchetypeBasePatches(
  document: unknown,
  payload: { archetypeId: string; baseArchetypeId: string | null },
): EntityOperationResult {
  if (!isAuthoringProject(document))
    return { patches: [], diagnostics: [error('Current document is not a NovelTea project.')] };
  const record = document.archetypes[payload.archetypeId];
  const data = parseArchetypeData(record?.data);
  if (!record || !data)
    return { patches: [], diagnostics: [error('Archetype record does not exist or is invalid.')] };
  if (payload.baseArchetypeId === payload.archetypeId)
    return { patches: [], diagnostics: [error('Archetype cannot use itself as a base.')] };
  if (payload.baseArchetypeId) {
    const baseRecord = document.archetypes[payload.baseArchetypeId];
    const baseData = parseArchetypeData(baseRecord?.data);
    if (!baseRecord) return { patches: [], diagnostics: [error('Base Archetype does not exist.')] };
    if (!baseData || baseData.instanceKind !== data.instanceKind)
      return {
        patches: [],
        diagnostics: [error('Base Archetype must have the same gameplay-instance kind.')],
      };
    let current = payload.baseArchetypeId;
    const seen = new Set<string>([payload.archetypeId]);
    while (current) {
      if (seen.has(current))
        return {
          patches: [],
          diagnostics: [error('Base assignment would create an Archetype cycle.')],
        };
      seen.add(current);
      const currentData = parseArchetypeData(document.archetypes[current]?.data);
      current = currentData?.base?.$ref.id ?? '';
    }
  }
  const basePatch: JsonPatchOperation = {
    op: 'replace',
    path: buildJsonPointer(['archetypes', payload.archetypeId, 'data', 'base']),
    value: payload.baseArchetypeId
      ? toJsonValue({ $ref: { collection: 'archetypes', id: payload.baseArchetypeId } })
      : null,
  };
  const overridesPatch: JsonPatchOperation = {
    op: 'replace',
    path: buildJsonPointer(['archetypes', payload.archetypeId, 'data', 'overrides']),
    value: {},
  };
  return {
    patches: [basePatch, overridesPatch],
    affectedPaths: [basePatch.path, overridesPatch.path],
  };
}

export function setArchetypeKindPatches(
  document: unknown,
  payload: { archetypeId: string; instanceKind: GameplayInstanceKind },
): EntityOperationResult {
  if (!isAuthoringProject(document))
    return { patches: [], diagnostics: [error('Current document is not a NovelTea project.')] };
  const record = document.archetypes[payload.archetypeId];
  const data = parseArchetypeData(record?.data);
  if (!record || !data)
    return { patches: [], diagnostics: [error('Archetype record does not exist or is invalid.')] };
  const referenced = (['rooms', 'characters', 'interactables'] as const).some((collection) =>
    Object.values(document[collection]).some(
      (instance) => instance.archetype?.$ref.id === payload.archetypeId,
    ),
  );
  const inherited = Object.values(document.archetypes).some(
    (candidate) => parseArchetypeData(candidate.data)?.base?.$ref.id === payload.archetypeId,
  );
  if ((referenced || inherited) && payload.instanceKind !== data.instanceKind)
    return {
      patches: [],
      diagnostics: [error('Archetype kind cannot change while the Archetype is referenced.')],
    };
  const patches: JsonPatchOperation[] = [
    {
      op: 'replace',
      path: buildJsonPointer(['archetypes', payload.archetypeId, 'data', 'instanceKind']),
      value: payload.instanceKind,
    },
    {
      op: 'replace',
      path: buildJsonPointer(['archetypes', payload.archetypeId, 'data', 'base']),
      value: null,
    },
    {
      op: 'replace',
      path: buildJsonPointer(['archetypes', payload.archetypeId, 'data', 'overrides']),
      value: {},
    },
  ];
  return { patches, affectedPaths: patches.map((patch) => patch.path) };
}

export function isGameplayInstanceCollection(
  collection: AuthoringCollectionKey,
): collection is GameplayInstanceCollection {
  return collection === 'rooms' || collection === 'characters' || collection === 'interactables';
}
