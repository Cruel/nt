import {
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EditorPreviewSplit } from '@/components/editor-preview-split';
import {
  DEFAULT_EDITOR_PREVIEW_SPLIT_SYNC_SOURCE_IDS,
  DEFAULT_EDITOR_PREVIEW_SPLIT_SYNC_SIZES,
  useEditorPreviewSplitSyncStore,
} from '@/stores/editor-preview-split-sync-store';
import { usePreferencesStore } from '@/stores/preferences-store';

interface MockPanelHandle {
  collapse: () => void;
  expand: () => void;
  getSize: () => { asPercentage: number; inPixels: number };
  isCollapsed: () => boolean;
  resize: (size: number | string) => void;
}

vi.mock('react-resizable-panels', async () => {
  const React = await import('react');
  return {
    usePanelCallbackRef: () => React.useState<MockPanelHandle | null>(null),
    Group: ({
      children,
      onLayoutChange,
      onLayoutChanged,
    }: {
      children: ReactNode;
      onLayoutChange?: (layout: Record<string, number>) => void;
      onLayoutChanged?: (
        layout: Record<string, number>,
        meta: { isUserInteraction: boolean },
      ) => void;
    }) => {
      const [layout, setLayout] = useState<Record<string, number>>({
        'editor-content': 62,
        'editor-preview': 38,
      });
      const layoutRef = useRef(layout);
      layoutRef.current = layout;
      const onLayoutChangeRef = useRef(onLayoutChange);
      const onLayoutChangedRef = useRef(onLayoutChanged);
      onLayoutChangeRef.current = onLayoutChange;
      onLayoutChangedRef.current = onLayoutChanged;

      const applyLayout = (nextLayout: Record<string, number>, completed: boolean) => {
        layoutRef.current = nextLayout;
        setLayout(nextLayout);
        onLayoutChangeRef.current?.(nextLayout);
        if (completed) {
          onLayoutChangedRef.current?.(nextLayout, { isUserInteraction: true });
        }
      };

      useLayoutEffect(() => {
        onLayoutChangeRef.current?.(layoutRef.current);
      }, []);

      return (
        <div data-testid="preview-split-group">
          <button
            type="button"
            aria-label="mock-live-preview-56"
            onClick={() => applyLayout({ 'editor-content': 44, 'editor-preview': 56 }, false)}
          />
          <button
            type="button"
            aria-label="mock-finish-preview-56"
            onClick={() => applyLayout({ 'editor-content': 44, 'editor-preview': 56 }, true)}
          />
          <button
            type="button"
            aria-label="mock-live-preview-30"
            onClick={() => applyLayout({ 'editor-content': 70, 'editor-preview': 30 }, false)}
          />
          <button
            type="button"
            aria-label="mock-finish-preview-0"
            onClick={() => applyLayout({ 'editor-content': 100, 'editor-preview': 0 }, true)}
          />
          <output data-testid="preview-size">{layout['editor-preview']}</output>
          {children}
        </div>
      );
    },
    Panel: ({
      children,
      defaultSize,
      id,
      maxSize,
      minSize,
      panelRef,
    }: {
      children: ReactNode;
      defaultSize?: number | string;
      id?: string;
      maxSize?: number | string;
      minSize?: number | string;
      panelRef?: Ref<MockPanelHandle | null>;
    }) => {
      const initialSize = Number.parseFloat(String(defaultSize ?? 38));
      const [collapsed, setCollapsed] = useState(false);
      const [size, setSize] = useState(initialSize);
      const collapsedRef = useRef(collapsed);
      const sizeRef = useRef(size);
      collapsedRef.current = collapsed;
      sizeRef.current = size;
      useImperativeHandle(
        panelRef,
        () => ({
          collapse: () => {
            collapsedRef.current = true;
            setCollapsed(true);
          },
          expand: () => {
            collapsedRef.current = false;
            setCollapsed(false);
          },
          getSize: () => ({
            asPercentage: collapsedRef.current ? 0 : sizeRef.current,
            inPixels: collapsedRef.current ? 0 : sizeRef.current * 10,
          }),
          isCollapsed: () => collapsedRef.current,
          resize: (nextSize) => {
            const parsed = Number.parseFloat(String(nextSize));
            sizeRef.current = parsed;
            setSize(parsed);
          },
        }),
        [],
      );
      return (
        <div
          data-panel-id={id}
          data-collapsed={collapsed ? 'true' : 'false'}
          data-default-size={defaultSize}
          data-max-size={maxSize}
          data-min-size={minSize}
          data-size={size}
        >
          {children}
        </div>
      );
    },
    Separator: ({ children, ...props }: React.ComponentPropsWithoutRef<'div'>) => (
      <div data-testid="preview-split-separator" role="separator" {...props}>
        {children}
      </div>
    ),
  };
});

beforeEach(() => {
  usePreferencesStore.setState({
    editorPreviewSplitSizes: { vertical: 38, horizontal: 38 },
  });
  useEditorPreviewSplitSyncStore.setState({
    sizes: { ...DEFAULT_EDITOR_PREVIEW_SPLIT_SYNC_SIZES },
    sourceIds: { ...DEFAULT_EDITOR_PREVIEW_SPLIT_SYNC_SOURCE_IDS },
  });
});

describe('EditorPreviewSplit', () => {
  it('uses the native panel collapse state and restores the latest shared size', async () => {
    function Harness() {
      const [collapsed, setCollapsed] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setCollapsed(true)}>
            Set collapsed
          </button>
          <button type="button" onClick={() => setCollapsed(false)}>
            Set expanded
          </button>
          <EditorPreviewSplit
            orientation="horizontal"
            resizeLabel="Resize preview"
            previewCollapsed={collapsed}
            onPreviewCollapsedChange={setCollapsed}
            preview="Preview"
          >
            Editor
          </EditorPreviewSplit>
        </>
      );
    }

    const view = render(<Harness />);
    const previewPanel = view.container.querySelector('[data-panel-id="editor-preview"]')!;

    expect(screen.queryByRole('button', { name: 'Collapse preview' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Set collapsed' }));
    await waitFor(() => {
      expect(previewPanel).toHaveAttribute('data-collapsed', 'true');
      expect(screen.queryByRole('separator', { name: 'Resize preview' })).not.toBeInTheDocument();
    });

    act(() => useEditorPreviewSplitSyncStore.getState().setSize('horizontal', 56));
    expect(previewPanel).toHaveAttribute('data-collapsed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Set expanded' }));
    await waitFor(() => {
      expect(previewPanel).toHaveAttribute('data-collapsed', 'false');
      expect(previewPanel).toHaveAttribute('data-size', '56');
      expect(screen.getByRole('separator', { name: 'Resize preview' })).toBeInTheDocument();
    });
  });

  it('mirrors a live native resize but persists only when the interaction completes', async () => {
    const view = render(
      <div>
        <EditorPreviewSplit orientation="horizontal" resizeLabel="Resize first" preview="First">
          First editor
        </EditorPreviewSplit>
        <EditorPreviewSplit orientation="horizontal" resizeLabel="Resize second" preview="Second">
          Second editor
        </EditorPreviewSplit>
      </div>,
    );

    const groups = screen.getAllByTestId('preview-split-group');
    fireEvent.pointerDown(screen.getByRole('separator', { name: 'Resize first' }), {
      pointerId: 1,
    });
    fireEvent.click(within(groups[0]!).getByRole('button', { name: 'mock-live-preview-56' }));

    await waitFor(() => {
      const previewPanels = view.container.querySelectorAll('[data-panel-id="editor-preview"]');
      expect(screen.getAllByTestId('preview-size').map((node) => node.textContent)).toEqual([
        '56',
        '38',
      ]);
      expect(previewPanels[1]).toHaveAttribute('data-size', '56');
      expect(usePreferencesStore.getState().editorPreviewSplitSizes.horizontal).toBe(38);
    });

    fireEvent.click(within(groups[0]!).getByRole('button', { name: 'mock-finish-preview-56' }));
    await waitFor(() =>
      expect(usePreferencesStore.getState().editorPreviewSplitSizes.horizontal).toBe(56),
    );
  });

  it('does not apply mirrored layouts while the tab-local preview is collapsed', async () => {
    function Harness() {
      const [collapsed, setCollapsed] = useState(true);
      return (
        <div>
          <button type="button" onClick={() => setCollapsed(false)}>
            Set first expanded
          </button>
          <EditorPreviewSplit
            orientation="horizontal"
            resizeLabel="Resize first"
            previewCollapsed={collapsed}
            onPreviewCollapsedChange={setCollapsed}
            preview="First"
          >
            First editor
          </EditorPreviewSplit>
          <EditorPreviewSplit orientation="horizontal" resizeLabel="Resize second" preview="Second">
            Second editor
          </EditorPreviewSplit>
        </div>
      );
    }

    const view = render(<Harness />);
    const groups = screen.getAllByTestId('preview-split-group');
    const firstPreviewPanel = view.container.querySelector('[data-panel-id="editor-preview"]')!;

    await waitFor(() => expect(firstPreviewPanel).toHaveAttribute('data-collapsed', 'true'));
    fireEvent.pointerDown(screen.getByRole('separator', { name: 'Resize second' }), {
      pointerId: 2,
    });
    fireEvent.click(within(groups[1]!).getByRole('button', { name: 'mock-live-preview-56' }));

    await waitFor(() => {
      expect(screen.getAllByTestId('preview-size')[0]).toHaveTextContent('38');
      expect(screen.getAllByTestId('preview-size')[1]).toHaveTextContent('56');
      expect(firstPreviewPanel).toHaveAttribute('data-collapsed', 'true');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Set first expanded' }));
    await waitFor(() => {
      expect(firstPreviewPanel).toHaveAttribute('data-size', '56');
      expect(firstPreviewPanel).toHaveAttribute('data-collapsed', 'false');
    });
  });

  it('keeps vertical peer synchronization in the same direction when drag ownership changes', async () => {
    const view = render(
      <div>
        <EditorPreviewSplit orientation="vertical" resizeLabel="Resize first" preview="First">
          First editor
        </EditorPreviewSplit>
        <EditorPreviewSplit orientation="vertical" resizeLabel="Resize second" preview="Second">
          Second editor
        </EditorPreviewSplit>
      </div>,
    );
    const groups = screen.getAllByTestId('preview-split-group');
    const previewPanels = view.container.querySelectorAll('[data-panel-id="editor-preview"]');

    fireEvent.pointerDown(screen.getByRole('separator', { name: 'Resize first' }), {
      pointerId: 5,
    });
    fireEvent.click(within(groups[0]!).getByRole('button', { name: 'mock-live-preview-56' }));
    fireEvent.click(within(groups[0]!).getByRole('button', { name: 'mock-finish-preview-56' }));

    await waitFor(() => expect(previewPanels[1]).toHaveAttribute('data-size', '56'));

    fireEvent.pointerDown(screen.getByRole('separator', { name: 'Resize second' }), {
      pointerId: 6,
    });
    fireEvent.click(within(groups[1]!).getByRole('button', { name: 'mock-live-preview-30' }));

    await waitFor(() => {
      expect(previewPanels[0]).toHaveAttribute('data-size', '30');
      expect(useEditorPreviewSplitSyncStore.getState().sizes.vertical).toBe(30);
    });
  });

  it('adopts a native drag-collapse transition as tab-local state', async () => {
    function Harness() {
      const [collapsed, setCollapsed] = useState(false);
      return (
        <EditorPreviewSplit
          orientation="vertical"
          resizeLabel="Resize preview"
          previewCollapsed={collapsed}
          onPreviewCollapsedChange={setCollapsed}
          preview="Preview"
        >
          Editor
        </EditorPreviewSplit>
      );
    }

    render(<Harness />);
    const group = screen.getByTestId('preview-split-group');
    fireEvent.pointerDown(screen.getByRole('separator', { name: 'Resize preview' }), {
      pointerId: 3,
    });
    fireEvent.click(within(group).getByRole('button', { name: 'mock-finish-preview-0' }));

    await waitFor(() => {
      expect(document.querySelector('[data-panel-id="editor-preview"]')).toHaveAttribute(
        'data-collapsed',
        'true',
      );
      expect(usePreferencesStore.getState().editorPreviewSplitSizes.vertical).toBe(38);
    });
  });

  it('keeps horizontal and vertical synchronization independent', async () => {
    render(
      <div>
        <EditorPreviewSplit orientation="horizontal" resizeLabel="Resize horizontal" preview="H">
          Horizontal editor
        </EditorPreviewSplit>
        <EditorPreviewSplit orientation="vertical" resizeLabel="Resize vertical" preview="V">
          Vertical editor
        </EditorPreviewSplit>
      </div>,
    );

    const groups = screen.getAllByTestId('preview-split-group');
    fireEvent.pointerDown(screen.getByRole('separator', { name: 'Resize horizontal' }), {
      pointerId: 4,
    });
    fireEvent.click(within(groups[0]!).getByRole('button', { name: 'mock-live-preview-56' }));

    await waitFor(() => {
      expect(screen.getAllByTestId('preview-size')[0]).toHaveTextContent('56');
      expect(screen.getAllByTestId('preview-size')[1]).toHaveTextContent('38');
    });
  });
});
