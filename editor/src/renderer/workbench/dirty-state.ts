import { getJsonAtPointer, hasJsonAtPointer, buildJsonPointer, type JsonPointer } from '@/project/json-pointer';
import { cloneJsonValue, type JsonValue } from '@/project/json-value';
import type { JsonPatchOperation } from '@/project/json-patch';
import type { WorkbenchResource, WorkbenchTab } from './workbench-types';

export interface ResourceDirtyState {
  dirty: boolean;
  path: JsonPointer | null;
  currentExists: boolean;
  savedExists: boolean;
}

export interface TabDirtyState {
  dirty: boolean;
  persistentDirty: boolean;
  draftDirty: boolean;
  resourcePath: JsonPointer | null;
}

export function jsonDeepEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  if (left === null || right === null) return left === right;
  if (typeof left !== typeof right) return false;
  if (typeof left !== 'object' || typeof right !== 'object') return left === right;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => jsonDeepEqual(item, right[index]));
  }

  const leftObject = left as Record<string, JsonValue>;
  const rightObject = right as Record<string, JsonValue>;
  const leftKeys = Object.keys(leftObject).sort();
  const rightKeys = Object.keys(rightObject).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && jsonDeepEqual(leftObject[key], rightObject[key]));
}

export function resourcePathForDirtyCheck(resource?: WorkbenchResource): JsonPointer | null {
  if (!resource || !resource.collection || !resource.entityId) return null;
  if (resource.kind !== 'record' && resource.kind !== 'raw') return null;
  return buildJsonPointer([resource.collection, resource.entityId]);
}

function readOptionalJson(document: JsonValue | null, path: JsonPointer | null): { exists: boolean; value?: JsonValue } {
  if (!document || path === null || !hasJsonAtPointer(document, path)) return { exists: false };
  return { exists: true, value: getJsonAtPointer(document, path) };
}

export function getResourceDirtyState(
  resource: WorkbenchResource | undefined,
  currentDocument: JsonValue | null,
  savedDocument: JsonValue | null,
): ResourceDirtyState {
  const path = resourcePathForDirtyCheck(resource);
  if (path === null) {
    return { dirty: false, path: null, currentExists: false, savedExists: false };
  }
  const current = readOptionalJson(currentDocument, path);
  const saved = readOptionalJson(savedDocument, path);
  return {
    dirty: current.exists !== saved.exists || !jsonDeepEqual(current.value, saved.value),
    path,
    currentExists: current.exists,
    savedExists: saved.exists,
  };
}

export function getTabDirtyState(
  tab: WorkbenchTab,
  currentDocument: JsonValue | null,
  savedDocument: JsonValue | null,
  draftDirtyByTabId: Record<string, boolean>,
): TabDirtyState {
  const resource = getResourceDirtyState(tab.resource, currentDocument, savedDocument);
  const draftDirty = Boolean(draftDirtyByTabId[tab.id]);
  const persistentDirty = resource.dirty || Boolean(tab.dirty);
  return {
    dirty: persistentDirty || draftDirty,
    persistentDirty,
    draftDirty,
    resourcePath: resource.path,
  };
}

export function restoreResourcePatchesFromSaved(
  resource: WorkbenchResource | undefined,
  currentDocument: JsonValue | null,
  savedDocument: JsonValue | null,
): JsonPatchOperation[] {
  const path = resourcePathForDirtyCheck(resource);
  if (!path || !currentDocument) return [];
  const currentExists = hasJsonAtPointer(currentDocument, path);
  const savedExists = savedDocument ? hasJsonAtPointer(savedDocument, path) : false;
  if (!currentExists && !savedExists) return [];
  if (savedExists && savedDocument) {
    const savedValue = cloneJsonValue(getJsonAtPointer(savedDocument, path));
    return currentExists ? [{ op: 'replace', path, value: savedValue }] : [{ op: 'add', path, value: savedValue }];
  }
  return currentExists ? [{ op: 'remove', path }] : [];
}
