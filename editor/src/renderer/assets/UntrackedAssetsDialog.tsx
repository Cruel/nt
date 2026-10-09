import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createEditorFormatters } from '@/i18n/formatting';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import type {
  ProjectAssetAuditFile,
  ProjectAssetOrganizationAction,
} from '../../shared/project-asset-audit';

interface UntrackedAssetsDialogProps {
  files: ProjectAssetAuditFile[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImportSelected: (paths: string[]) => Promise<void>;
  onDeleteSelected: (paths: string[]) => Promise<void>;
  onMoveFile: (path: string, action: ProjectAssetOrganizationAction) => Promise<void>;
}

type PendingAction = 'import' | 'delete' | ProjectAssetOrganizationAction | null;

export function UntrackedAssetsDialog({
  files,
  open,
  onOpenChange,
  onImportSelected,
  onDeleteSelected,
  onMoveFile,
}: UntrackedAssetsDialogProps) {
  const { t, i18n } = useTranslation('workspace');
  const format = createEditorFormatters(i18n.language);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<'media' | 'other'>('media');
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [movePath, setMovePath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const visibleFiles = useMemo(
    () => files.filter((file) => file.importable === (tab === 'media')),
    [files, tab],
  );
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
    setSelected(new Set(visibleFiles.map((file) => file.projectRelativePath)));
  }

  function clearSelection() {
    setSelected(new Set());
  }

  async function confirmAction() {
    if (!pendingAction) return;
    if ((pendingAction === 'import' || pendingAction === 'delete') && selectedPaths.length === 0)
      return;
    setBusy(true);
    try {
      if (pendingAction === 'import') await onImportSelected(selectedPaths);
      else if (pendingAction === 'delete') await onDeleteSelected(selectedPaths);
      else if (movePath) await onMoveFile(movePath, pendingAction);
      setSelected(new Set());
      setPendingAction(null);
      setMovePath(null);
    } finally {
      setBusy(false);
    }
  }

  const actionLabel = pendingAction ? t(`assetDiscovery.actions.${pendingAction}`) : '';

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          onOpenChange(nextOpen);
        }}
      >
        <DialogPopup className="max-w-3xl" showCloseButton>
          <DialogTitle>{t('assetDiscovery.title')}</DialogTitle>
          <DialogDescription>{t('assetDiscovery.description')}</DialogDescription>
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              variant={tab === 'media' ? 'default' : 'outline'}
              onClick={() => {
                setTab('media');
                clearSelection();
              }}
            >
              {t('assetDiscovery.mediaTab', {
                count: files.filter((file) => file.importable).length,
              })}
            </Button>
            <Button
              size="sm"
              variant={tab === 'other' ? 'default' : 'outline'}
              onClick={() => {
                setTab('other');
                clearSelection();
              }}
            >
              {t('assetDiscovery.otherTab', {
                count: files.filter((file) => !file.importable).length,
              })}
            </Button>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>{t('assetDiscovery.fileCount', { count: visibleFiles.length })}</span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={selectAll}>
                {t('assetDiscovery.selectAll')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={clearSelection}
              >
                {t('assetDiscovery.clear')}
              </Button>
            </div>
          </div>
          <div className="mt-3 max-h-[50vh] space-y-2 overflow-auto rounded border p-2">
            {visibleFiles.length === 0 ? (
              <p className="p-3 text-center text-xs text-muted-foreground">
                {t('assetDiscovery.empty')}
              </p>
            ) : null}
            {visibleFiles.map((file) => (
              <div
                key={file.projectRelativePath}
                className="flex items-center gap-3 rounded border p-2 hover:bg-accent/60"
              >
                <input
                  type="checkbox"
                  aria-label={t('assetDiscovery.selectFile', { path: file.projectRelativePath })}
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
                    {file.kind} · {format.fileSize(file.byteSize)}
                  </div>
                  {file.suggestedMove ? (
                    <Button
                      className="mt-1 h-6 px-2 text-[10px]"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setMovePath(file.projectRelativePath);
                        setPendingAction(file.suggestedMove ?? null);
                      }}
                    >
                      {t(`assetDiscovery.actions.${file.suggestedMove}`)}
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
              {t('assetDiscovery.close')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={selectedPaths.length === 0}
              onClick={() => setPendingAction('delete')}
            >
              {t('assetDiscovery.deleteSelected')}
            </Button>
            <Button
              size="sm"
              disabled={selectedPaths.length === 0}
              onClick={() => setPendingAction('import')}
            >
              {t('assetDiscovery.importSelected')}
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
          <DialogTitle>{t('assetDiscovery.confirmTitle', { action: actionLabel })}</DialogTitle>
          <DialogDescription>
            {pendingAction === 'support' || pendingAction === 'correct-folder'
              ? t('assetDiscovery.moveConfirm', { path: movePath })
              : t('assetDiscovery.confirmFiles', { count: selectedPaths.length })}
          </DialogDescription>
          <div className="mt-2 max-h-32 overflow-auto rounded border p-2 font-mono text-[10px] text-muted-foreground">
            {(movePath ? [movePath] : selectedPaths).slice(0, 8).map((filePath) => (
              <div key={filePath} className="truncate">
                {filePath}
              </div>
            ))}
            {selectedPaths.length > 8 && !movePath ? (
              <div>{t('assetDiscovery.moreFiles', { count: selectedPaths.length - 8 })}</div>
            ) : null}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setPendingAction(null);
                setMovePath(null);
              }}
            >
              {t('assetDiscovery.cancel')}
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
