import { NATIVE_FIELD_DRAFT_SCHEMA } from '@/commands/native-field-recovery-schema';
import { useDraftDirtyStore, type DraftDirtyEntry } from '@/workbench/draft-dirty-store';
import { usePendingInputStore } from '@/workbench/pending-input-store';
import { buildCurrentEditorRecoveryState } from '@/workbench/project-editor-state';
import { buildJsonPointer, parseJsonPointer } from './json-pointer';
import { isJsonObject, jsonValuesEqual, type JsonValue } from './json-value';
import { useConfigurationAutosaveStatus } from './project-configuration-autosave';
import { useProjectSourceStore } from './project-source-store';
import { useProjectStore } from './project-store';
import {
  EXPORT_PROFILE_OWNED_PATHS,
  isConfigurationAutosaveSaveUnit,
  PROJECT_SETTINGS_OWNED_PATHS,
  PROJECT_SETTINGS_SAVE_UNIT_ID,
} from './save-unit-registry';

/**
 * Actual native working-vs-saved changes are still dirty for recovery,
 * shutdown and export admission. This selector answers a different question:
 * is there content for which the user is expected to invoke Save / Save All?
 *
 * Keep the exclusion paths aligned with the Save-unit registry. In particular
 * /export is not wholly autosaved: only its explicitly owned subtrees are.
 */
const autosavedPaths = new Set([...PROJECT_SETTINGS_OWNED_PATHS, ...EXPORT_PROFILE_OWNED_PATHS]);
const autosavedAncestors = new Set<string>(['']);
for (const path of autosavedPaths) {
  const segments = parseJsonPointer(path);
  for (let length = 1; length < segments.length; length += 1)
    autosavedAncestors.add(buildJsonPointer(segments.slice(0, length)));
}

function exactInstanceRequiresManualSave(
  working: JsonValue | undefined,
  saved: JsonValue | undefined,
): boolean {
  if (jsonValuesEqual(working, saved)) return false;
  if (!isJsonObject(working) && working !== undefined) return true;
  if (!isJsonObject(saved) && saved !== undefined) return true;
  const workingInstances = isJsonObject(working) ? working : {};
  const savedInstances = isJsonObject(saved) ? saved : {};
  const recovery = buildCurrentEditorRecoveryState().saveUnitsById;
  const settings = recovery[PROJECT_SETTINGS_SAVE_UNIT_ID];
  for (const id of new Set([...Object.keys(workingInstances), ...Object.keys(savedInstances)])) {
    if (jsonValuesEqual(workingInstances[id], savedInstances[id])) continue;
    const path = buildJsonPointer(['interactableInstances', id]);
    const overlapsInstance = (affected: string) =>
      affected === path || affected.startsWith(`${path}/`) || path.startsWith(`${affected}/`);
    // A native Inventory edit belongs to Project Settings only if its exact
    // instance is attributed to that Save unit. Do not suppress Room-owned
    // or unattributed Instance edits in the same physical project.yaml.
    if (!settings?.affectedPaths.some(overlapsInstance)) return true;
    if (
      Object.entries(recovery).some(
        ([owner, entry]) =>
          owner !== PROJECT_SETTINGS_SAVE_UNIT_ID && entry.affectedPaths.some(overlapsInstance),
      )
    )
      return true;
  }
  return false;
}

function differsOutsideAutosave(
  working: JsonValue | undefined,
  saved: JsonValue | undefined,
  path: string,
): boolean {
  if (autosavedPaths.has(path)) return false;
  if (path === '/interactableInstances') return exactInstanceRequiresManualSave(working, saved);
  if (path === '/editor') {
    // editor.yaml's tracked organization uses manual Save units; Preview
    // locale, tab arrangement, and other local metadata have their own flush.
    if (working !== undefined && !isJsonObject(working)) return true;
    if (saved !== undefined && !isJsonObject(saved)) return true;
    const current = isJsonObject(working) ? working : {};
    const baseline = isJsonObject(saved) ? saved : {};
    return ['chapters', 'tags', 'recordMetadata'].some(
      (key) => !jsonValuesEqual(current[key], baseline[key]),
    );
  }
  if (jsonValuesEqual(working, saved)) return false;
  if (!autosavedAncestors.has(path)) return true;
  if (!isJsonObject(working) && working !== undefined) return true;
  if (!isJsonObject(saved) && saved !== undefined) return true;
  const current = isJsonObject(working) ? working : {};
  const baseline = isJsonObject(saved) ? saved : {};
  for (const key of new Set([...Object.keys(current), ...Object.keys(baseline)]))
    if (
      differsOutsideAutosave(
        current[key],
        baseline[key],
        buildJsonPointer([...parseJsonPointer(path), key]),
      )
    )
      return true;
  return false;
}

export function projectRequiresManualSave(
  working: JsonValue | null,
  saved: JsonValue | null,
): boolean {
  if (working === null) return false;
  if (saved === null) return true;
  return differsOutsideAutosave(working, saved, '');
}

export function isAutosavedNativeFieldDraft(entry: DraftDirtyEntry): boolean {
  if (entry.schema !== NATIVE_FIELD_DRAFT_SCHEMA || !entry.key.startsWith('native-field:'))
    return false;
  try {
    const identity: unknown = JSON.parse(entry.key.slice('native-field:'.length));
    return (
      Array.isArray(identity) &&
      identity.length === 2 &&
      typeof identity[0] === 'string' &&
      typeof identity[1] === 'string' &&
      isConfigurationAutosaveSaveUnit(identity[0])
    );
  } catch {
    // Corrupted / unattributed recovery always requires attention.
    return false;
  }
}

/** Shared across the status bar, toolbar Save icon and File menu. */
export function useManualSaveDirty(): boolean {
  const hasProject = useProjectStore((state) => state.document !== null);
  const manualContentDirty = useProjectStore((state) =>
    projectRequiresManualSave(state.document, state.savedDocument),
  );
  const projectInstanceId = useProjectStore((state) => state.projectInstanceId);
  const sourceDirty = useProjectSourceStore((state) =>
    Object.values(state.buffersById).some((buffer) => buffer.dirty),
  );
  const draftDirty = useDraftDirtyStore((state) =>
    Object.values(state.entriesByKey).some(
      (entry) => entry.dirty && !isAutosavedNativeFieldDraft(entry),
    ),
  );
  const pendingInputDirty = usePendingInputStore((state) =>
    Object.keys(state.entriesBySaveUnitId).some((unit) => !isConfigurationAutosaveSaveUnit(unit)),
  );
  const autosaveNeedsAttention = useConfigurationAutosaveStatus(
    (status) =>
      status.projectInstanceId === projectInstanceId &&
      (status.failedOwners.length > 0 ||
        status.blockedOwners.length > 0 ||
        status.recoveredOwners.length > 0),
  );
  return (
    hasProject &&
    (manualContentDirty || sourceDirty || draftDirty || pendingInputDirty || autosaveNeedsAttention)
  );
}
