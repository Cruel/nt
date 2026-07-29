import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Group, Panel, type GroupImperativeHandle } from 'react-resizable-panels';
import { PanelResizeSeparator } from '@/components/resize-separator';
import type { EditorPreviewSplitOrientation } from '@/components/editor-preview-layout';
import { cn } from '@/lib/utils';
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

function previewSplitLayout(previewSize: number) {
  return {
    'editor-content': Number((100 - previewSize).toFixed(6)),
    'editor-preview': previewSize,
  };
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
  previewClassName,
  contentClassName,
}: EditorPreviewSplitProps) {
  const [groupHandle, setGroupHandle] = useState<GroupImperativeHandle | null>(null);
  const applyingSharedLayoutRef = useRef(false);
  const sizes = EDITOR_PREVIEW_SPLIT_SIZES[orientation];
  const savedPreviewSize = usePreferencesStore(
    (state) => state.editorPreviewSplitSizes[orientation],
  );
  const setEditorPreviewSplitSize = usePreferencesStore((state) => state.setEditorPreviewSplitSize);
  const resolvedDefaultPreviewSize =
    defaultPreviewSize ??
    (savedPreviewSize === null ? sizes.defaultPreview : `${savedPreviewSize}%`);
  const resolvedDefaultContentSize =
    defaultContentSize ??
    (savedPreviewSize === null ? undefined : `${Number((100 - savedPreviewSize).toFixed(6))}%`);

  useLayoutEffect(() => {
    if (!groupHandle || savedPreviewSize === null) return;
    const currentPreviewSize = groupHandle.getLayout()['editor-preview'];
    if (
      typeof currentPreviewSize === 'number' &&
      Math.abs(currentPreviewSize - savedPreviewSize) <= PREVIEW_SPLIT_SYNC_EPSILON
    )
      return;

    applyingSharedLayoutRef.current = true;
    try {
      groupHandle.setLayout(previewSplitLayout(savedPreviewSize));
    } finally {
      applyingSharedLayoutRef.current = false;
    }
  }, [groupHandle, savedPreviewSize]);

  const previewPanel = (
    <Panel
      id="editor-preview"
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
      <div className={cn('h-full min-h-0 overflow-hidden', contentClassName)}>{children}</div>
    </Panel>
  );
  return (
    <Group
      key={groupKey}
      groupRef={setGroupHandle}
      orientation={orientation}
      className="h-full min-h-0 bg-background"
      onLayoutChange={(nextSizes) => {
        const previewSize = nextSizes['editor-preview'];
        if (typeof previewSize === 'number' && !applyingSharedLayoutRef.current) {
          const currentSavedSize =
            usePreferencesStore.getState().editorPreviewSplitSizes[orientation];
          if (
            currentSavedSize === null ||
            Math.abs(currentSavedSize - previewSize) > PREVIEW_SPLIT_SYNC_EPSILON
          )
            setEditorPreviewSplitSize(orientation, previewSize);
        }
        onLayoutChange?.(nextSizes);
      }}
    >
      {orientation === 'vertical' ? previewPanel : contentPanel}
      <PanelResizeSeparator orientation={orientation} aria-label={resizeLabel} />
      {orientation === 'vertical' ? contentPanel : previewPanel}
    </Group>
  );
}
