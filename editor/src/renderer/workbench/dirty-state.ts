import {
  getJsonAtPointer,
  hasJsonAtPointer,
  buildJsonPointer,
  type JsonPointer,
} from '@/project/json-pointer';
import { cloneJsonValue, jsonValuesEqual, type JsonValue } from '@/project/json-value';
import type { JsonPatchOperation } from '@/project/json-patch';
import { resolveSaveUnitForResource, resolveSaveUnitForTab } from '@/project/save-unit-registry';
import type { SaveUnitDescriptor, SaveUnitId } from '@/project/save-unit-types';
import type { WorkbenchResource, WorkbenchTab } from './workbench-types';

export interface ResourceDirtyState {
  dirty: boolean;
  path: JsonPointer | null;
  paths: JsonPointer[];
  saveUnitId: SaveUnitId | null;
  currentExists: boolean;
  savedExists: boolean;
}

export interface TabDirtyState {
  dirty: boolean;
  persistentDirty: boolean;
  draftDirty: boolean;
  pendingInputDirty: boolean;
  resourcePath: JsonPointer | null;
  resourcePaths: JsonPointer[];
  saveUnitId: SaveUnitId | null;
}

export function jsonDeepEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return jsonValuesEqual(left, right);
}

export function resourcePathForDirtyCheck(resource?: WorkbenchResource): JsonPointer | null {
  if (!resource || !resource.collection || !resource.entityId) return null;
  if (resource.kind !== 'record' && resource.kind !== 'raw') return null;
  return buildJsonPointer([resource.collection, resource.entityId]);
}

function readOptionalJson(
  document: JsonValue | null,
  path: JsonPointer | null,
): { exists: boolean; value?: JsonValue } {
  if (!document || path === null || !hasJsonAtPointer(document, path)) return { exists: false };
  return { exists: true, value: getJsonAtPointer(document, path) };
}

export function getResourceDirtyState(
  resource: WorkbenchResource | undefined,
  currentDocument: JsonValue | null,
  savedDocument: JsonValue | null,
  editorType = 'placeholder-entity',
): ResourceDirtyState {
  const resolution = resolveSaveUnitForResource(resource, editorType, currentDocument);
  if (resolution.status !== 'savable') {
    return {
      dirty: false,
      path: null,
      paths: [],
      saveUnitId: null,
      currentExists: false,
      savedExists: false,
    };
  }
  return getSaveUnitDirtyState(resolution.descriptor, currentDocument, savedDocument);
}

export function getSaveUnitDirtyState(
  descriptor: SaveUnitDescriptor,
  currentDocument: JsonValue | null,
  savedDocument: JsonValue | null,
): ResourceDirtyState {
  const states = descriptor.ownedPaths.map((path) => ({
    path,
    current: readOptionalJson(currentDocument, path),
    saved: readOptionalJson(savedDocument, path),
  }));
  const first = states[0];
  return {
    dirty: states.some(
      ({ current, saved }) =>
        current.exists !== saved.exists || !jsonDeepEqual(current.value, saved.value),
    ),
    path: first?.path ?? null,
    paths: descriptor.ownedPaths,
    saveUnitId: descriptor.id,
    currentExists: first?.current.exists ?? false,
    savedExists: first?.saved.exists ?? false,
  };
}

export function getTabDirtyState(
  tab: WorkbenchTab,
  currentDocument: JsonValue | null,
  savedDocument: JsonValue | null,
  draftDirtyByTabId: Record<string, boolean>,
  pendingSaveUnitIds: ReadonlySet<SaveUnitId> = new Set(),
): TabDirtyState {
  const resolution = resolveSaveUnitForTab(tab, currentDocument);
  const resource =
    resolution.status === 'savable'
      ? getSaveUnitDirtyState(resolution.descriptor, currentDocument, savedDocument)
      : {
          dirty: false,
          path: null,
          paths: [],
          saveUnitId: null,
          currentExists: false,
          savedExists: false,
        };
  const draftDirty = Boolean(draftDirtyByTabId[tab.id]);
  const persistentDirty = resource.dirty;
  const pendingInputDirty = Boolean(
    resource.saveUnitId && pendingSaveUnitIds.has(resource.saveUnitId),
  );
  return {
    dirty: persistentDirty || draftDirty || pendingInputDirty,
    persistentDirty,
    draftDirty,
    pendingInputDirty,
    resourcePath: resource.path,
    resourcePaths: resource.paths,
    saveUnitId: resource.saveUnitId,
  };
}

export function restoreSaveUnitPatchesFromSaved(
  tab: WorkbenchTab,
  currentDocument: JsonValue | null,
  savedDocument: JsonValue | null,
): JsonPatchOperation[] {
  const resolution = resolveSaveUnitForTab(tab, currentDocument);
  if (resolution.status !== 'savable' || !currentDocument) return [];
  return resolution.descriptor.ownedPaths.flatMap((path) =>
    restorePathPatchesFromSaved(path, currentDocument, savedDocument),
  );
}

function restorePathPatchesFromSaved(
  path: JsonPointer,
  currentDocument: JsonValue,
  savedDocument: JsonValue | null,
): JsonPatchOperation[] {
  const currentExists = hasJsonAtPointer(currentDocument, path);
  const savedExists = savedDocument ? hasJsonAtPointer(savedDocument, path) : false;
  if (!currentExists && !savedExists) return [];
  if (savedExists && savedDocument) {
    const savedValue = cloneJsonValue(getJsonAtPointer(savedDocument, path));
    return currentExists
      ? [{ op: 'replace', path, value: savedValue }]
      : [{ op: 'add', path, value: savedValue }];
  }
  return currentExists ? [{ op: 'remove', path }] : [];
}

export function restoreResourcePatchesFromSaved(
  resource: WorkbenchResource | undefined,
  currentDocument: JsonValue | null,
  savedDocument: JsonValue | null,
): JsonPatchOperation[] {
  const path = resourcePathForDirtyCheck(resource);
  if (!path || !currentDocument) return [];
  return restorePathPatchesFromSaved(path, currentDocument, savedDocument);
}
