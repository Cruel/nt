import { buildJsonPointer } from '@/project/json-pointer';
import { cloneJsonValue, toJsonValue, type JsonValue } from '@/project/json-value';
import {
  authoringCollectionMetadata,
  isAuthoringCollectionKey,
  type AuthoringCollectionKey,
} from '../../shared/project-schema/authoring-collections';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultShaderData } from '../../shared/project-schema/authoring-shaders';
import { defaultVariableData } from '../../shared/project-schema/authoring-variables';
import {
  entityIdPattern,
  isAuthoringProject,
  type AuthoringProject,
  type AuthoringRecordBase,
  type ReferenceTarget,
} from '../../shared/project-schema/authoring-project';
import {
  buildReferenceIndex,
  findUsages,
  type ReferenceUsage,
} from '../../shared/project-schema/authoring-references';
import type { JsonPatchOperation } from './json-patch';

export interface EntityTarget {
  collection: AuthoringCollectionKey;
  entityId: string;
}

export interface CreateEntityRecordPayload extends EntityTarget {
  label?: string;
  description?: string;
  parent?: ReferenceTarget | null;
  tags?: string[];
  color?: string | null;
  data?: unknown;
}

export interface RenameEntityIdPayload {
  collection: AuthoringCollectionKey;
  fromId: string;
  toId: string;
  label?: string;
}

export interface DuplicateEntityRecordPayload {
  collection: AuthoringCollectionKey;
  sourceId: string;
  targetId: string;
  label?: string;
}

export interface DeleteEntityRecordPayload extends EntityTarget {
  force?: boolean;
}

export interface UpdateEntityMetadataPayload extends EntityTarget {
  label?: string;
  description?: string;
  tags?: string[];
  color?: string | null;
  sortKey?: string | null;
}

export interface SetEntityParentPayload extends EntityTarget {
  parentId: string | null;
}

export interface SetEntityInheritsPayload extends EntityTarget {
  inheritsId: string | null;
}

export interface EntityOperationDiagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  path?: string;
}

export interface EntityOperationResult {
  patches: JsonPatchOperation[];
  diagnostics?: EntityOperationDiagnostic[];
  affectedPaths?: string[];
}

export interface DeleteEntityRecordPreflight {
  target: ReferenceTarget;
  usages: ReferenceUsage[];
  canDeleteWithoutForce: boolean;
}

function error(message: string, path?: string): EntityOperationDiagnostic {
  return { severity: 'error', message, path };
}

function pathForRecord(collection: AuthoringCollectionKey, entityId: string): string {
  return buildJsonPointer([collection, entityId]);
}

function pathForRecordField(collection: AuthoringCollectionKey, entityId: string, field: string): string {
  return buildJsonPointer([collection, entityId, field]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKnownCollection(value: string): value is AuthoringCollectionKey {
  return isAuthoringCollectionKey(value);
}

function entityIdDiagnostic(entityId: string, path?: string): EntityOperationDiagnostic | null {
  if (entityIdPattern.test(entityId)) return null;
  return error(
    'ID must be lowercase kebab-case, start with a letter, and contain only letters, numbers, and hyphens.',
    path,
  );
}

function validateTargetCollection(collection: string): EntityOperationDiagnostic | null {
  if (isKnownCollection(collection)) return null;
  return error(`Unknown authoring collection '${collection}'.`);
}

function validateProject(document: JsonValue | unknown): AuthoringProject | EntityOperationDiagnostic {
  if (isAuthoringProject(document)) return document;
  return error('Current document is not a NovelTea authoring project.');
}

function referenceEquals(left: ReferenceTarget | null | undefined, right: ReferenceTarget): boolean {
  return !!left && left.collection === right.collection && left.id === right.id;
}

function cloneRecord(record: AuthoringRecordBase): AuthoringRecordBase {
  return cloneJsonValue(record as unknown as JsonValue) as unknown as AuthoringRecordBase;
}

export function defaultDataForCollection(
  collection: AuthoringCollectionKey,
  label: string,
  explicitData: unknown,
): Record<string, unknown> {
  if (isRecord(explicitData)) return explicitData;
  if (collection === 'variables') return defaultVariableData() as unknown as Record<string, unknown>;
  if (collection === 'shaders') return defaultShaderData(label) as unknown as Record<string, unknown>;
  if (collection === 'materials') return defaultMaterialData(label) as unknown as Record<string, unknown>;
  if (collection === 'layouts') return defaultLayoutData(label) as unknown as Record<string, unknown>;
  if (collection === 'characters') return defaultCharacterData(label) as unknown as Record<string, unknown>;
  if (collection === 'rooms') return defaultRoomData(label) as unknown as Record<string, unknown>;
  return {};
}

export function createDefaultAuthoringRecord(
  collection: AuthoringCollectionKey,
  entityId: string,
  options: Omit<CreateEntityRecordPayload, 'collection' | 'entityId'> = {},
): AuthoringRecordBase {
  const metadata = authoringCollectionMetadata[collection];
  const label = options.label?.trim() || `${metadata.singularLabel} ${entityId}`;
  const record: AuthoringRecordBase = {
    id: entityId,
    label,
    tags: options.tags ?? [],
    data: defaultDataForCollection(collection, label, options.data),
  };
  if (options.description?.trim()) record.description = options.description;
  if (options.parent !== undefined) record.parent = options.parent;
  if (options.color !== undefined) record.color = options.color;
  return record;
}

export function createEntityRecordPatches(
  document: JsonValue | unknown,
  payload: CreateEntityRecordPayload,
): EntityOperationResult {
  const project = validateProject(document);
  if (!isAuthoringProject(project)) return { patches: [], diagnostics: [project] };
  const diagnostics = [
    validateTargetCollection(payload.collection),
    entityIdDiagnostic(payload.entityId, pathForRecord(payload.collection, payload.entityId)),
  ].filter((item): item is EntityOperationDiagnostic => item !== null);
  if (diagnostics.length > 0) return { patches: [], diagnostics };
  if (project[payload.collection][payload.entityId]) {
    return {
      patches: [],
      diagnostics: [error('A record with this ID already exists.', pathForRecord(payload.collection, payload.entityId))],
    };
  }
  if (payload.parent) {
    if (payload.parent.collection !== payload.collection) {
      return { patches: [], diagnostics: [error('Parent must be in the same collection.', '/parent')] };
    }
    if (!project[payload.collection][payload.parent.id]) {
      return { patches: [], diagnostics: [error('Parent record does not exist.', '/parent')] };
    }
  }
  const path = pathForRecord(payload.collection, payload.entityId);
  return {
    patches: [{ op: 'add', path, value: toJsonValue(createDefaultAuthoringRecord(payload.collection, payload.entityId, payload)) }],
    affectedPaths: [path],
  };
}

export function rewriteReferenceTarget(value: unknown, from: ReferenceTarget, to: ReferenceTarget): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteReferenceTarget(item, from, to));
  }
  if (!isRecord(value)) return value;

  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref' && referenceEquals(child as ReferenceTarget, from)) {
      next[key] = { ...to };
    } else if (key === '$var' && from.collection === 'variables' && child === from.id) {
      next[key] = to.id;
    } else if ((key === 'parent' || key === 'inherits') && referenceEquals(child as ReferenceTarget, from)) {
      next[key] = { ...to };
    } else {
      next[key] = rewriteReferenceTarget(child, from, to);
    }
  }
  return next;
}

function rewriteRecordReferences(record: AuthoringRecordBase, from: ReferenceTarget, to: ReferenceTarget): AuthoringRecordBase {
  const next = cloneRecord(record);
  if (referenceEquals(next.parent, from)) next.parent = { ...to };
  if (referenceEquals(next.inherits, from)) next.inherits = { ...to };
  next.data = rewriteReferenceTarget(next.data, from, to) as Record<string, unknown>;
  return next;
}

function recordFieldPatch(
  record: AuthoringRecordBase,
  collection: AuthoringCollectionKey,
  entityId: string,
  field: keyof AuthoringRecordBase,
  value: unknown,
): JsonPatchOperation {
  const path = pathForRecordField(collection, entityId, String(field));
  return Object.prototype.hasOwnProperty.call(record, field)
    ? { op: 'replace', path, value: toJsonValue(value) }
    : { op: 'add', path, value: toJsonValue(value) };
}

export function renameEntityIdPatches(
  document: JsonValue | unknown,
  payload: RenameEntityIdPayload,
): EntityOperationResult {
  const project = validateProject(document);
  if (!isAuthoringProject(project)) return { patches: [], diagnostics: [project] };
  const diagnostics = [
    validateTargetCollection(payload.collection),
    entityIdDiagnostic(payload.fromId, pathForRecord(payload.collection, payload.fromId)),
    entityIdDiagnostic(payload.toId, pathForRecord(payload.collection, payload.toId)),
  ].filter((item): item is EntityOperationDiagnostic => item !== null);
  if (diagnostics.length > 0) return { patches: [], diagnostics };
  if (payload.fromId === payload.toId) {
    return { patches: [], diagnostics: [error('New ID must be different from the current ID.')] };
  }
  const source = project[payload.collection][payload.fromId];
  if (!source) {
    return { patches: [], diagnostics: [error('Source record does not exist.', pathForRecord(payload.collection, payload.fromId))] };
  }
  if (project[payload.collection][payload.toId]) {
    return { patches: [], diagnostics: [error('Target ID already exists.', pathForRecord(payload.collection, payload.toId))] };
  }

  const from = { collection: payload.collection, id: payload.fromId };
  const to = { collection: payload.collection, id: payload.toId };
  const renamedRecord = rewriteRecordReferences({ ...source, id: payload.toId, label: payload.label ?? source.label }, from, to);
  const patches: JsonPatchOperation[] = [
    { op: 'add', path: pathForRecord(payload.collection, payload.toId), value: toJsonValue(renamedRecord) },
    { op: 'remove', path: pathForRecord(payload.collection, payload.fromId) },
  ];
  const affectedPaths = [pathForRecord(payload.collection, payload.toId), pathForRecord(payload.collection, payload.fromId)];
  const index = buildReferenceIndex(project);
  for (const usage of findUsages(index, from)) {
    if (usage.sourceCollection === payload.collection && usage.sourceId === payload.fromId) continue;
    patches.push({ op: 'replace', path: usage.path, value: toJsonValue(usage.kind === 'variable-ref' ? to.id : to) });
    affectedPaths.push(usage.path);
  }
  return { patches, affectedPaths };
}

export function duplicateEntityRecordPatches(
  document: JsonValue | unknown,
  payload: DuplicateEntityRecordPayload,
): EntityOperationResult {
  const project = validateProject(document);
  if (!isAuthoringProject(project)) return { patches: [], diagnostics: [project] };
  const diagnostics = [
    validateTargetCollection(payload.collection),
    entityIdDiagnostic(payload.sourceId, pathForRecord(payload.collection, payload.sourceId)),
    entityIdDiagnostic(payload.targetId, pathForRecord(payload.collection, payload.targetId)),
  ].filter((item): item is EntityOperationDiagnostic => item !== null);
  if (diagnostics.length > 0) return { patches: [], diagnostics };
  const source = project[payload.collection][payload.sourceId];
  if (!source) {
    return { patches: [], diagnostics: [error('Source record does not exist.', pathForRecord(payload.collection, payload.sourceId))] };
  }
  if (project[payload.collection][payload.targetId]) {
    return { patches: [], diagnostics: [error('Target ID already exists.', pathForRecord(payload.collection, payload.targetId))] };
  }
  const duplicate = cloneRecord(source);
  duplicate.id = payload.targetId;
  duplicate.label = payload.label?.trim() || `${source.label} Copy`;
  const path = pathForRecord(payload.collection, payload.targetId);
  return { patches: [{ op: 'add', path, value: toJsonValue(duplicate) }], affectedPaths: [path] };
}

export function deleteEntityRecordPreflight(
  project: AuthoringProject,
  target: ReferenceTarget,
): DeleteEntityRecordPreflight {
  const index = buildReferenceIndex(project);
  const usages = findUsages(index, target).filter(
    (usage) => !(usage.sourceCollection === target.collection && usage.sourceId === target.id),
  );
  return { target, usages, canDeleteWithoutForce: usages.length === 0 };
}

export function deleteEntityRecordPatches(
  document: JsonValue | unknown,
  payload: DeleteEntityRecordPayload,
): EntityOperationResult {
  const project = validateProject(document);
  if (!isAuthoringProject(project)) return { patches: [], diagnostics: [project] };
  const diagnostics = [
    validateTargetCollection(payload.collection),
    entityIdDiagnostic(payload.entityId, pathForRecord(payload.collection, payload.entityId)),
  ].filter((item): item is EntityOperationDiagnostic => item !== null);
  if (diagnostics.length > 0) return { patches: [], diagnostics };
  if (!project[payload.collection][payload.entityId]) {
    return { patches: [], diagnostics: [error('Entity record does not exist.', pathForRecord(payload.collection, payload.entityId))] };
  }
  const target = { collection: payload.collection, id: payload.entityId };
  const preflight = deleteEntityRecordPreflight(project, target);
  if (!payload.force && preflight.usages.length > 0) {
    return {
      patches: [],
      diagnostics: [
        error(`Record is referenced by ${preflight.usages.length} usage${preflight.usages.length === 1 ? '' : 's'}.`, pathForRecord(payload.collection, payload.entityId)),
      ],
    };
  }
  const path = pathForRecord(payload.collection, payload.entityId);
  return { patches: [{ op: 'remove', path }], affectedPaths: [path] };
}

export function updateEntityMetadataPatches(
  document: JsonValue | unknown,
  payload: UpdateEntityMetadataPayload,
): EntityOperationResult {
  const project = validateProject(document);
  if (!isAuthoringProject(project)) return { patches: [], diagnostics: [project] };
  const diagnostics = [
    validateTargetCollection(payload.collection),
    entityIdDiagnostic(payload.entityId, pathForRecord(payload.collection, payload.entityId)),
  ].filter((item): item is EntityOperationDiagnostic => item !== null);
  if (diagnostics.length > 0) return { patches: [], diagnostics };
  const record = project[payload.collection][payload.entityId];
  if (!record) {
    return { patches: [], diagnostics: [error('Entity record does not exist.', pathForRecord(payload.collection, payload.entityId))] };
  }
  const patches: JsonPatchOperation[] = [];
  const affectedPaths: string[] = [];
  const entries: Array<[keyof AuthoringRecordBase, unknown]> = [
    ['label', payload.label],
    ['description', payload.description],
    ['tags', payload.tags],
    ['color', payload.color],
    ['sortKey', payload.sortKey],
  ];
  for (const [field, value] of entries) {
    if (value === undefined) continue;
    const patch = recordFieldPatch(record, payload.collection, payload.entityId, field, value);
    patches.push(patch);
    affectedPaths.push(patch.path);
  }
  return { patches, affectedPaths };
}

export function wouldCreateParentCycle(
  project: AuthoringProject,
  source: EntityTarget,
  parentId: string | null,
): boolean {
  if (!parentId) return false;
  let current: string | null = parentId;
  const seen = new Set<string>();
  while (current) {
    if (current === source.entityId) return true;
    if (seen.has(current)) return true;
    seen.add(current);
    const parent: ReferenceTarget | null | undefined = project[source.collection][current]?.parent;
    current = parent?.collection === source.collection ? parent.id : null;
  }
  return false;
}

export function setEntityRelationshipPatches(
  document: JsonValue | unknown,
  payload: EntityTarget & { field: 'parent' | 'inherits'; targetId: string | null },
): EntityOperationResult {
  const project = validateProject(document);
  if (!isAuthoringProject(project)) return { patches: [], diagnostics: [project] };
  const diagnostics = [
    validateTargetCollection(payload.collection),
    entityIdDiagnostic(payload.entityId, pathForRecord(payload.collection, payload.entityId)),
    payload.targetId ? entityIdDiagnostic(payload.targetId, pathForRecord(payload.collection, payload.targetId)) : null,
  ].filter((item): item is EntityOperationDiagnostic => item !== null);
  if (diagnostics.length > 0) return { patches: [], diagnostics };
  const record = project[payload.collection][payload.entityId];
  if (!record) {
    return { patches: [], diagnostics: [error('Entity record does not exist.', pathForRecord(payload.collection, payload.entityId))] };
  }
  if (payload.targetId) {
    if (payload.targetId === payload.entityId) {
      return { patches: [], diagnostics: [error(`Record cannot ${payload.field} itself.`, pathForRecordField(payload.collection, payload.entityId, payload.field))] };
    }
    if (!project[payload.collection][payload.targetId]) {
      return { patches: [], diagnostics: [error(`${payload.field === 'parent' ? 'Parent' : 'Inherited'} record does not exist.`, pathForRecord(payload.collection, payload.targetId))] };
    }
    if (payload.field === 'parent' && wouldCreateParentCycle(project, payload, payload.targetId)) {
      return { patches: [], diagnostics: [error('Parent assignment would create a cycle.', pathForRecordField(payload.collection, payload.entityId, 'parent'))] };
    }
  }
  const patch = recordFieldPatch(
    record,
    payload.collection,
    payload.entityId,
    payload.field,
    payload.targetId ? { collection: payload.collection, id: payload.targetId } : null,
  );
  return { patches: [patch], affectedPaths: [patch.path] };
}

export function setEntityInheritsPatches(
  document: JsonValue | unknown,
  payload: SetEntityInheritsPayload,
): EntityOperationResult {
  return setEntityRelationshipPatches(document, { ...payload, field: 'inherits', targetId: payload.inheritsId });
}

export function setEntityParentPatches(
  document: JsonValue | unknown,
  payload: SetEntityParentPayload,
): EntityOperationResult {
  const project = validateProject(document);
  if (!isAuthoringProject(project)) return { patches: [], diagnostics: [project] };
  const diagnostics = [
    validateTargetCollection(payload.collection),
    entityIdDiagnostic(payload.entityId, pathForRecord(payload.collection, payload.entityId)),
    payload.parentId ? entityIdDiagnostic(payload.parentId, pathForRecord(payload.collection, payload.parentId)) : null,
  ].filter((item): item is EntityOperationDiagnostic => item !== null);
  if (diagnostics.length > 0) return { patches: [], diagnostics };
  const record = project[payload.collection][payload.entityId];
  if (!record) {
    return { patches: [], diagnostics: [error('Entity record does not exist.', pathForRecord(payload.collection, payload.entityId))] };
  }
  if (payload.parentId) {
    if (payload.parentId === payload.entityId) {
      return { patches: [], diagnostics: [error('Record cannot parent itself.', pathForRecordField(payload.collection, payload.entityId, 'parent'))] };
    }
    if (!project[payload.collection][payload.parentId]) {
      return { patches: [], diagnostics: [error('Parent record does not exist.', pathForRecord(payload.collection, payload.parentId))] };
    }
    if (wouldCreateParentCycle(project, payload, payload.parentId)) {
      return { patches: [], diagnostics: [error('Parent assignment would create a cycle.', pathForRecordField(payload.collection, payload.entityId, 'parent'))] };
    }
  }
  const patch = recordFieldPatch(
    record,
    payload.collection,
    payload.entityId,
    'parent',
    payload.parentId ? { collection: payload.collection, id: payload.parentId } : null,
  );
  return {
    patches: [patch],
    affectedPaths: [patch.path],
  };
}

export function referenceUsageSummary(usages: ReferenceUsage[]): string {
  if (usages.length === 0) return 'No usages found.';
  return `${usages.length} usage${usages.length === 1 ? '' : 's'} found.`;
}

export function referenceTargetFromEntity(target: EntityTarget): ReferenceTarget {
  return { collection: target.collection, id: target.entityId };
}

export function referenceTargetLabel(target: ReferenceTarget): string {
  return `${target.collection}/${target.id}`;
}

export function cloneAsJson(value: unknown): JsonValue {
  return cloneJsonValue(toJsonValue(value));
}
