import { create } from 'zustand';
import { useCommandStore } from '@/commands/command-store';
import {
  unresolvedNativeFieldOwners,
  useNativeFieldDraftStore,
} from '@/commands/native-field-drafts';
import { getJsonAtPointer, hasJsonAtPointer } from './json-pointer';
import { jsonValuesEqual, type JsonValue } from './json-value';
import { buildCurrentEditorRecoveryState } from '@/workbench/project-editor-state';
import { usePendingInputStore } from '@/workbench/pending-input-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import {
  CONFIGURATION_AUTOSAVE_SAVE_UNIT_IDS,
  EXPORT_PROFILE_OWNED_PATHS,
  isConfigurationAutosaveSaveUnit,
  PROJECT_SETTINGS_OWNED_PATHS,
  PROJECT_SETTINGS_SAVE_UNIT_ID,
} from './save-unit-registry';
import { saveActiveSaveUnit } from './project-save-coordinator';
import { useProjectStore } from './project-store';
import { WORKSPACE_SAVE_SETTLED_EVENT } from '@/workspace/workspace-toolbar-events';
import type { TabDirtyState } from '@/workbench/dirty-state';

const DEBOUNCE_MS = 550;
type ConfigurationSaveUnit = (typeof CONFIGURATION_AUTOSAVE_SAVE_UNIT_IDS)[number];
const SAVE_UNITS = CONFIGURATION_AUTOSAVE_SAVE_UNIT_IDS;

export interface ConfigurationAutosaveStatus {
  projectInstanceId: string | null;
  /** Includes live field intents and accepted changes awaiting persistence. */
  pendingOwners: readonly string[];
  /** A real native save failure remains visible until that owner is saved. */
  failedOwners: readonly string[];
  /** Unresolved input, field conflicts or a prohibited atomic Save group. */
  blockedOwners: readonly string[];
  /** Recovery from an earlier session is never silently committed on open. */
  recoveredOwners: readonly string[];
  errorsByOwner: Readonly<Record<string, string>>;
}

/** The native working Project, saved baseline and recovery retain authority.
 * This store reports only the persistence *lifecycle*, not a second dirty model. */
export const useConfigurationAutosaveStatus = create<ConfigurationAutosaveStatus>()(() => ({
  projectInstanceId: null,
  pendingOwners: [],
  failedOwners: [],
  blockedOwners: [],
  recoveredOwners: [],
  errorsByOwner: {},
}));

/** Document-dirty and needs-attention are different concepts for autosaved
 * configuration. Keep actual dirty state for close/recovery; only show a tab
 * dot when user intervention is required. */
export function configurationTabShowsDirty(
  dirty: Pick<TabDirtyState, 'dirty' | 'saveUnitId'>,
  status: ConfigurationAutosaveStatus,
  projectInstanceId: string | null,
): boolean {
  if (!dirty.dirty || !isConfigurationAutosaveSaveUnit(dirty.saveUnitId)) return dirty.dirty;
  if (status.projectInstanceId !== projectInstanceId) return true;
  const owner = dirty.saveUnitId!;
  if (
    status.failedOwners.includes(owner) ||
    status.blockedOwners.includes(owner) ||
    status.recoveredOwners.includes(owner)
  )
    return true;
  // Pending is a scheduling detail, not evidence that the user must Save.
  // The native working/saved difference can precede a queued task or outlive
  // an earlier Save while a newer edit is still being acknowledged.
  return false;
}

function pathsForOwner(owner: ConfigurationSaveUnit): readonly string[] {
  return owner === PROJECT_SETTINGS_SAVE_UNIT_ID
    ? PROJECT_SETTINGS_OWNED_PATHS
    : EXPORT_PROFILE_OWNED_PATHS;
}

function valueChanged(left: JsonValue | null, right: JsonValue | null, path: string): boolean {
  if (!left || !right) return false;
  const leftExists = hasJsonAtPointer(left, path);
  const rightExists = hasJsonAtPointer(right, path);
  return (
    leftExists !== rightExists ||
    (leftExists &&
      rightExists &&
      !jsonValuesEqual(getJsonAtPointer(left, path), getJsonAtPointer(right, path)))
  );
}

function ownerChanged(
  owner: ConfigurationSaveUnit,
  left: JsonValue | null,
  right: JsonValue | null,
): boolean {
  return pathsForOwner(owner).some((path) => valueChanged(left, right, path));
}

function ownerHasPendingRecovery(owner: ConfigurationSaveUnit): boolean {
  return Boolean(buildCurrentEditorRecoveryState().saveUnitsById[owner]);
}

function hasNativeFieldError(owner: ConfigurationSaveUnit): boolean {
  const { projectInstanceId, projectSessionId } = useProjectStore.getState();
  return Object.values(useNativeFieldDraftStore.getState().entries).some(
    (entry) =>
      entry.projectInstanceId === projectInstanceId &&
      entry.projectSessionId === projectSessionId &&
      entry.saveUnitId === owner &&
      Boolean(entry.error || entry.conflict),
  );
}

function hasNativeFieldIntent(owner: ConfigurationSaveUnit): boolean {
  const { projectInstanceId, projectSessionId } = useProjectStore.getState();
  return Object.values(useNativeFieldDraftStore.getState().entries).some(
    (entry) =>
      entry.projectInstanceId === projectInstanceId &&
      entry.projectSessionId === projectSessionId &&
      entry.saveUnitId === owner,
  );
}

/** One controller per workspace. Commands stage native working edits; this
 * controller persists only autosave-owned units after native acknowledgment.
 *
 * Deliberate invariants:
 * - Never save a different unit, nor blindly rewrite project.yaml.
 * - A new edit cannot clear a prior failure or recovered-unsaved warning.
 * - A failed Save retains recovery and is retried only on an actual new edit.
 * - Loaded recovery is not automatically committed merely by opening a tab.
 */
export function startProjectConfigurationAutosave(): () => void {
  let instanceId = useProjectStore.getState().projectInstanceId;
  const pending = new Set<ConfigurationSaveUnit>();
  const failed = new Set<ConfigurationSaveUnit>();
  const blocked = new Set<ConfigurationSaveUnit>();
  const recovered = new Set<ConfigurationSaveUnit>();
  const retries = new Map<ConfigurationSaveUnit, number>();
  // Generation tracks acknowledged owner changes, not keystrokes. A Save for
  // generation N can succeed while N+1 is still waiting to persist.
  const generations = new Map<ConfigurationSaveUnit, number>();
  const errors = new Map<ConfigurationSaveUnit, string>();
  let saving: ConfigurationSaveUnit | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inputAttentionTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let disposed = false;
  let lastReportedError: string | null = null;

  function publish() {
    if (disposed) return;
    const active = new Set(pending);
    if (saving) active.add(saving);
    for (const owner of SAVE_UNITS)
      if (
        hasNativeFieldIntent(owner) ||
        Object.keys(usePendingInputStore.getState().entriesBySaveUnitId[owner] ?? {}).length
      )
        active.add(owner);
    const blockedFields = new Set(blocked);
    for (const owner of SAVE_UNITS) if (hasNativeFieldError(owner)) blockedFields.add(owner);
    const next: ConfigurationAutosaveStatus = {
      projectInstanceId: instanceId,
      pendingOwners: [...active].sort(),
      failedOwners: [...failed].sort(),
      blockedOwners: [...blockedFields].sort(),
      recoveredOwners: [...recovered].sort(),
      errorsByOwner: Object.fromEntries(errors),
    };
    const previous = useConfigurationAutosaveStatus.getState();
    if (
      previous.projectInstanceId === next.projectInstanceId &&
      (
        [
          'pendingOwners',
          'failedOwners',
          'blockedOwners',
          'recoveredOwners',
          'errorsByOwner',
        ] as const
      ).every((key) => JSON.stringify(previous[key]) === JSON.stringify(next[key]))
    )
      return;
    useConfigurationAutosaveStatus.setState(next);
  }

  function resetProject(nextInstanceId: string | null) {
    instanceId = nextInstanceId;
    if (timer) clearTimeout(timer);
    timer = null;
    if (inputAttentionTimer) clearTimeout(inputAttentionTimer);
    inputAttentionTimer = null;
    pending.clear();
    failed.clear();
    blocked.clear();
    recovered.clear();
    retries.clear();
    generations.clear();
    errors.clear();
    saving = null;
    lastReportedError = null;
    if (nextInstanceId) {
      for (const owner of SAVE_UNITS) if (ownerHasPendingRecovery(owner)) recovered.add(owner);
    }
    publish();
  }

  function schedule() {
    if (disposed || running || !pending.size || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, DEBOUNCE_MS);
  }

  function queue(owner: ConfigurationSaveUnit) {
    generations.set(owner, (generations.get(owner) ?? 0) + 1);
    pending.add(owner);
    // An edit only schedules another attempt. Failures and recovered overlays
    // stay visible until native persistence has actually acknowledged them.
    retries.delete(owner);
    publish();
    if (timer) clearTimeout(timer);
    timer = null;
    schedule();
  }

  function clearIfSaved() {
    let changed = false;
    for (const owner of SAVE_UNITS) {
      if (ownerHasPendingRecovery(owner)) continue;
      if (pending.delete(owner)) changed = true;
      if (failed.delete(owner)) changed = true;
      if (errors.delete(owner)) changed = true;
      if (
        !Object.keys(usePendingInputStore.getState().entriesBySaveUnitId[owner] ?? {}).length &&
        blocked.delete(owner)
      )
        changed = true;
      if (recovered.delete(owner)) changed = true;
      retries.delete(owner);
    }
    if (changed) publish();
  }

  async function flush() {
    if (disposed || running || !pending.size) return;
    const project = useProjectStore.getState();
    if (
      !project.projectInstanceId ||
      !project.projectSessionId ||
      !project.savedDocument ||
      !project.projectFilePath
    ) {
      pending.clear();
      publish();
      return;
    }
    if (project.isSaving || useCommandStore.getState().nativeMutationPending) return;

    // A blocked owner cannot monopolize the queue. Evaluate every pending
    // owner and persist the first independent eligible unit instead.
    const unresolved = unresolvedNativeFieldOwners();
    const raw = usePendingInputStore.getState().entriesBySaveUnitId;
    for (const candidate of SAVE_UNITS) {
      if (!pending.has(candidate)) continue;
      if (
        unresolved.unattributed ||
        unresolved.saveUnitIds.has(candidate) ||
        Object.keys(raw[candidate] ?? {}).length > 0
      ) {
        if (!hasNativeFieldIntent(candidate)) blocked.add(candidate);
      }
    }
    const owner = SAVE_UNITS.find(
      (candidate) =>
        pending.has(candidate) &&
        !unresolved.unattributed &&
        !unresolved.saveUnitIds.has(candidate) &&
        Object.keys(raw[candidate] ?? {}).length === 0,
    );
    if (!owner) {
      publish();
      return;
    }
    const native = useCommandStore.getState();
    if (native.nativeMutationFailure || hasNativeFieldError(owner)) {
      failed.add(owner);
      pending.delete(owner);
      const error = native.nativeMutationFailure || 'Native field edit needs resolution.';
      errors.set(owner, error);
      useProjectStore.getState().setSaveError(error);
      useWorkspaceStore.getState().setStatusMessage(error);
      publish();
      if (!native.nativeMutationFailure) schedule();
      return;
    }
    blocked.delete(owner);

    if (!ownerHasPendingRecovery(owner)) {
      pending.delete(owner);
      if (ownerChanged(owner, project.document, project.savedDocument)) {
        failed.add(owner);
        lastReportedError = `No recovery patch was available for the unsaved ${owner} settings.`;
        errors.set(owner, lastReportedError);
        useProjectStore.getState().setSaveError(lastReportedError);
        useWorkspaceStore.getState().setStatusMessage(lastReportedError);
      } else {
        recovered.delete(owner);
      }
      publish();
      schedule();
      return;
    }

    pending.delete(owner);
    saving = owner;
    running = true;
    publish();
    const submissionInstance = project.projectInstanceId;
    const submittedGeneration = generations.get(owner) ?? 0;
    try {
      const result = await saveActiveSaveUnit(owner, { requireExactSaveUnit: true });
      if (disposed || submissionInstance !== useProjectStore.getState().projectInstanceId) return;
      if (result.success) {
        window.dispatchEvent(new Event(WORKSPACE_SAVE_SETTLED_EVENT));
        if (ownerHasPendingRecovery(owner)) {
          if ((generations.get(owner) ?? 0) > submittedGeneration || hasNativeFieldIntent(owner)) {
            // The Save acknowledged the earlier generation. A later accepted
            // edit (or an in-flight field) still needs its own scoped Save.
            pending.add(owner);
          } else {
            // Native acknowledged a Save but renderer recovery still contains
            // the same generation. Report the inconsistency; never silently
            // claim the content was persisted or spin in a Save retry loop.
            const message = `Native Save completed but ${owner} still has unpersisted changes.`;
            failed.add(owner);
            errors.set(owner, message);
            lastReportedError = message;
            useProjectStore.getState().setSaveError(message);
            useWorkspaceStore.getState().setStatusMessage(message);
          }
        } else {
          pending.delete(owner);
          failed.delete(owner);
          errors.delete(owner);
          blocked.delete(owner);
          recovered.delete(owner);
          retries.delete(owner);
          if (lastReportedError && useProjectStore.getState().lastSaveError === lastReportedError)
            useProjectStore.getState().setSaveError(null);
          lastReportedError = null;
        }
      } else {
        const message =
          result.diagnostics[0]?.message ?? `Scoped native Save did not persist ${owner}.`;
        const transient =
          /Project changed before its native Save could begin|Native Project Save completed after its editor session changed/u.test(
            message,
          );
        const attempts = retries.get(owner) ?? 0;
        if (transient && attempts < 2) {
          retries.set(owner, attempts + 1);
          pending.add(owner);
        } else {
          failed.add(owner);
          errors.set(owner, message);
          lastReportedError = message;
          useProjectStore.getState().setSaveError(message);
          useWorkspaceStore.getState().setStatusMessage(message);
        }
      }
    } catch (error) {
      if (!disposed && submissionInstance === useProjectStore.getState().projectInstanceId) {
        const message = error instanceof Error ? error.message : String(error);
        failed.add(owner);
        errors.set(owner, message);
        lastReportedError = message;
        useProjectStore.getState().setSaveError(message);
        useWorkspaceStore.getState().setStatusMessage(message);
      }
    } finally {
      running = false;
      saving = null;
      if (!disposed) publish();
      schedule();
    }
  }

  function observeProject(
    next: ReturnType<typeof useProjectStore.getState>,
    previous: ReturnType<typeof useProjectStore.getState>,
  ) {
    if (next.projectInstanceId !== previous.projectInstanceId) {
      resetProject(next.projectInstanceId);
      return;
    }
    if (
      next.document !== previous.document &&
      next.lastMutationPublication !== previous.lastMutationPublication
    ) {
      const change = next.lastMutationPublication?.changeSet;
      if (change && change.kind !== 'external') {
        for (const owner of SAVE_UNITS)
          if (ownerChanged(owner, previous.document, next.document)) {
            if (ownerChanged(owner, next.document, next.savedDocument)) queue(owner);
            else {
              pending.delete(owner);
              clearIfSaved();
            }
          }
        // Project Inventory has dynamic native ownership (its subset of
        // Interactable Instances). Only queue it when recovery attributes
        // the actual changed instance to Project Settings.
        if (
          change.affectedPaths.some((path) => path.startsWith('/interactableInstances/')) &&
          ownerHasPendingRecovery(PROJECT_SETTINGS_SAVE_UNIT_ID)
        )
          queue(PROJECT_SETTINGS_SAVE_UNIT_ID);
      }
    }
    if (next.savedDocument !== previous.savedDocument) clearIfSaved();
    schedule();
  }

  function observeFields() {
    if (inputAttentionTimer) clearTimeout(inputAttentionTimer);
    inputAttentionTimer = null;
    const raw = usePendingInputStore.getState().entriesBySaveUnitId;
    for (const owner of SAVE_UNITS) {
      if (
        !Object.keys(raw[owner] ?? {}).length &&
        !pending.has(owner) &&
        !hasNativeFieldError(owner)
      )
        blocked.delete(owner);
    }
    publish();
    // Incomplete raw input alone does not enqueue an acknowledged mutation.
    // It still requires a delayed attention state, without attempting a Save
    // or flashing a dirty tab on each keystroke.
    if (SAVE_UNITS.some((owner) => Object.keys(raw[owner] ?? {}).length)) {
      inputAttentionTimer = setTimeout(() => {
        inputAttentionTimer = null;
        const latest = usePendingInputStore.getState().entriesBySaveUnitId;
        for (const owner of SAVE_UNITS)
          if (Object.keys(latest[owner] ?? {}).length && !hasNativeFieldIntent(owner))
            blocked.add(owner);
        publish();
      }, DEBOUNCE_MS);
    }
    schedule();
  }

  resetProject(instanceId);
  const unsubProject = useProjectStore.subscribe(observeProject);
  const unsubNative = useCommandStore.subscribe(schedule);
  const unsubFields = useNativeFieldDraftStore.subscribe(observeFields);
  const unsubRawInput = usePendingInputStore.subscribe(observeFields);

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    if (inputAttentionTimer) clearTimeout(inputAttentionTimer);
    unsubProject();
    unsubNative();
    unsubFields();
    unsubRawInput();
    useConfigurationAutosaveStatus.setState({
      projectInstanceId: null,
      pendingOwners: [],
      failedOwners: [],
      blockedOwners: [],
      recoveredOwners: [],
      errorsByOwner: {},
    });
  };
}
