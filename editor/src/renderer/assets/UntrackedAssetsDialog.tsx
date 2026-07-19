import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import type { ProjectAssetAuditFile } from '../../shared/project-asset-audit';

interface UntrackedAssetsDialogProps {
  files: ProjectAssetAuditFile[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImportSelected: (paths: string[]) => Promise<void>;
  onDeleteSelected: (paths: string[]) => Promise<void>;
  onIgnoreSelected: (paths: string[]) => void;
}

type PendingAction = 'import' | 'delete' | null;

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UntrackedAssetsDialog({
  files,
  open,
  onOpenChange,
  onImportSelected,
  onDeleteSelected,
  onIgnoreSelected,
}: UntrackedAssetsDialogProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [busy, setBusy] = useState(false);
  const selectedPaths = useMemo(
    () =>
      files.map((file) => file.projectRelativePath).filter((filePath) => selected.has(filePath)),
    [files, selected],
  );

  useEffect(() => {
    setSelected((current) => {
      const available = new Set(files.map((file) => file.projectRelativePath));
      return new Set([...current].filter((filePath) => available.has(filePath)));
    });
  }, [files]);

  function toggle(filePath: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(files.map((file) => file.projectRelativePath)));
  }

  function clearSelection() {
    setSelected(new Set());
  }

  async function confirmAction() {
    if (!pendingAction || selectedPaths.length === 0) return;
    setBusy(true);
    try {
      if (pendingAction === 'import') await onImportSelected(selectedPaths);
      else await onDeleteSelected(selectedPaths);
      setSelected(new Set());
      setPendingAction(null);
    } finally {
      setBusy(false);
    }
  }

  const actionLabel = pendingAction === 'import' ? 'Import' : 'Delete';

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen) onOpenChange(true);
        }}
      >
        <DialogPopup className="max-w-3xl" showCloseButton={false}>
          <DialogTitle>Untracked Asset Files</DialogTitle>
          <DialogDescription>
            NovelTea found files in the project assets folder that are not registered in the
            project. Import them, move them to the project trash, or ignore them for now.
          </DialogDescription>
          <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>
              {files.length} untracked file{files.length === 1 ? '' : 's'} detected
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={selectAll}>
                Select All
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={clearSelection}
              >
                Clear
              </Button>
            </div>
          </div>
          <div className="mt-3 max-h-[50vh] space-y-2 overflow-auto rounded border p-2">
            {files.map((file) => (
              <label
                key={file.projectRelativePath}
                className="flex cursor-pointer items-center gap-3 rounded border p-2 hover:bg-accent/60"
              >
                <input
                  type="checkbox"
                  checked={selected.has(file.projectRelativePath)}
                  onChange={() => toggle(file.projectRelativePath)}
                />
                {file.previewUrl ? (
                  <img
                    src={file.previewUrl}
                    alt=""
                    className="h-14 w-14 shrink-0 rounded object-cover"
                  />
                ) : (
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded bg-muted text-[10px] uppercase text-muted-foreground">
                    {file.kind}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs">{file.projectRelativePath}</div>
                  <div className="mt-1 text-[10px] text-muted-foreground">
                    {file.kind} · {formatBytes(file.byteSize)}
                  </div>
                </div>
              </label>
            ))}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                onIgnoreSelected(
                  selectedPaths.length > 0
                    ? selectedPaths
                    : files.map((file) => file.projectRelativePath),
                );
                onOpenChange(false);
              }}
            >
              Ignore
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={selectedPaths.length === 0}
              onClick={() => setPendingAction('delete')}
            >
              Delete Selected
            </Button>
            <Button
              size="sm"
              disabled={selectedPaths.length === 0}
              onClick={() => setPendingAction('import')}
            >
              Import Selected
            </Button>
          </div>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={pendingAction !== null}
        onOpenChange={(nextOpen) => {
          if (nextOpen) return;
        }}
      >
        <DialogPopup showCloseButton={false}>
          <DialogTitle>{actionLabel} selected files?</DialogTitle>
          <DialogDescription>
            This will {pendingAction === 'import' ? 'import' : 'move to project trash'}{' '}
            {selectedPaths.length} file{selectedPaths.length === 1 ? '' : 's'}. Continue?
          </DialogDescription>
          <div className="mt-2 max-h-32 overflow-auto rounded border p-2 font-mono text-[10px] text-muted-foreground">
            {selectedPaths.slice(0, 8).map((filePath) => (
              <div key={filePath} className="truncate">
                {filePath}
              </div>
            ))}
            {selectedPaths.length > 8 ? <div>+ {selectedPaths.length - 8} more</div> : null}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setPendingAction(null)}
            >
              Cancel
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void confirmAction()}>
              {actionLabel}
            </Button>
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}
