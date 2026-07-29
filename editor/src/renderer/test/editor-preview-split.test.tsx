import { useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorPreviewSplit } from '@/components/editor-preview-split';
import {
  DEFAULT_EDITOR_PREVIEW_SPLIT_SIZES,
  usePreferencesStore,
} from '@/stores/preferences-store';

interface MockGroupHandle {
  getLayout: () => Record<string, number>;
  setLayout: (layout: Record<string, number>) => Record<string, number>;
}

vi.mock('react-resizable-panels', async () => {
  return {
    Group: ({
      children,
      groupRef,
      onLayoutChange,
    }: {
      children: ReactNode;
      groupRef?: Ref<MockGroupHandle | null>;
      onLayoutChange?: (layout: Record<string, number>) => void;
    }) => {
      const [layout, setLayout] = useState<Record<string, number>>({
        'editor-content': 62,
        'editor-preview': 38,
      });
      const layoutRef = useRef(layout);
      layoutRef.current = layout;
      const onLayoutChangeRef = useRef(onLayoutChange);
      onLayoutChangeRef.current = onLayoutChange;
      useImperativeHandle(
        groupRef,
        () => ({
          getLayout: () => layoutRef.current,
          setLayout: (nextLayout) => {
            layoutRef.current = nextLayout;
            setLayout(nextLayout);
            onLayoutChangeRef.current?.(nextLayout);
            return nextLayout;
          },
        }),
        [],
      );
      return (
        <div data-testid="preview-split-group">
          <button
            type="button"
            aria-label="resize-preview-to-56"
            onClick={() => {
              const nextLayout = { 'editor-content': 44, 'editor-preview': 56 };
              layoutRef.current = nextLayout;
              setLayout(nextLayout);
              onLayoutChange?.(nextLayout);
            }}
          />
          <output data-testid="preview-size">{layout['editor-preview']}</output>
          {children}
        </div>
      );
    },
    Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Separator: () => <div />,
  };
});

beforeEach(() => {
  usePreferencesStore.setState({
    editorPreviewSplitSizes: { ...DEFAULT_EDITOR_PREVIEW_SPLIT_SIZES },
  });
});

describe('EditorPreviewSplit', () => {
  it('synchronizes live preview resizing across mounted splits with the same orientation', async () => {
    render(
      <div>
        <EditorPreviewSplit
          orientation="horizontal"
          resizeLabel="Resize first"
          preview="First preview"
        >
          First editor
        </EditorPreviewSplit>
        <EditorPreviewSplit
          orientation="horizontal"
          resizeLabel="Resize second"
          preview="Second preview"
        >
          Second editor
        </EditorPreviewSplit>
      </div>,
    );

    const resizeButtons = screen.getAllByLabelText('resize-preview-to-56');
    await act(async () => fireEvent.click(resizeButtons[0]!));

    await waitFor(() => {
      expect(usePreferencesStore.getState().editorPreviewSplitSizes.horizontal).toBe(56);
      expect(screen.getAllByTestId('preview-size')).toHaveLength(2);
      expect(screen.getAllByTestId('preview-size')[1]).toHaveTextContent('56');
    });
  });

  it('does not synchronize a horizontal resize into a vertical split', async () => {
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

    await act(async () => fireEvent.click(screen.getAllByLabelText('resize-preview-to-56')[0]!));

    await waitFor(() => {
      expect(usePreferencesStore.getState().editorPreviewSplitSizes.horizontal).toBe(56);
      expect(usePreferencesStore.getState().editorPreviewSplitSizes.vertical).toBeNull();
      expect(screen.getAllByTestId('preview-size')[1]).toHaveTextContent('38');
    });
  });
});
