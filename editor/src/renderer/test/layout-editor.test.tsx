import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LayoutEditor } from '@/editors/layouts/LayoutEditor';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import {
  captureWorkbenchTabState,
  clearWorkbenchTabStates,
  setWorkbenchTabState,
  useWorkbenchTabStateStore,
} from '@/workbench/workbench-tab-state';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';

vi.mock('react-resizable-panels', () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Separator: () => <div data-testid="resize-separator" />,
}));

vi.mock('@/preview/DerivedPreviewPane', () => ({
  DerivedPreviewPane: ({ previewDocument }: { previewDocument?: { data?: unknown } }) => (
    <div
      data-preview-document={JSON.stringify(previewDocument?.data ?? null)}
      data-testid="derived-preview"
    />
  ),
}));

vi.mock('@/components/source/SourceEditor', async () => {
  const React = await import('react');
  return {
    SourceEditor: React.forwardRef(function SourceEditor(
      {
        language = 'text',
        value,
        onChange,
      }: { language?: string; value: string; onChange?: (value: string) => void },
      ref: React.ForwardedRef<{
        captureViewState: () => {
          scroll: { scrollTop: number; scrollLeft: number };
          selection: unknown;
        };
        restoreViewState: (state: unknown) => void;
      }>,
    ) {
      const editorRef = React.useRef<HTMLTextAreaElement | null>(null);
      React.useImperativeHandle(ref, () => ({
        captureViewState: () => ({
          scroll: {
            scrollTop: editorRef.current?.scrollTop ?? 0,
            scrollLeft: editorRef.current?.scrollLeft ?? 0,
          },
          selection: {
            ranges: [
              {
                anchor: editorRef.current?.selectionStart ?? 0,
                head: editorRef.current?.selectionEnd ?? 0,
              },
            ],
            main: 0,
          },
        }),
        restoreViewState: (state) => {
          if (
            !editorRef.current ||
            typeof state !== 'object' ||
            state === null ||
            !('scroll' in state)
          )
            return;
          const scroll = (state as { scroll?: { scrollTop?: number; scrollLeft?: number } }).scroll;
          editorRef.current.scrollTop = scroll?.scrollTop ?? 0;
          editorRef.current.scrollLeft = scroll?.scrollLeft ?? 0;
        },
      }));
      return (
        <textarea
          ref={editorRef}
          aria-label={`source-${language}`}
          value={value}
          onChange={(event) => onChange?.(event.currentTarget.value)}
        />
      );
    }),
  };
});

const tab: WorkbenchTab = {
  id: 'tab:layout-detail:layouts:main',
  title: 'Main UI',
  editorType: 'layout-detail',
  resource: {
    kind: 'record',
    stableId: 'record:layouts:main',
    collection: 'layouts',
    entityId: 'main',
  },
};

beforeEach(() => {
  useCommandStore.getState().resetCommandHistory();
  useProjectStore.getState().clearProject();
  clearWorkbenchTabStates();
});

describe('LayoutEditor', () => {
  it('renders typed layout defaults and preview surface', () => {
    const project = createAuthoringProject();
    project.layouts.main = { id: 'main', label: 'Main UI', data: defaultLayoutData('Main UI') };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

    render(<LayoutEditor tab={tab} />);

    expect(screen.getByText('Main UI')).toBeInTheDocument();
    expect(screen.getByText('RML Source')).toBeInTheDocument();
    expect(screen.getByText('RCSS Source')).toBeInTheDocument();
    expect(screen.getByText('Lua Source')).toBeInTheDocument();
    expect(screen.getByTestId('derived-preview')).toBeInTheDocument();
  });

  it('commits source edits immediately through layout.replaceData', async () => {
    const project = createAuthoringProject();
    project.layouts.main = { id: 'main', label: 'Main UI', data: defaultLayoutData('Main UI') };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

    render(<LayoutEditor tab={tab} />);

    const rmlEditor = screen.getByLabelText('source-rml');
    fireEvent.change(rmlEditor, { target: { value: '<div><h1>Changed Layout</h1></div>\n' } });

    await waitFor(() => {
      expect(screen.getByTestId('derived-preview')).toHaveAttribute(
        'data-preview-document',
        expect.stringContaining('Changed Layout'),
      );
      expect(useProjectStore.getState().document).toMatchObject({
        layouts: {
          main: {
            data: {
              rml: { sourceText: '<div><h1>Changed Layout</h1></div>\n' },
            },
          },
        },
      });
    });
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('layout.replaceData');
  });

  it('sets the current layout as the title system layout through commands', async () => {
    const user = userEvent.setup();
    const project = createAuthoringProject();
    project.layouts.main = { id: 'main', label: 'Main UI', data: defaultLayoutData('Main UI') };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

    render(<LayoutEditor tab={tab} />);

    await user.click(screen.getByText('Set as Title UI'));

    expect(useProjectStore.getState().document).toMatchObject({
      settings: {
        ui: { systemLayouts: { title: { $ref: { collection: 'layouts', id: 'main' } } } },
      },
    });
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('project.setSystemLayout');
  });

  it('captures and restores tab state for scroll, split sizes, and local source draft', async () => {
    const project = createAuthoringProject();
    project.layouts.main = { id: 'main', label: 'Main UI', data: defaultLayoutData('Main UI') };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

    const view = render(<LayoutEditor tab={tab} />);
    const scrollContainer = view.container.querySelector<HTMLElement>(
      '[data-layout-editor-scroll]',
    )!;
    scrollContainer.scrollTop = 128;
    scrollContainer.scrollLeft = 12;
    const rmlEditor = screen.getByLabelText('source-rml');
    rmlEditor.scrollTop = 22;
    rmlEditor.scrollLeft = 3;
    fireEvent.change(screen.getByLabelText('source-json'), { target: { value: '{ invalid json' } });

    captureWorkbenchTabState(tab.id);

    const captured = useWorkbenchTabStateStore.getState().tabStatesById[tab.id];
    expect(captured).toMatchObject({
      schema: 'noveltea.editor.tab-state.layout',
      payload: {
        leftScroll: { scrollTop: 128, scrollLeft: 12 },
        horizontalSplit: { sizes: [62, 38] },
        sourceViewStates: {
          rml: { scroll: { scrollTop: 22, scrollLeft: 3 } },
        },
        sampleStateDraft: '{ invalid json',
      },
    });

    view.unmount();
    setWorkbenchTabState(tab.id, {
      schema: 'noveltea.editor.tab-state.layout',
      schemaVersion: 1,
      payload: {
        leftScroll: { scrollTop: 64, scrollLeft: 4 },
        horizontalSplit: { sizes: [70, 30] },
        sourceViewStates: {
          rml: { scroll: { scrollTop: 11, scrollLeft: 2 } },
        },
        sampleStateDraft: '{"restored":true}',
        message: null,
      },
    });

    const restoredView = render(<LayoutEditor tab={tab} />);

    expect(screen.getByLabelText('source-json')).toHaveValue('{"restored":true}');
    await waitFor(() =>
      expect(
        restoredView.container.querySelector<HTMLElement>('[data-layout-editor-scroll]')?.scrollTop,
      ).toBe(64),
    );
    expect(
      restoredView.container.querySelector<HTMLElement>('[data-layout-editor-scroll]')?.scrollLeft,
    ).toBe(4);
    expect(screen.getByLabelText('source-rml').scrollTop).toBe(11);
  });
});
