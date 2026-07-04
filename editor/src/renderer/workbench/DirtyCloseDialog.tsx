import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useCloseGuardStore } from './close-guard-store';
import { runDraftActions, selectDraftDirtyByTabId, selectDraftEntriesForTab, useDraftDirtyStore } from './draft-dirty-store';
import { getTabDirtyState, restoreResourcePatchesFromSaved } from './dirty-state';
import { useWorkbenchStore } from './workbench-store';

export function DirtyCloseDialog() {
  const [saving, setSaving] = useState(false);
  const pendingClose = useCloseGuardStore((state) => state.pendingClose);
  const clearPendingClose = useCloseGuardStore((state) => state.clearPendingClose);
  const confirmPendingClose = useCloseGuardStore((state) => state.confirmPendingClose);
  const tabsById = useWorkbenchStore((state) => state.tabsById);
  const project = useProjectStore((state) => state.document);
  const savedDocument = useProjectStore((state) => state.savedDocument);
  const projectFilePath = useProjectStore((state) => state.projectFilePath);
  const projectPath = useProjectStore((state) => state.projectPath);
  const markProjectSaved = useProjectStore((state) => state.markSaved);
  const setProjectSaving = useProjectStore((state) => state.setSaving);
  const setProjectSaveError = useProjectStore((state) => state.setSaveError);
  const setProjectPath = useWorkspaceStore((state) => state.setProjectPath);
  const setProjectFilePath = useWorkspaceStore((state) => state.setProjectFilePath);
  const setStatusMessage = useWorkspaceStore((state) => state.setStatusMessage);
  const addTimelineEntry = useWorkspaceStore((state) => state.addTimelineEntry);
  const executeCommand = useCommandStore((state) => state.executeCommand);
  const draftEntries = useDraftDirtyStore((state) => state.entriesByKey);
  const clearDraftDirtyForTab = useDraftDirtyStore((state) => state.clearDraftDirtyForTab);
  const pendingTabs = useMemo(
    () => pendingClose ? pendingClose.tabIds.map((tabId) => tabsById[tabId]).filter((tab): tab is NonNullable<typeof tab> => Boolean(tab)) : [],
    [pendingClose, tabsById],
  );
  const pendingDirtyStates = useMemo(
    () => pendingTabs.map((pendingTab) => ({
      tab: pendingTab,
      dirty: getTabDirtyState(pendingTab, project, savedDocument, selectDraftDirtyByTabId({ entriesByKey: draftEntries })),
    })),
    [draftEntries, pendingTabs, project, savedDocument],
  );
  const dirtyTabStates = pendingDirtyStates.filter((entry) => entry.dirty.dirty);
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
      for (const { tab: dirtyTab, dirty: dirtyState } of dirtyTabStates) {
        if (dirtyState.draftDirty) {
          const applied = await runDraftActions(selectDraftEntriesForTab({ entriesByKey: useDraftDirtyStore.getState().entriesByKey }, dirtyTab.id), 'apply');
          if (!applied) {
            const message = 'Apply the local draft before saving, or discard it.';
            setProjectSaveError(message);
            setStatusMessage(message);
            return;
          }
        }
      }
      const latestProject = useProjectStore.getState().document;
      if (!latestProject) return;
      const latestProjectFilePath = useProjectStore.getState().projectFilePath;
      const result = latestProjectFilePath
        ? await window.noveltea.saveProject(latestProject, latestProjectFilePath)
        : await window.noveltea.saveProjectAs(latestProject, latestProjectFilePath, latestProjectFilePath);
      if (!result.success) {
        const message = result.error ?? 'Save failed.';
        setProjectSaveError(message);
        setStatusMessage(message);
        addTimelineEntry({ source: 'command', message, detail: result });
        return;
      }
      markProjectSaved({ projectPath: result.projectPath, projectFilePath: result.projectFilePath });
      setProjectPath(result.projectPath ?? projectPath);
      setProjectFilePath(result.projectFilePath ?? projectFilePath);
      const warningCount = result.diagnostics?.filter((diagnostic) => diagnostic.severity === 'warning').length ?? 0;
      const message = `Saved ${result.projectFilePath ?? latestProjectFilePath}${warningCount > 0 ? ` (${warningCount} warning${warningCount === 1 ? '' : 's'})` : ''}`;
      setStatusMessage(message);
      addTimelineEntry({ source: 'command', message, detail: result });
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
      const discarded = runDraftActions(selectDraftEntriesForTab({ entriesByKey: useDraftDirtyStore.getState().entriesByKey }, dirtyTab.id), 'discard');
      void discarded.then((ok) => { if (!ok) clearDraftDirtyForTab(dirtyTab.id); });
      clearDraftDirtyForTab(dirtyTab.id);
    }
    const patches = dirtyTabStates.flatMap(({ tab: dirtyTab }) => restoreResourcePatchesFromSaved(dirtyTab.resource, project, savedDocument));
    if (patches.length > 0) {
      executeCommand({
        type: 'project.applyPatch',
        label: dirtyTabStates.length === 1 && primaryDirtyTab ? `Discard changes to ${primaryDirtyTab.title}` : `Discard changes to ${dirtyTabStates.length} tabs`,
        payload: patches,
      });
    }
    closeApprovedTabs();
  };

  const hasPersistentDirty = dirtyTabStates.some((entry) => entry.dirty.persistentDirty);
  const hasDraftDirty = dirtyTabStates.some((entry) => entry.dirty.draftDirty);
  const title = closeCount > 1
    ? `Close ${closeCount} tabs?`
    : primaryDirtyTab
      ? `Close ${primaryDirtyTab.title}?`
      : 'Close modified tab?';
  const description = closeCount > 1
    ? `${dirtyCount} of ${closeCount} requested tabs ${dirtyCount === 1 ? 'has' : 'have'} unsaved changes. Save applies local drafts and saves the project; Discard closes all requested tabs and drops dirty changes.`
    : hasDraftDirty
      ? 'This tab has unapplied local edits. Save will apply the draft and save the project; Discard closes the tab and drops the local edits.'
      : 'This tab has unsaved project changes. Save the project, discard the changes for this record, or cancel.';

  return (
    <Dialog open={pendingClose !== null} onOpenChange={(open) => { if (!open) clearPendingClose(); }}>
      <DialogPopup>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={clearPendingClose} disabled={saving}>Cancel</Button>
          <Button size="sm" variant="destructive" onClick={discardAndClose} disabled={pendingTabs.length === 0 || saving}>Discard</Button>
          <Button size="sm" onClick={() => void saveAndClose()} disabled={pendingTabs.length === 0 || saving || (!hasPersistentDirty && !hasDraftDirty)}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
