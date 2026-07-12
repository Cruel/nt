import { buildJsonPointer, hasJsonAtPointer } from '@/project/json-pointer';
import { cloneJsonValue, toJsonValue, type JsonValue } from '@/project/json-value';
import {
  authoringCollectionMetadata,
  isAuthoringCollectionKey,
  type AuthoringCollectionKey,
} from '../../shared/project-schema/authoring-collections';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import { defaultDialogueData } from '../../shared/project-schema/authoring-dialogues';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultSceneData } from '../../shared/project-schema/authoring-scenes';
import { defaultShaderData } from '../../shared/project-schema/authoring-shaders';
import { defaultTestData } from '../../shared/project-schema/authoring-tests';
import { defaultVariableData } from '../../shared/project-schema/authoring-variables';
import {
  entityIdPattern,
  isAuthoringProject,
  type AuthoringProject,
  type AuthoringRecordBase,
  type ReferenceTarget,
} from '../../shared/project-schema/authoring-project';
import { collectProjectTags, normalizeTagKey, normalizeTags, tagColorForIndex } from '../../shared/project-schema/authoring-tags';
import { EDITOR_PROJECT_STATE_SCHEMA, EDITOR_PROJECT_STATE_SCHEMA_VERSION } from '../../shared/project-schema/editor-project-state';
import { authoringRecordSchemas } from '../../shared/project-schema/authoring-records';
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

export interface SetEntityExtendsPayload extends EntityTarget {
  extendsId: string | null;
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
  if (collection === 'dialogues') return defaultDialogueData(label) as unknown as Record<string, unknown>;
  if (collection === 'scenes') return defaultSceneData(label) as unknown as Record<string, unknown>;
  if (collection === 'tests') return defaultTestData(label) as unknown as Record<string, unknown>;
  if (collection === 'assets') return { kind: 'binary', source: { type: 'project-file', path: `assets/binary/${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.bin` }, aliases: [] };
  if (collection === 'interactables') return { kind: 'interactable' };
  if (collection === 'verbs') return { kind: 'verb' };
  if (collection === 'interactions') return { kind: 'interaction' };
  if (collection === 'maps') return { kind: 'map' };
  if (collection === 'scripts') return { kind: 'script-module', source: '' };
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
    data: defaultDataForCollection(collection, label, options.data),
  };
  if (options.description?.trim()) record.description = options.description;
  if (['characters', 'rooms', 'interactables', 'verbs', 'interactions', 'dialogues', 'scenes', 'maps'].includes(collection)) {
    record.extends = null;
    record.properties = {};
  }
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
  const path = pathForRecord(payload.collection, payload.entityId);
  const documentValue = toJsonValue(document);
  const normalizedTags = payload.tags ? normalizeTags(payload.tags) : undefined;
  const record = createDefaultAuthoringRecord(payload.collection, payload.entityId, { ...payload, tags: normalizedTags });
  const parsedRecord = authoringRecordSchemas[payload.collection].safeParse(record);
  if (!parsedRecord.success) {
    return {
      patches: [],
      diagnostics: parsedRecord.error.issues.map((issue) => error(issue.message, `${path}/${issue.path.map(String).join('/')}`)),
    };
  }
  const tagRegistryPatches = normalizedTags ? registryPatchesForTags(project, documentValue, normalizedTags) : [];
  const metadata: JsonPatchOperation[] = [];
  if (normalizedTags || payload.color !== undefined) {
    ensureRecordMetadataObjects(metadata, documentValue, payload.collection);
    metadata.push({ op: 'add', path: buildJsonPointer(['editor', 'recordMetadata', payload.collection, payload.entityId]), value: toJsonValue({ tags: normalizedTags ?? [], color: payload.color ?? null }) });
  }
  return {
    patches: [...tagRegistryPatches, ...metadata, { op: 'add', path, value: toJsonValue(parsedRecord.data) }],
    affectedPaths: [...tagRegistryPatches.map((patch) => patch.path), path, ...metadata.map((patch) => patch.path)],
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
    } else {
      next[key] = rewriteReferenceTarget(child, from, to);
    }
  }
  return next;
}

function rewriteRecordReferences(record: AuthoringRecordBase, from: ReferenceTarget, to: ReferenceTarget): AuthoringRecordBase {
  const next = cloneRecord(record);
  if (from.collection === to.collection && next.extends === from.id) next.extends = to.id;
  next.data = rewriteReferenceTarget(next.data, from, to);
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

function ensureEditorTagRegistryObjects(patches: JsonPatchOperation[], documentValue: JsonValue) {
  if (!hasJsonAtPointer(documentValue, '/editor')) {
    patches.push({
      op: 'add',
      path: '/editor',
      value: toJsonValue({
        schema: EDITOR_PROJECT_STATE_SCHEMA,
        schemaVersion: EDITOR_PROJECT_STATE_SCHEMA_VERSION,
        tags: { records: {} },
      }),
    });
    return;
  }
  if (!hasJsonAtPointer(documentValue, '/editor/tags')) {
    patches.push({ op: 'add', path: '/editor/tags', value: toJsonValue({ records: {} }) });
    return;
  }
  if (!hasJsonAtPointer(documentValue, '/editor/tags/records')) {
    patches.push({ op: 'add', path: '/editor/tags/records', value: {} });
  }
}

function ensureRecordMetadataObjects(
  patches: JsonPatchOperation[],
  documentValue: JsonValue,
  collection: AuthoringCollectionKey,
) {
  if (!hasJsonAtPointer(documentValue, '/editor/recordMetadata')) {
    patches.push({ op: 'add', path: '/editor/recordMetadata', value: {} });
  }
  const collectionPath = buildJsonPointer(['editor', 'recordMetadata', collection]);
  if (!hasJsonAtPointer(documentValue, collectionPath)) {
    patches.push({ op: 'add', path: collectionPath, value: {} });
  }
}

function registryPatchesForTags(project: AuthoringProject, documentValue: JsonValue, tags: string[]): JsonPatchOperation[] {
  const normalizedTags = normalizeTags(tags);
  if (normalizedTags.length === 0) return [];
  const patches: JsonPatchOperation[] = [];
  ensureEditorTagRegistryObjects(patches, documentValue);
  const existingRecords = project.editor.tags?.records ?? {};
  const summaryByKey = new Map(collectProjectTags(project).map((tag) => [tag.key, tag]));
  const pendingKeys = new Set<string>();
  let nextIndex = summaryByKey.size;
  for (const tag of normalizedTags) {
    const key = normalizeTagKey(tag);
    if (!key || existingRecords[key] || pendingKeys.has(key)) continue;
    pendingKeys.add(key);
    patches.push({
      op: 'add',
      path: buildJsonPointer(['editor', 'tags', 'records', key]),
      value: toJsonValue({ name: tag, color: summaryByKey.get(key)?.color ?? tagColorForIndex(nextIndex) }),
    });
    nextIndex += 1;
  }
  return patches;
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
    const value = usage.kind === 'variable-ref' || usage.kind === 'extends'
      ? to.id
      : usage.kind === 'entrypoint'
        ? { kind: to.collection.slice(0, -1), id: to.id }
        : to;
    patches.push({ op: 'replace', path: usage.path, value: toJsonValue(value) });
    affectedPaths.push(usage.path);
  }
  const oldMetadataPath = buildJsonPointer(['editor', 'recordMetadata', payload.collection, payload.fromId]);
  const newMetadataPath = buildJsonPointer(['editor', 'recordMetadata', payload.collection, payload.toId]);
  const metadata = project.editor.recordMetadata?.[payload.collection]?.[payload.fromId];
  if (metadata) {
    patches.push({ op: 'add', path: newMetadataPath, value: toJsonValue(metadata) });
    patches.push({ op: 'remove', path: oldMetadataPath });
    affectedPaths.push(newMetadataPath, oldMetadataPath);
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
  const patches: JsonPatchOperation[] = [{ op: 'add', path, value: toJsonValue(duplicate) }];
  const affectedPaths = [path];
  const metadata = project.editor.recordMetadata?.[payload.collection]?.[payload.sourceId];
  if (metadata) {
    const metadataPath = buildJsonPointer(['editor', 'recordMetadata', payload.collection, payload.targetId]);
    patches.push({ op: 'add', path: metadataPath, value: toJsonValue(metadata) });
    affectedPaths.push(metadataPath);
  }
  return { patches, affectedPaths };
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
  const patches: JsonPatchOperation[] = [{ op: 'remove', path }];
  const affectedPaths = [path];
  const metadataPath = buildJsonPointer(['editor', 'recordMetadata', payload.collection, payload.entityId]);
  if (project.editor.recordMetadata?.[payload.collection]?.[payload.entityId]) {
    patches.push({ op: 'remove', path: metadataPath });
    affectedPaths.push(metadataPath);
  }
  return { patches, affectedPaths };
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
  const documentValue = toJsonValue(document);
  const normalizedTags = payload.tags ? normalizeTags(payload.tags) : undefined;
  if (normalizedTags) {
    const tagRegistryPatches = registryPatchesForTags(project, documentValue, normalizedTags);
    patches.push(...tagRegistryPatches);
    affectedPaths.push(...tagRegistryPatches.map((patch) => patch.path));
  }
  for (const [field, value] of [['label', payload.label], ['description', payload.description]] as const) {
    if (value === undefined) continue;
    const patch = recordFieldPatch(record, payload.collection, payload.entityId, field, value);
    patches.push(patch);
    affectedPaths.push(patch.path);
  }
  if (normalizedTags !== undefined || payload.color !== undefined || payload.sortKey !== undefined) {
    ensureRecordMetadataObjects(patches, documentValue, payload.collection);
    const metadataPath = buildJsonPointer(['editor', 'recordMetadata', payload.collection, payload.entityId]);
    const current = project.editor.recordMetadata?.[payload.collection]?.[payload.entityId] ?? { tags: [] };
    const metadata = {
      ...current,
      tags: normalizedTags ?? current.tags,
      color: payload.color !== undefined ? payload.color : current.color,
      sortKey: payload.sortKey !== undefined ? payload.sortKey : current.sortKey,
    };
    patches.push({ op: hasJsonAtPointer(documentValue, metadataPath) ? 'replace' : 'add', path: metadataPath, value: toJsonValue(metadata) });
    affectedPaths.push(metadataPath);
  }
  return { patches, affectedPaths };
}

const extendableCollections = new Set<AuthoringCollectionKey>([
  'characters', 'rooms', 'interactables', 'verbs', 'interactions', 'dialogues', 'scenes', 'maps',
]);

export function wouldCreateExtendsCycle(project: AuthoringProject, source: EntityTarget, extendsId: string | null): boolean {
  let current = extendsId;
  const seen = new Set<string>();
  while (current) {
    if (current === source.entityId || seen.has(current)) return true;
    seen.add(current);
    current = (project[source.collection][current] as AuthoringRecordBase | undefined)?.extends ?? null;
  }
  return false;
}

export function setEntityExtendsPatches(
  document: JsonValue | unknown,
  payload: SetEntityExtendsPayload,
): EntityOperationResult {
  const project = validateProject(document);
  if (!isAuthoringProject(project)) return { patches: [], diagnostics: [project] };
  if (!extendableCollections.has(payload.collection)) {
    return { patches: [], diagnostics: [error(`${payload.collection} records do not support extends.`, pathForRecord(payload.collection, payload.entityId))] };
  }
  const record = project[payload.collection][payload.entityId] as AuthoringRecordBase | undefined;
  if (!record) return { patches: [], diagnostics: [error('Entity record does not exist.', pathForRecord(payload.collection, payload.entityId))] };
  if (payload.extendsId && !project[payload.collection][payload.extendsId]) {
    return { patches: [], diagnostics: [error('Extended record does not exist.', pathForRecord(payload.collection, payload.extendsId))] };
  }
  if (wouldCreateExtendsCycle(project, payload, payload.extendsId)) {
    return { patches: [], diagnostics: [error('extends assignment would create a cycle.', pathForRecordField(payload.collection, payload.entityId, 'extends'))] };
  }
  const patch = recordFieldPatch(record, payload.collection, payload.entityId, 'extends', payload.extendsId);
  return { patches: [patch], affectedPaths: [patch.path] };
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
