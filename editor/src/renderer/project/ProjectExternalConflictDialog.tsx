import { Button } from '@/components/ui/button';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import type { EditorRecoveryExternalConflict } from '../../shared/project-schema/editor-project-state';

export interface ProjectExternalConflictDialogProps {
  saveUnitId: string | null;
  conflict: EditorRecoveryExternalConflict | null;
  busy?: boolean;
  onUseDisk: () => void;
  onKeepMine: () => void;
}

export function ProjectExternalConflictDialog({
  saveUnitId,
  conflict,
  busy = false,
  onUseDisk,
  onKeepMine,
}: ProjectExternalConflictDialogProps) {
  const { t } = useTranslation('workspace');
  const open = Boolean(saveUnitId && conflict);
  const paths = conflict?.conflictingPaths ?? [];
  return (
    <Dialog open={open}>
      <DialogPopup showCloseButton={false}>
        <DialogTitle>{t('externalConflict.title')}</DialogTitle>
        <DialogDescription>
          {saveUnitId ? t('externalConflict.description', { saveUnitId }) : ''}
        </DialogDescription>
        {paths.length > 0 ? (
          <div className="max-h-40 overflow-auto rounded border p-2 text-xs">
            {paths.map((path) => (
              <div key={path} className="font-mono">
                {path}
              </div>
            ))}
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onUseDisk}>
            {t('externalConflict.useDisk')}
          </Button>
          <Button disabled={busy} onClick={onKeepMine}>
            {t('externalConflict.keepMine')}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
