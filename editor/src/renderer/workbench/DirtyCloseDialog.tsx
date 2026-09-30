import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { flushStructuralCommandPersistence, useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { useProjectSourceStore } from '@/project/project-source-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { hasRemainingViewForSaveUnit, useCloseGuardStore } from './close-guard-store';
import {
  runDraftActions,
  selectDraftDirtyByTabId,
  selectDraftEntriesForTab,
  useDraftDirtyStore,
} from './draft-dirty-store';
import { getTabDirtyState, restoreSaveUnitPatchesFromSaved } from './dirty-state';
import { MUTATION_SURFACE_ATTRIBUTIONS } from '@/project/save-unit-registry';
import { saveActiveSaveUnit } from '@/project/project-save-coordinator';
import {
  buildCurrentEditorRecoveryState,
  discardLoadedRecoverySaveUnits,
} from './project-editor-state';
import type { JsonPointer } from '@/project/json-pointer';
import { useWorkbenchStore } from './workbench-store';
import { tabCloseRequiresDirtyPrompt } from './close-guard-store';
import { selectPendingSaveUnitIds, usePendingInputStore } from './pending-input-store';

export function DirtyCloseDialog() {
  const { t } = useTranslation('workspace');
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
  const recovery = buildCurrentEditorRecoveryState();
  const recoveryDirtySaveUnitIds = new Set(Object.keys(recovery.saveUnitsById));
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
  const pendingDirtyStates = pendingTabs.map((pendingTab) => ({
    tab: pendingTab,
    dirty: getTabDirtyState(
      pendingTab,
      project,
      savedDocument,
      selectDraftDirtyByTabId({ entriesByKey: draftEntries }),
      pendingSaveUnitIds,
      recoveryDirtySaveUnitIds,
    ),
  }));
  const requestedTabIds = useMemo(
    () => new Set(pendingClose?.tabIds ?? []),
    [pendingClose?.tabIds],
  );
  const dirtyTabStates = pendingDirtyStates.filter(
    (entry) => entry.dirty.dirty && tabCloseRequiresDirtyPrompt(entry.tab.id, requestedTabIds),
  );
  const draftOnlyTabIds = new Set(
    dirtyTabStates
      .filter(
        ({ dirty }) =>
          dirty.draftDirty &&
          !!dirty.saveUnitId &&
          hasRemainingViewForSaveUnit(dirty.saveUnitId, requestedTabIds),
      )
      .map(({ tab: dirtyTab }) => dirtyTab.id),
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
            const message = t('dirtyClose.applyDraftBeforeSave');
            setProjectSaveError(message);
            setStatusMessage(message);
            return;
          }
        }
      }
      const saveUnitIds = [
        ...new Set(
          dirtyTabStates
            .filter(({ tab: dirtyTab }) => !draftOnlyTabIds.has(dirtyTab.id))
            .map(({ dirty }) => dirty.saveUnitId)
            .filter((saveUnitId): saveUnitId is string => Boolean(saveUnitId)),
        ),
      ];
      for (const saveUnitId of saveUnitIds) {
        const result = await saveActiveSaveUnit(saveUnitId);
        if (!result.success && result.status !== 'nothing-to-save') {
          const message =
            result.response?.error ?? result.diagnostics[0]?.message ?? t('dirtyClose.saveFailed');
          setProjectSaveError(message);
          setStatusMessage(message);
          setDiagnostics(result.diagnostics);
          addTimelineEntry({ source: 'command', message, detail: result });
          return;
        }
        if (result.remainingDirtySaveUnitIds.includes(saveUnitId)) {
          const message = t('dirtyClose.changedDuringSave');
          setProjectSaveError(message);
          setStatusMessage(message);
          addTimelineEntry({ source: 'command', message, detail: result });
          return;
        }
      }
      const message =
        saveUnitIds.length === 0
          ? t('dirtyClose.appliedDraft')
          : t('dirtyClose.savedItems', { count: saveUnitIds.length });
      setStatusMessage(message);
      addTimelineEntry({ source: 'command', message, detail: { saveUnitIds } });
      closeApprovedTabs();
    } catch (error) {
      const message = error instanceof Error ? error.message : t('dirtyClose.saveFailed');
      setProjectSaveError(message);
      setStatusMessage(message);
      addTimelineEntry({ source: 'command', message, detail: error });
    } finally {
      setSaving(false);
      setProjectSaving(false);
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
    for (const { tab: dirtyTab } of dirtyTabStates) {
      if (dirtyTab.resource?.kind === 'source' && dirtyTab.resource.sourceId)
        useProjectSourceStore.getState().discard(dirtyTab.resource.sourceId);
    }
    const restoredSaveUnitIds = new Set<string>();
    const patches = dirtyTabStates.flatMap(({ tab: dirtyTab, dirty }) => {
      if (draftOnlyTabIds.has(dirtyTab.id)) return [];
      if (dirty.saveUnitId && restoredSaveUnitIds.has(dirty.saveUnitId)) return [];
      if (dirty.saveUnitId) restoredSaveUnitIds.add(dirty.saveUnitId);
      const recoveryPaths = dirty.saveUnitId
        ? (recovery.saveUnitsById[dirty.saveUnitId]?.affectedPaths as JsonPointer[] | undefined)
        : undefined;
      return restoreSaveUnitPatchesFromSaved(dirtyTab, project, savedDocument, recoveryPaths ?? []);
    });
    if (patches.length > 0) {
      executeCommand({
        type: 'project.applyPatch',
        ...MUTATION_SURFACE_ATTRIBUTIONS.discardDirtyUnits,
        label:
          dirtyTabStates.length === 1 && primaryDirtyTab
            ? t('dirtyClose.discardNamed', { title: primaryDirtyTab.title })
            : t('dirtyClose.discardTabs', { count: dirtyTabStates.length }),
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
  const onlyTabLocalDraftResolution =
    dirtyTabStates.length > 0 &&
    dirtyTabStates.every(({ tab: dirtyTab }) => draftOnlyTabIds.has(dirtyTab.id));
  const title =
    closeCount > 1
      ? t('dirtyClose.titleTabs', { count: closeCount })
      : primaryDirtyTab
        ? t('dirtyClose.titleNamed', { title: primaryDirtyTab.title })
        : t('dirtyClose.titleModified');
  const description =
    closeCount > 1
      ? draftOnlyTabIds.size > 0
        ? t('dirtyClose.multipleWithSharedDraft', {
            count: dirtyCount,
            dirtyCount,
            closeCount,
          })
        : t('dirtyClose.multiple', { count: dirtyCount, dirtyCount, closeCount })
      : onlyTabLocalDraftResolution
        ? t('dirtyClose.localDraftOnly')
        : hasDraftDirty
          ? t('dirtyClose.draftAndProject')
          : t('dirtyClose.projectOnly');

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
            {t('dirtyClose.cancel')}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={discardAndClose}
            disabled={pendingTabs.length === 0 || saving}
          >
            {t('dirtyClose.dontSave')}
          </Button>
          <Button
            size="sm"
            onClick={() => void saveAndClose()}
            disabled={pendingTabs.length === 0 || saving || (!hasPersistentDirty && !hasDraftDirty)}
          >
            {saving
              ? t('dirtyClose.saving')
              : onlyTabLocalDraftResolution
                ? t('dirtyClose.apply')
                : t('dirtyClose.save')}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
