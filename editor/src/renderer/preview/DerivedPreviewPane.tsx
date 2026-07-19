import { useCallback, useEffect, useMemo, useState } from 'react';
import { PreviewPane, type PreviewHostLease } from '@/preview/preview-host-pool';
import type { PreviewDocument, PreviewMode } from '../../shared/preview-protocol';
import { usePreferencesStore } from '@/stores/preferences-store';
import { useProjectStore } from '@/project/project-store';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import { projectSettingsFromProject } from '../../shared/project-schema/authoring-project-settings';
import { effectivePreviewDisplay, referencePreviewSize } from '../../shared/preview-display';

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
  const previewDisplay = usePreferencesStore((state) => state.previewDisplay);
  const projectDocument = useProjectStore((state) => state.document);
  const projectDisplay = useMemo(
    () =>
      isAuthoringProject(projectDocument)
        ? projectSettingsFromProject(projectDocument).display
        : undefined,
    [projectDocument],
  );
  const effectiveDisplay = useMemo(
    () => effectivePreviewDisplay(previewDisplay, projectDisplay),
    [previewDisplay, projectDisplay],
  );
  const [lease, setLease] = useState<PreviewHostLease | null>(null);

  const handleLease = useCallback((nextLease: PreviewHostLease | null) => {
    setLease(nextLease);
  }, []);

  useEffect(() => {
    if (!lease) return undefined;

    const logicalSize =
      previewDisplay.scaling.pooled === 'reference'
        ? referencePreviewSize(effectiveDisplay, previewDisplay.scaling.referenceLongAxis)
        : null;
    void lease
      .send(
        (controller) =>
          controller.setPreviewDisplayProfile?.(effectiveDisplay, {
            mode: previewDisplay.scaling.pooled,
            logicalSize,
          }) ?? Promise.resolve(),
      )
      .then(() =>
        resetBeforeLoad ? lease.send((controller) => controller.reset()) : Promise.resolve(),
      )
      .then(() => lease.send((controller) => controller.setPreviewMode(previewMode)))
      .then(() => lease.send((controller) => controller.loadPreviewDocument(previewDocument)))
      .then(() => lease.reveal())
      .catch(() => {
        // Lease release and not-yet-connected hosts are expected transient states for pooled previews.
      });
    return undefined;
  }, [effectiveDisplay, lease, previewDisplay, previewDocument, previewMode, resetBeforeLoad]);

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
