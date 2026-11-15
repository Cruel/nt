import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import { candidateReadyToOpen, useCandidateRepairStore } from './candidate-repair-store';
import { useProjectStore } from './project-store';
import { useRepairPromptStore } from './repair-prompt-store';
import { dispatchWorkspaceToolbarCommand } from '@/workspace/workspace-toolbar-events';

function projectDirectoryName(path: string): string {
  return path.split(/[/\\]/u).filter(Boolean).at(-1) ?? path;
}

/** A repaired candidate is never promoted by a watcher or an agent exit.
 * Present one confirmation per ready period, and queue independent candidates. */
export function CandidateRepairReadyDialog({ blocked = false }: { blocked?: boolean }) {
  const { t } = useTranslation('workspace');
  const entries = useCandidateRepairStore((state) => state.entries);
  const repairPromptVisible = useRepairPromptStore((state) => state.visible);
  const activeProjectPath = useProjectStore((state) => state.projectPath);
  const offered = useRef(new Set<string>());
  const [pendingIds, setPendingIds] = useState<string[]>([]);

  useEffect(() => {
    const additions: string[] = [];
    for (const id of offered.current) {
      const entry = entries[id];
      if (!entry || entry.admitted || entry.status?.ready === false) offered.current.delete(id);
    }
    for (const entry of Object.values(entries)) {
      if (!entry.aiRepairRequested || !candidateReadyToOpen(entry) || offered.current.has(entry.id))
        continue;
      offered.current.add(entry.id);
      additions.push(entry.id);
    }
    const stalePending = pendingIds.some(
      (id) => !entries[id] || entries[id].admitted || entries[id].status?.ready === false,
    );
    if (additions.length > 0 || stalePending) {
      setPendingIds((current) => [
        ...current.filter(
          (id) => entries[id] && !entries[id].admitted && entries[id].status?.ready !== false,
        ),
        ...additions,
      ]);
    }
  }, [entries, pendingIds]);

  const candidate = pendingIds
    .map((id) => entries[id])
    .find((entry) => candidateReadyToOpen(entry));
  const visible = !blocked && !repairPromptVisible && Boolean(candidate);

  function dismiss() {
    if (candidate) setPendingIds((current) => current.filter((id) => id !== candidate.id));
  }

  function openProject() {
    if (!visible || !candidate) return;
    const current = useCandidateRepairStore.getState().entries[candidate.id];
    if (!candidateReadyToOpen(current)) return;
    dismiss();
    dispatchWorkspaceToolbarCommand({
      command: 'open-project',
      projectPath: current.root,
      repairCandidateId: current.id,
      readyRevision: current.status.revision,
    });
  }

  return (
    <Dialog open={visible} onOpenChange={(open) => !open && dismiss()}>
      <DialogPopup className="sm:max-w-md">
        <DialogTitle>{t('candidateRepair.ready.title')}</DialogTitle>
        {candidate ? (
          <>
            <DialogDescription>
              {t('candidateRepair.ready.description', {
                project: projectDirectoryName(candidate.root),
              })}
            </DialogDescription>
            <p className="truncate text-xs text-muted-foreground" title={candidate.root}>
              {candidate.root}
            </p>
            {activeProjectPath && activeProjectPath !== candidate.root ? (
              <p className="text-sm text-muted-foreground">
                {t('candidateRepair.ready.switchProject', {
                  project: projectDirectoryName(activeProjectPath),
                })}
              </p>
            ) : null}
          </>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={dismiss}>
            {t('candidateRepair.ready.notNow')}
          </Button>
          <Button onClick={openProject}>{t('candidateRepair.ready.openProject')}</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
