import type { ReactNode } from 'react';
import { Group, Panel } from 'react-resizable-panels';
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
      orientation={orientation}
      className="h-full min-h-0 bg-background"
      onLayoutChange={(nextSizes) => {
        const previewSize = nextSizes['editor-preview'];
        if (typeof previewSize === 'number') setEditorPreviewSplitSize(orientation, previewSize);
        onLayoutChange?.(nextSizes);
      }}
    >
      {orientation === 'vertical' ? previewPanel : contentPanel}
      <PanelResizeSeparator orientation={orientation} aria-label={resizeLabel} />
      {orientation === 'vertical' ? contentPanel : previewPanel}
    </Group>
  );
}
