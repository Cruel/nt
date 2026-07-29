import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { PanelRightClose, PanelRightOpen, PanelTopClose, PanelTopOpen } from 'lucide-react';
import {
  Group,
  Panel,
  usePanelCallbackRef,
  type Layout,
  type LayoutChangedMeta,
} from 'react-resizable-panels';
import { PanelResizeSeparator } from '@/components/resize-separator';
import type { EditorPreviewSplitOrientation } from '@/components/editor-preview-layout';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useEditorPreviewSplitSyncStore } from '@/stores/editor-preview-split-sync-store';
import { usePreferencesStore } from '@/stores/preferences-store';

interface EditorPreviewSplitProps {
  preview: ReactNode;
  children: ReactNode;
  resizeLabel: string;
  orientation?: EditorPreviewSplitOrientation;
  defaultPreviewSize?: string;
  minPreviewSize?: string;
  maxPreviewSize?: string;
  minContentSize?: string;
  defaultContentSize?: string;
  groupKey?: string;
  onLayoutChange?: (sizes: Record<string, number>) => void;
  previewCollapsed?: boolean;
  onPreviewCollapsedChange?: (collapsed: boolean) => void;
  collapsePreviewLabel?: string;
  expandPreviewLabel?: string;
  previewClassName?: string;
  contentClassName?: string;
}

const EDITOR_PREVIEW_SPLIT_SIZES = {
  vertical: {
    defaultPreview: '320px',
    minPreview: '160px',
    maxPreview: '72%',
    minContent: '160px',
  },
  horizontal: {
    defaultPreview: '38%',
    minPreview: '24%',
    maxPreview: undefined,
    minContent: '35%',
  },
} as const;

const PREVIEW_SPLIT_SYNC_EPSILON = 0.01;

function layoutPreviewSize(layout: Layout) {
  const size = layout['editor-preview'];
  return typeof size === 'number' ? size : null;
}

export function EditorPreviewSplit({
  preview,
  children,
  resizeLabel,
  orientation = 'vertical',
  defaultPreviewSize,
  minPreviewSize,
  maxPreviewSize,
  minContentSize,
  defaultContentSize,
  groupKey,
  onLayoutChange,
  previewCollapsed = false,
  onPreviewCollapsedChange,
  collapsePreviewLabel = 'Collapse preview',
  expandPreviewLabel = 'Expand preview',
  previewClassName,
  contentClassName,
}: EditorPreviewSplitProps) {
  const syncSourceId = useId();
  const [previewPanelHandle, previewPanelRef] = usePanelCallbackRef();
  const previewCollapsedRef = useRef(previewCollapsed);
  const localResizeActiveRef = useRef(false);
  const previewCanCollapse = onPreviewCollapsedChange !== undefined;
  const sizes = EDITOR_PREVIEW_SPLIT_SIZES[orientation];
  const savedPreviewSize = usePreferencesStore(
    (state) => state.editorPreviewSplitSizes[orientation],
  );
  const setEditorPreviewSplitSize = usePreferencesStore((state) => state.setEditorPreviewSplitSize);
  const synchronizedPreviewSizeAtRender =
    useEditorPreviewSplitSyncStore.getState().sizes[orientation];
  const latestSharedPreviewSizeRef = useRef<number | null>(
    synchronizedPreviewSizeAtRender ?? savedPreviewSize,
  );

  previewCollapsedRef.current = previewCollapsed;

  const sharedPreviewSize = synchronizedPreviewSizeAtRender ?? savedPreviewSize;
  const resolvedDefaultPreviewSize =
    defaultPreviewSize ??
    (sharedPreviewSize === null ? sizes.defaultPreview : `${sharedPreviewSize}%`);
  const resolvedDefaultContentSize =
    defaultContentSize ??
    (sharedPreviewSize === null ? undefined : `${Number((100 - sharedPreviewSize).toFixed(6))}%`);

  useLayoutEffect(() => {
    const store = useEditorPreviewSplitSyncStore;
    const currentSize = store.getState().sizes[orientation];
    latestSharedPreviewSizeRef.current = currentSize ?? savedPreviewSize;

    const unsubscribe = store.subscribe((state, previousState) => {
      const nextSize = state.sizes[orientation];
      if (nextSize === previousState.sizes[orientation] || nextSize === null) return;
      latestSharedPreviewSizeRef.current = nextSize;
      if (
        state.sourceIds[orientation] === syncSourceId ||
        previewCollapsedRef.current ||
        localResizeActiveRef.current ||
        !previewPanelHandle ||
        previewPanelHandle.isCollapsed()
      )
        return;

      const currentPreviewSize = previewPanelHandle.getSize().asPercentage;
      if (Math.abs(currentPreviewSize - nextSize) > PREVIEW_SPLIT_SYNC_EPSILON) {
        previewPanelHandle.resize(`${nextSize}%`);
      }
    });

    if (currentSize === null && savedPreviewSize !== null) {
      store.getState().setSize(orientation, savedPreviewSize, syncSourceId);
    }
    return unsubscribe;
  }, [orientation, previewPanelHandle, savedPreviewSize, syncSourceId]);

  useLayoutEffect(() => {
    if (!previewPanelHandle) return;
    const currentlyCollapsed = previewPanelHandle.isCollapsed();

    if (previewCollapsed) {
      if (!currentlyCollapsed) previewPanelHandle.collapse();
      return;
    }

    if (currentlyCollapsed) previewPanelHandle.expand();

    const targetSize = latestSharedPreviewSizeRef.current ?? savedPreviewSize;
    if (targetSize === null) return;
    const currentSize = previewPanelHandle.getSize().asPercentage;
    if (Math.abs(currentSize - targetSize) > PREVIEW_SPLIT_SYNC_EPSILON) {
      previewPanelHandle.resize(`${targetSize}%`);
    }
  }, [previewCollapsed, previewPanelHandle, savedPreviewSize]);

  const handleLayoutChange = (nextLayout: Layout) => {
    const previewSize = layoutPreviewSize(nextLayout);
    if (
      previewSize !== null &&
      previewSize > PREVIEW_SPLIT_SYNC_EPSILON &&
      !previewCollapsedRef.current &&
      localResizeActiveRef.current
    ) {
      latestSharedPreviewSizeRef.current = previewSize;
      useEditorPreviewSplitSyncStore.getState().setSize(orientation, previewSize, syncSourceId);
    }
    onLayoutChange?.(nextLayout);
  };

  const handleLayoutChanged = (nextLayout: Layout, meta: LayoutChangedMeta) => {
    if (!meta.isUserInteraction) return;

    const previewSize = layoutPreviewSize(nextLayout);
    const collapsed = previewSize === null || previewSize <= PREVIEW_SPLIT_SYNC_EPSILON;
    if (!collapsed && previewSize !== null) {
      latestSharedPreviewSizeRef.current = previewSize;
      useEditorPreviewSplitSyncStore.getState().setSize(orientation, previewSize, syncSourceId);
      setEditorPreviewSplitSize(orientation, previewSize);
    }
    if (onPreviewCollapsedChange && collapsed !== previewCollapsedRef.current) {
      onPreviewCollapsedChange(collapsed);
    }
    localResizeActiveRef.current = false;
  };

  const ToggleIcon =
    orientation === 'vertical'
      ? previewCollapsed
        ? PanelTopOpen
        : PanelTopClose
      : previewCollapsed
        ? PanelRightOpen
        : PanelRightClose;
  const toggleLabel = previewCollapsed ? expandPreviewLabel : collapsePreviewLabel;
  const togglePreview = () => {
    if (!onPreviewCollapsedChange) return;
    localResizeActiveRef.current = false;

    if (previewCollapsed) {
      if (previewPanelHandle?.isCollapsed()) previewPanelHandle.expand();
      const targetSize = latestSharedPreviewSizeRef.current ?? savedPreviewSize;
      if (previewPanelHandle && targetSize !== null) {
        const currentSize = previewPanelHandle.getSize().asPercentage;
        if (Math.abs(currentSize - targetSize) > PREVIEW_SPLIT_SYNC_EPSILON) {
          previewPanelHandle.resize(`${targetSize}%`);
        }
      }
      onPreviewCollapsedChange(false);
      return;
    }

    if (previewPanelHandle && !previewPanelHandle.isCollapsed()) previewPanelHandle.collapse();
    onPreviewCollapsedChange(true);
  };
  const previewToggle = previewCanCollapse ? (
    <Button
      type="button"
      size="icon-xs"
      variant="secondary"
      className={cn(
        'absolute z-20 cursor-pointer rounded-full border shadow-sm',
        orientation === 'horizontal'
          ? 'right-1 top-1/2 -translate-y-1/2'
          : 'left-1/2 top-1 -translate-x-1/2',
      )}
      aria-label={toggleLabel}
      aria-expanded={!previewCollapsed}
      title={toggleLabel}
      onClick={togglePreview}
    >
      <ToggleIcon className="size-3.5" aria-hidden="true" />
    </Button>
  ) : null;

  const previewPanel = (
    <Panel
      id="editor-preview"
      panelRef={previewPanelRef}
      collapsible={previewCanCollapse}
      collapsedSize="0%"
      defaultSize={resolvedDefaultPreviewSize}
      minSize={minPreviewSize ?? sizes.minPreview}
      maxSize={maxPreviewSize ?? sizes.maxPreview}
    >
      <div className={cn('h-full min-h-0 overflow-hidden bg-black', previewClassName)}>
        {preview}
      </div>
    </Panel>
  );
  const contentPanel = (
    <Panel
      id="editor-content"
      defaultSize={resolvedDefaultContentSize}
      minSize={minContentSize ?? sizes.minContent}
    >
      <div className={cn('relative h-full min-h-0 overflow-hidden', contentClassName)}>
        {children}
        {previewToggle}
      </div>
    </Panel>
  );

  return (
    <Group
      key={groupKey}
      orientation={orientation}
      className="h-full min-h-0 bg-background"
      onLayoutChange={handleLayoutChange}
      onLayoutChanged={handleLayoutChanged}
    >
      {orientation === 'vertical' ? previewPanel : contentPanel}
      <PanelResizeSeparator
        orientation={orientation}
        aria-label={resizeLabel}
        onPointerDownCapture={() => {
          localResizeActiveRef.current = true;
        }}
        onKeyDownCapture={() => {
          localResizeActiveRef.current = true;
        }}
      />
      {orientation === 'vertical' ? contentPanel : previewPanel}
    </Group>
  );
}
