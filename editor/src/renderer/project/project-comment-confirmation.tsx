import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import type { ProjectWorkspaceCommentImpact } from '../../shared/project-workspace/project-workspace-contracts';

export type CommentDecision = 'keep' | 'remove' | 'delete' | 'cancel';
interface PendingConfirmation {
  impacts: readonly ProjectWorkspaceCommentImpact[];
  operationLabel?: string;
  resolve: (decision: CommentDecision) => void;
}
const queue: PendingConfirmation[] = [];
let inlineOwner: string | null = null;
const subscribers = new Set<() => void>();
const subscribe = (listener: () => void) => {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
};
const current = () => queue[0];
function notify() {
  for (const listener of subscribers) listener();
}

/** All editor saves queue one grouped confirmation, including structural commands. */
export function confirmProjectComments(
  impacts: readonly ProjectWorkspaceCommentImpact[],
  operationLabel?: string,
): Promise<CommentDecision> {
  if (impacts.length === 0) return Promise.resolve('keep');
  return new Promise((resolve) => {
    queue.push({ impacts, operationLabel, resolve });
    notify();
  });
}

export function resolveProjectComments(decision: CommentDecision) {
  const pending = queue.shift();
  pending?.resolve(decision);
  notify();
}

export function usePendingProjectComments() {
  return useSyncExternalStore(subscribe, current, current);
}

/** Active deletion dialogs may render the comment choices themselves, avoiding a second modal. */
export function setInlineProjectCommentOwner(owner: string | null) {
  inlineOwner = owner;
  notify();
}

export function ProjectCommentReviewContents({
  impacts,
  onDecision,
}: {
  impacts: readonly ProjectWorkspaceCommentImpact[];
  onDecision: (decision: CommentDecision) => void;
}) {
  const { t } = useTranslation('workspace');
  const deleting = impacts.some((impact) => impact.kind === 'deleted');
  return (
    <>
      <div
        className="max-h-72 space-y-2 overflow-auto rounded border p-2"
        role="list"
        aria-label={t('commentReview.affectedComments')}
      >
        {impacts.map((impact, index) => (
          <div
            key={`${impact.file}:${impact.path}:${index}`}
            role="listitem"
            className="space-y-1 border-b pb-2 last:border-0 last:pb-0"
          >
            <div className="break-all font-mono text-[10px] text-muted-foreground">
              {impact.file}
              {impact.path} · {t(`commentReview.kind.${impact.kind}`)}
            </div>
            <div className="whitespace-pre-wrap break-words text-xs">{impact.comment.trim()}</div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={() => onDecision('cancel')}>
          {t('commentReview.cancel')}
        </Button>
        {deleting ? (
          <Button variant="destructive" onClick={() => onDecision('delete')}>
            {t('commentReview.deleteComments')}
          </Button>
        ) : (
          <>
            <Button variant="outline" onClick={() => onDecision('keep')}>
              {t('commentReview.keepComments')}
            </Button>
            <Button onClick={() => onDecision('remove')}>
              {t('commentReview.removeComments')}
            </Button>
          </>
        )}
      </div>
    </>
  );
}

export function ProjectCommentConfirmationDialog() {
  const { t } = useTranslation('workspace');
  const pending = usePendingProjectComments();
  const inline = useSyncExternalStore(
    subscribe,
    () => inlineOwner,
    () => inlineOwner,
  );
  if (!pending || (inline && pending.operationLabel === inline)) return null;
  const deleting = pending.impacts.some((impact) => impact.kind === 'deleted');
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) resolveProjectComments('cancel');
      }}
    >
      <DialogPopup className="sm:max-w-lg" showCloseButton={false}>
        <DialogTitle>
          {deleting ? t('commentReview.deleteTitle') : t('commentReview.saveTitle')}
        </DialogTitle>
        <DialogDescription>
          {deleting ? t('commentReview.deleteDescription') : t('commentReview.saveDescription')}
        </DialogDescription>
        <ProjectCommentReviewContents
          impacts={pending.impacts}
          onDecision={resolveProjectComments}
        />
      </DialogPopup>
    </Dialog>
  );
}
