import { buildJsonPointer, hasJsonAtPointer } from '@/project/json-pointer';
import { toJsonValue, type JsonValue } from '@/project/json-value';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import { collectiveCollectionSet } from '@/workspace/project-explorer-tree';
import { isAuthoringCollectionKey, type AuthoringCollectionKey } from '../../shared/project-schema/authoring-collections';
import type { JsonPatchOperation } from './json-patch';
import type { EntityOperationDiagnostic, EntityOperationResult } from './entity-operations';

export interface CreateChapterPayload { chapterId: string; label: string; color?: string | null }
export interface RenameChapterPayload { chapterId: string; label: string }
export interface DeleteChapterPayload { chapterId: string }
export interface SetChapterColorPayload { chapterId: string; color: string | null }
export interface AssignChaptersPayload { collection: AuthoringCollectionKey; entityId: string; chapterIds: string[] }
export interface SetHiddenCollectionsPayload { hiddenCollectionKeys: AuthoringCollectionKey[] }
export interface SetExplorerOptionsPayload { followActiveTab?: boolean; organizeByChapter?: boolean; groupUnassignedItems?: boolean }

function error(message: string, path?: string): EntityOperationDiagnostic {
  return { severity: 'error', message, path };
}

function ensureEditorPatches(documentValue: JsonValue) {
  const patches: JsonPatchOperation[] = [];
  if (!hasJsonAtPointer(documentValue, '/editor')) patches.push({ op: 'add', path: '/editor', value: {} });
  if (!hasJsonAtPointer(documentValue, '/editor/chapters')) patches.push({ op: 'add', path: '/editor/chapters', value: { records: {}, assignments: {} } });
  if (!hasJsonAtPointer(documentValue, '/editor/chapters/records')) patches.push({ op: 'add', path: '/editor/chapters/records', value: {} });
  if (!hasJsonAtPointer(documentValue, '/editor/chapters/assignments')) patches.push({ op: 'add', path: '/editor/chapters/assignments', value: {} });
  if (!hasJsonAtPointer(documentValue, '/editor/explorer')) patches.push({ op: 'add', path: '/editor/explorer', value: {} });
  return patches;
}

function addOrReplace(documentValue: JsonValue, path: string, value: unknown): JsonPatchOperation {
  return { op: hasJsonAtPointer(documentValue, path) ? 'replace' : 'add', path, value: toJsonValue(value) };
}

function chapterRecords(document: unknown): Record<string, { id: string; label: string }> {
  if (typeof document !== 'object' || document === null) return {};
  const editor = (document as { editor?: unknown }).editor as { chapters?: { records?: Record<string, { id: string; label: string }> } } | undefined;
  return editor?.chapters?.records ?? {};
}

function chapterAssignments(document: unknown): Record<string, string[]> {
  if (typeof document !== 'object' || document === null) return {};
  const editor = (document as { editor?: unknown }).editor as { chapters?: { assignments?: Record<string, string[]> } } | undefined;
  return editor?.chapters?.assignments ?? {};
}

function recordKey(collection: string, entityId: string) { return `${collection}:${entityId}`; }

function validChapterIds(document: unknown, chapterIds: string[]) {
  const records = chapterRecords(document);
  return [...new Set(chapterIds)].filter((id) => !!records[id]).sort((left, right) => left.localeCompare(right));
}

export function createChapterPatches(document: unknown, payload: CreateChapterPayload): EntityOperationResult {
  const chapterId = payload.chapterId.trim();
  if (!chapterId) return { patches: [], diagnostics: [error('Chapter ID is required.', '/editor/chapters/records')] };
  if (!payload.label.trim()) return { patches: [], diagnostics: [error('Chapter label is required.', `/editor/chapters/records/${chapterId}`)] };
  const documentValue = toJsonValue(document);
  const patches = ensureEditorPatches(documentValue);
  const path = buildJsonPointer(['editor', 'chapters', 'records', chapterId]);
  if (hasJsonAtPointer(documentValue, path)) return { patches: [], diagnostics: [error('A chapter with this ID already exists.', path)] };
  patches.push({ op: 'add', path, value: toJsonValue({ id: chapterId, label: payload.label.trim(), color: payload.color ?? null }) });
  return { patches, affectedPaths: patches.map((patch) => patch.path) };
}

export function renameChapterPatches(document: unknown, payload: RenameChapterPayload): EntityOperationResult {
  if (!payload.label.trim()) return { patches: [], diagnostics: [error('Chapter label is required.')] };
  const documentValue = toJsonValue(document);
  const path = buildJsonPointer(['editor', 'chapters', 'records', payload.chapterId, 'label']);
  if (!hasJsonAtPointer(documentValue, path)) return { patches: [], diagnostics: [error('Chapter does not exist.', path)] };
  return { patches: [{ op: 'replace', path, value: payload.label.trim() }], affectedPaths: [path] };
}

export function setChapterColorPatches(document: unknown, payload: SetChapterColorPayload): EntityOperationResult {
  const documentValue = toJsonValue(document);
  const path = buildJsonPointer(['editor', 'chapters', 'records', payload.chapterId, 'color']);
  const basePath = buildJsonPointer(['editor', 'chapters', 'records', payload.chapterId]);
  if (!hasJsonAtPointer(documentValue, basePath)) return { patches: [], diagnostics: [error('Chapter does not exist.', basePath)] };
  return { patches: [addOrReplace(documentValue, path, payload.color)], affectedPaths: [path] };
}

export function deleteChapterPatches(document: unknown, payload: DeleteChapterPayload): EntityOperationResult {
  const documentValue = toJsonValue(document);
  const recordPath = buildJsonPointer(['editor', 'chapters', 'records', payload.chapterId]);
  if (!hasJsonAtPointer(documentValue, recordPath)) return { patches: [], diagnostics: [error('Chapter does not exist.', recordPath)] };
  const patches: JsonPatchOperation[] = [{ op: 'remove', path: recordPath }];
  for (const [key, assignments] of Object.entries(chapterAssignments(document))) {
    if (!assignments.includes(payload.chapterId)) continue;
    const next = assignments.filter((id) => id !== payload.chapterId);
    const path = buildJsonPointer(['editor', 'chapters', 'assignments', key]);
    if (next.length === 0) patches.push({ op: 'remove', path });
    else patches.push({ op: 'replace', path, value: toJsonValue(next) });
  }
  return { patches, affectedPaths: patches.map((patch) => patch.path) };
}

export function assignChaptersPatches(document: unknown, payload: AssignChaptersPayload): EntityOperationResult {
  if (!isAuthoringProject(document)) return { patches: [], diagnostics: [error('Current document is not a NovelTea authoring project.')] };
  if (collectiveCollectionSet.has(payload.collection)) return { patches: [], diagnostics: [error('Collective categories are not assignable to chapters in V1.')] };
  if (!document[payload.collection][payload.entityId]) return { patches: [], diagnostics: [error('Record does not exist.', buildJsonPointer([payload.collection, payload.entityId]))] };
  const documentValue = toJsonValue(document);
  const patches = ensureEditorPatches(documentValue);
  const next = validChapterIds(document, payload.chapterIds);
  const key = recordKey(payload.collection, payload.entityId);
  const path = buildJsonPointer(['editor', 'chapters', 'assignments', key]);
  if (next.length === 0) {
    if (hasJsonAtPointer(documentValue, path)) patches.push({ op: 'remove', path });
  } else {
    patches.push(addOrReplace(documentValue, path, next));
  }
  return { patches, affectedPaths: patches.map((patch) => patch.path) };
}

export function setHiddenCollectionsPatches(document: unknown, payload: SetHiddenCollectionsPayload): EntityOperationResult {
  const documentValue = toJsonValue(document);
  const patches = ensureEditorPatches(documentValue);
  const hidden = [...new Set(payload.hiddenCollectionKeys.filter(isAuthoringCollectionKey))].sort((a, b) => a.localeCompare(b));
  patches.push(addOrReplace(documentValue, '/editor/explorer/hiddenCollectionKeys', hidden));
  return { patches, affectedPaths: patches.map((patch) => patch.path) };
}

export function setExplorerOptionsPatches(document: unknown, payload: SetExplorerOptionsPayload): EntityOperationResult {
  const documentValue = toJsonValue(document);
  const patches = ensureEditorPatches(documentValue);
  if (payload.followActiveTab !== undefined) patches.push(addOrReplace(documentValue, '/editor/explorer/followActiveTab', payload.followActiveTab));
  if (payload.organizeByChapter !== undefined) patches.push(addOrReplace(documentValue, '/editor/explorer/organizeByChapter', payload.organizeByChapter));
  if (payload.groupUnassignedItems !== undefined) patches.push(addOrReplace(documentValue, '/editor/explorer/groupUnassignedItems', payload.groupUnassignedItems));
  return { patches, affectedPaths: patches.map((patch) => patch.path) };
}
