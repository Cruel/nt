import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { flushStructuralCommandPersistence, useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useCloseGuardStore } from './close-guard-store';
import {
  runDraftActions,
  selectDraftDirtyByTabId,
  selectDraftEntriesForTab,
  useDraftDirtyStore,
} from './draft-dirty-store';
import { getTabDirtyState, restoreSaveUnitPatchesFromSaved } from './dirty-state';
import { MUTATION_SURFACE_ATTRIBUTIONS } from '@/project/save-unit-registry';
import { saveActiveSaveUnit } from '@/project/project-save-coordinator';
import { discardLoadedRecoverySaveUnits } from './project-editor-state';
import { useWorkbenchStore } from './workbench-store';
import { tabCloseRequiresDirtyPrompt } from './close-guard-store';
import { selectPendingSaveUnitIds, usePendingInputStore } from './pending-input-store';

export function DirtyCloseDialog() {
  const [saving, setSaving] = useState(false);
  const pendingClose = useCloseGuardStore((state) => state.pendingClose);
  const clearPendingClose = useCloseGuardStore((state) => state.clearPendingClose);
  const confirmPendingClose = useCloseGuardStore((state) => state.confirmPendingClose);
  const tabsById = useWorkbenchStore((state) => state.tabsById);
  const project = useProjectStore((state) => state.document);
  const savedDocument = useProjectStore((state) => state.savedDocument);
  const setProjectSaving = useProjectStore((state) => state.setSaving);
  const setProjectSaveError = useProjectStore((state) => state.setSaveError);
  const setDiagnostics = useWorkspaceStore((state) => state.setDiagnostics);
  const setStatusMessage = useWorkspaceStore((state) => state.setStatusMessage);
  const addTimelineEntry = useWorkspaceStore((state) => state.addTimelineEntry);
  const executeCommand = useCommandStore((state) => state.executeCommand);
  const draftEntries = useDraftDirtyStore((state) => state.entriesByKey);
  const pendingInputEntries = usePendingInputStore((state) => state.entriesBySaveUnitId);
  const pendingSaveUnitIds = useMemo(
    () => selectPendingSaveUnitIds({ entriesBySaveUnitId: pendingInputEntries }),
    [pendingInputEntries],
  );
  const clearDraftDirtyForTab = useDraftDirtyStore((state) => state.clearDraftDirtyForTab);
  const pendingTabs = useMemo(
    () =>
      pendingClose
        ? pendingClose.tabIds
            .map((tabId) => tabsById[tabId])
            .filter((tab): tab is NonNullable<typeof tab> => Boolean(tab))
        : [],
    [pendingClose, tabsById],
  );
  const pendingDirtyStates = useMemo(
    () =>
      pendingTabs.map((pendingTab) => ({
        tab: pendingTab,
        dirty: getTabDirtyState(
          pendingTab,
          project,
          savedDocument,
          selectDraftDirtyByTabId({ entriesByKey: draftEntries }),
          pendingSaveUnitIds,
        ),
      })),
    [draftEntries, pendingSaveUnitIds, pendingTabs, project, savedDocument],
  );
  const requestedTabIds = useMemo(
    () => new Set(pendingClose?.tabIds ?? []),
    [pendingClose?.tabIds],
  );
  const dirtyTabStates = pendingDirtyStates.filter(
    (entry) => entry.dirty.dirty && tabCloseRequiresDirtyPrompt(entry.tab.id, requestedTabIds),
  );
  const tab = pendingTabs[0] ?? null;
  const primaryDirtyTab = dirtyTabStates[0]?.tab ?? tab;
  const dirtyCount = dirtyTabStates.length;
  const closeCount = pendingClose?.tabIds.length ?? 0;

  const closeApprovedTabs = () => {
    if (!pendingClose) return;
    confirmPendingClose();
  };

  const saveAndClose = async () => {
    if (!pendingClose || pendingTabs.length === 0) return;
    setSaving(true);
    setProjectSaving(true);
    try {
      await flushStructuralCommandPersistence();
      for (const { tab: dirtyTab, dirty: dirtyState } of dirtyTabStates) {
        if (dirtyState.draftDirty) {
          const applied = await runDraftActions(
            selectDraftEntriesForTab(
              { entriesByKey: useDraftDirtyStore.getState().entriesByKey },
              dirtyTab.id,
            ),
            'apply',
          );
          if (!applied) {
            clearPendingClose();
            const message = 'Apply the local draft before saving, or discard it.';
            setProjectSaveError(message);
            setStatusMessage(message);
            return;
          }
        }
      }
      const saveUnitIds = [
        ...new Set(
          dirtyTabStates
            .map(({ dirty }) => dirty.saveUnitId)
            .filter((saveUnitId): saveUnitId is string => Boolean(saveUnitId)),
        ),
      ];
      for (const saveUnitId of saveUnitIds) {
        const result = await saveActiveSaveUnit(saveUnitId);
        if (!result.success && result.status !== 'nothing-to-save') {
          const message =
            result.response?.error ?? result.diagnostics[0]?.message ?? 'Save failed.';
          setProjectSaveError(message);
          setStatusMessage(message);
          setDiagnostics(result.diagnostics);
          addTimelineEntry({ source: 'command', message, detail: result });
          return;
        }
      }
      const message = saveUnitIds.length > 1 ? 'Saved modified items' : 'Saved modified item';
      setStatusMessage(message);
      addTimelineEntry({ source: 'command', message, detail: { saveUnitIds } });
      closeApprovedTabs();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Save failed.';
      setProjectSaveError(message);
      setStatusMessage(message);
      addTimelineEntry({ source: 'command', message, detail: error });
    } finally {
      setSaving(false);
    }
  };

  const discardAndClose = () => {
    if (!pendingClose || pendingTabs.length === 0) return;
    for (const { tab: dirtyTab, dirty: dirtyState } of dirtyTabStates) {
      if (!dirtyState.draftDirty) continue;
      const discarded = runDraftActions(
        selectDraftEntriesForTab(
          { entriesByKey: useDraftDirtyStore.getState().entriesByKey },
          dirtyTab.id,
        ),
        'discard',
      );
      void discarded.then((ok) => {
        if (!ok) clearDraftDirtyForTab(dirtyTab.id);
      });
      clearDraftDirtyForTab(dirtyTab.id);
    }
    const restoredSaveUnitIds = new Set<string>();
    const patches = dirtyTabStates.flatMap(({ tab: dirtyTab, dirty }) => {
      if (dirty.saveUnitId && restoredSaveUnitIds.has(dirty.saveUnitId)) return [];
      if (dirty.saveUnitId) restoredSaveUnitIds.add(dirty.saveUnitId);
      return restoreSaveUnitPatchesFromSaved(dirtyTab, project, savedDocument);
    });
    if (patches.length > 0) {
      executeCommand({
        type: 'project.applyPatch',
        ...MUTATION_SURFACE_ATTRIBUTIONS.discardDirtyUnits,
        label:
          dirtyTabStates.length === 1 && primaryDirtyTab
            ? `Discard changes to ${primaryDirtyTab.title}`
            : `Discard changes to ${dirtyTabStates.length} tabs`,
        payload: patches,
      });
    }
    discardLoadedRecoverySaveUnits(restoredSaveUnitIds);
    closeApprovedTabs();
  };

  const hasPersistentDirty = dirtyTabStates.some(
    (entry) => entry.dirty.persistentDirty || entry.dirty.pendingInputDirty,
  );
  const hasDraftDirty = dirtyTabStates.some((entry) => entry.dirty.draftDirty);
  const title =
    closeCount > 1
      ? `Close ${closeCount} tabs?`
      : primaryDirtyTab
        ? `Close ${primaryDirtyTab.title}?`
        : 'Close modified tab?';
  const description =
    closeCount > 1
      ? `${dirtyCount} of ${closeCount} requested tabs ${dirtyCount === 1 ? 'has' : 'have'} unsaved changes. Save applies local drafts and saves the selected items; Don't Save closes all requested tabs and drops dirty changes.`
      : hasDraftDirty
        ? "This tab has unapplied local edits. Save will apply the draft and save this item; Don't Save closes the tab and drops the local edits."
        : "This tab has unsaved project changes. Save this item, don't save its changes, or cancel.";

  return (
    <Dialog
      open={pendingClose !== null}
      onOpenChange={(open) => {
        if (!open) clearPendingClose();
      }}
    >
      <DialogPopup>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={clearPendingClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={discardAndClose}
            disabled={pendingTabs.length === 0 || saving}
          >
            Don't Save
          </Button>
          <Button
            size="sm"
            onClick={() => void saveAndClose()}
            disabled={pendingTabs.length === 0 || saving || (!hasPersistentDirty && !hasDraftDirty)}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
