import { useCallback, useEffect, useState } from 'react';
import { PreviewPane, type PreviewHostLease } from '@/preview/preview-host-pool';
import type { PreviewDocument, PreviewMode } from '../../shared/preview-protocol';

export function DerivedPreviewPane({
  ownerTabId,
  previewMode,
  previewDocument,
  paneId = 'main',
  className = 'h-full w-full bg-zinc-950',
  resetBeforeLoad = false,
}: {
  ownerTabId: string;
  previewMode: PreviewMode;
  previewDocument: PreviewDocument;
  paneId?: string;
  className?: string;
  resetBeforeLoad?: boolean;
}) {
  const [lease, setLease] = useState<PreviewHostLease | null>(null);

  const handleLease = useCallback((nextLease: PreviewHostLease | null) => {
    setLease(nextLease);
  }, []);

  useEffect(() => {
    if (!lease) return undefined;

    const reset = resetBeforeLoad ? lease.send((controller) => controller.reset()) : Promise.resolve();
    void reset
      .then(() => lease.send((controller) => controller.setPreviewMode(previewMode)))
      .then(() => lease.send((controller) => controller.loadPreviewDocument(previewDocument)))
      .catch(() => {
        // Lease release and not-yet-connected hosts are expected transient states for pooled previews.
      });
    return undefined;
  }, [lease, previewDocument, previewMode, resetBeforeLoad]);

  return (
    <PreviewPane
      ownerTabId={ownerTabId}
      paneId={paneId}
      policy="pooled-per-tab-group"
      persistence="derived"
      mode={previewMode}
      className={className}
      onLease={handleLease}
    />
  );
}
