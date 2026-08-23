import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkbenchGroup } from '@/workbench/WorkbenchGroup';
import { WorkbenchTabDndContext } from '@/workbench/WorkbenchTabDndContext';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { usePreferencesStore } from '@/stores/preferences-store';
import {
  DEFAULT_EDITOR_PREVIEW_SPLIT_SYNC_SOURCE_IDS,
  DEFAULT_EDITOR_PREVIEW_SPLIT_SYNC_SIZES,
  useEditorPreviewSplitSyncStore,
} from '@/stores/editor-preview-split-sync-store';
import { authoringDependencyGraphService } from '@/project/authoring-dependency-graph-runtime';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { setTabPreviewVisible } from '@/workbench/preview-visibility-command';
import {
  useWorkbenchTabStateStore,
  clearWorkbenchTabStates,
} from '@/workbench/workbench-tab-state';
import type {
  WorkbenchGroup as WorkbenchGroupModel,
  WorkbenchTab,
} from '@/workbench/workbench-types';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import type { PreviewToEditorMessage } from '../../shared/preview-protocol';

const previewControllers = vi.hoisted(() => ({
  created: 0,
  resetCalls: 0,
  setPreviewModeCalls: [] as string[],
  loadPreviewDocumentCalls: [] as Array<{
    kind: string;
    recordId: string;
    revision: string;
    data: Record<string, unknown>;
  }>,
  applyFocusedDocumentCalls: [] as Array<{
    kind: string;
    recordId: string;
    revision: string;
    data: Record<string, unknown>;
  }>,
  nextApplyFocusedPromise: null as Promise<void> | null,
  nextResetPromise: null as Promise<void> | null,
  onMessages: [] as Array<(message: PreviewToEditorMessage) => void>,
}));

vi.mock('@/hooks/use-engine-preview', () => ({
  useEnginePreview: (
    options: {
      onMessage?: (message: PreviewToEditorMessage) => void;
      onReady?: () => void;
    } = {},
  ) => {
    previewControllers.created += 1;
    const hostIndex = previewControllers.created;
    if (options.onMessage) previewControllers.onMessages.push(options.onMessage);
    queueMicrotask(() => {
      options.onReady?.();
      options.onMessage?.({
        version: 1,
        type: 'ready',
        capabilities: [],
        hostGeneration: 1,
        transportGeneration: 1,
        activeShaderVariant: 'glsl-120',
      });
    });
    return {
      iframeRef: { current: null },
      iframeKey: hostIndex,
      iframeSrc: `http://127.0.0.1:5000/?sessionToken=test-token-${hostIndex}`,
      session: null,
      loadSession: vi.fn().mockResolvedValue({
        url: `http://127.0.0.1:5000/?sessionToken=test-token-${hostIndex}`,
        origin: 'http://127.0.0.1:5000',
        sessionToken: `test-token-${hostIndex}`,
      }),
      reset: vi.fn(() => {
        previewControllers.resetCalls += 1;
        const pending = previewControllers.nextResetPromise;
        previewControllers.nextResetPromise = null;
        return pending ?? Promise.resolve();
      }),
      setPreviewWheelRouting: vi.fn().mockResolvedValue(undefined),
      setEngineSettings: vi.fn().mockResolvedValue(undefined),
      setPreviewMode: vi.fn((mode: string) => {
        previewControllers.setPreviewModeCalls.push(mode);
        return Promise.resolve();
      }),
      loadPreviewDocument: vi.fn(
        (document: {
          kind: string;
          recordId: string;
          revision: string;
          data: Record<string, unknown>;
        }) => {
          previewControllers.loadPreviewDocumentCalls.push(document);
          return Promise.resolve();
        },
      ),
      applyFocusedEditorDocument: vi.fn(
        (document: {
          kind: string;
          recordId: string;
          revision: string;
          data: Record<string, unknown>;
        }) => {
          previewControllers.applyFocusedDocumentCalls.push(document);
          const pending = previewControllers.nextApplyFocusedPromise;
          previewControllers.nextApplyFocusedPromise = null;
          return pending ?? Promise.resolve();
        },
      ),
    };
  },
}));

vi.mock('@/components/engine-preview-host', () => ({
  EnginePreviewHost: ({ iframeSrc }: { iframeSrc: string | null }) => (
    <iframe title="NovelTea engine preview" src={iframeSrc ?? undefined} />
  ),
}));

vi.mock('react-resizable-panels', () => ({
  useGroupCallbackRef: () => [null, () => {}],
  usePanelCallbackRef: () => [null, () => {}],
  Group: ({
    children,
    onLayoutChange,
  }: {
    children: React.ReactNode;
    onLayoutChange?: (sizes: Record<string, number>) => void;
  }) => (
    <div data-testid="layout-panel-group">
      <button
        type="button"
        aria-label="mock-layout-split-44-56"
        onClick={() => onLayoutChange?.({ 'editor-content': 44, 'editor-preview': 56 })}
      />
      {children}
    </div>
  ),
  Panel: ({
    children,
    defaultSize,
    id,
  }: {
    children: React.ReactNode;
    defaultSize?: number;
    id?: string;
  }) => (
    <div data-testid="layout-panel" data-panel-id={id} data-default-size={defaultSize}>
      {children}
    </div>
  ),
  Separator: ({ children, ...props }: React.ComponentPropsWithoutRef<'div'>) => (
    <div data-testid="resize-separator" role="separator" {...props}>
      {children}
    </div>
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

const layoutTab: WorkbenchTab = {
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

const roomTab: WorkbenchTab = {
  id: 'tab:room-detail:rooms:room-a',
  title: 'Room A',
  editorType: 'room-detail',
  resource: {
    kind: 'record',
    stableId: 'record:rooms:room-a',
    collection: 'rooms',
    entityId: 'room-a',
  },
};

const nonPreviewTab: WorkbenchTab = {
  id: 'tab:non-preview',
  title: 'Non Preview',
  editorType: 'missing-test-editor',
  resource: { kind: 'tool', stableId: 'tool:non-preview' },
};

function group(
  activeTabId: string | null,
  tabIds: string[] = [layoutTab.id, roomTab.id, nonPreviewTab.id],
): WorkbenchGroupModel {
  return { id: 'root', activeTabId, tabIds };
}

function renderGroup(
  model: WorkbenchGroupModel,
  tabs: WorkbenchTab[] = [layoutTab, roomTab, nonPreviewTab],
) {
  return render(
    <WorkbenchTabDndContext>
      <WorkbenchGroup group={model} tabs={tabs} />
    </WorkbenchTabDndContext>,
  );
}

function rerenderGroup(
  view: ReturnType<typeof render>,
  model: WorkbenchGroupModel,
  tabs: WorkbenchTab[] = [layoutTab, roomTab, nonPreviewTab],
) {
  view.rerender(
    <WorkbenchTabDndContext>
      <WorkbenchGroup group={model} tabs={tabs} />
    </WorkbenchTabDndContext>,
  );
}

function hostElements(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[data-preview-host-id]')];
}

function resetPreviewControllerState() {
  previewControllers.created = 0;
  previewControllers.resetCalls = 0;
  previewControllers.setPreviewModeCalls = [];
  previewControllers.loadPreviewDocumentCalls = [];
  previewControllers.applyFocusedDocumentCalls = [];
  previewControllers.nextApplyFocusedPromise = null;
  previewControllers.nextResetPromise = null;
  previewControllers.onMessages = [];
}

beforeEach(async () => {
  usePreferencesStore.getState().setEditorPreviewLayout('horizontal');
  usePreferencesStore.setState({
    editorPreviewSplitSizes: { vertical: null, horizontal: null },
  });
  useEditorPreviewSplitSyncStore.setState({
    sizes: { ...DEFAULT_EDITOR_PREVIEW_SPLIT_SYNC_SIZES },
    sourceIds: { ...DEFAULT_EDITOR_PREVIEW_SPLIT_SYNC_SOURCE_IDS },
  });
  resetPreviewControllerState();
  useCommandStore.getState().resetCommandHistory();
  useWorkbenchStore.getState().resetWorkbench();
  useProjectStore.getState().clearProject();
  clearWorkbenchTabStates();

  const project = createAuthoringProject();
  project.layouts.main = { id: 'main', label: 'Main UI', data: defaultLayoutData('Main UI') };
  project.rooms['room-a'] = { id: 'room-a', label: 'Room A', data: defaultRoomData('Room A') };
  useProjectStore.getState().loadProjectDocument({
    document: project,
    projectPath: '/mock',
    projectFilePath: '/mock/project.json',
    projectSessionId: '11111111-1111-4111-8111-111111111111',
  });
  await authoringDependencyGraphService.publish(
    useProjectStore.getState().lastMutationPublication!,
  );
});

describe('LayoutEditor persistent layout preview', () => {
  it('claims a dedicated host and sends a complete layout preview payload', async () => {
    const view = renderGroup(group(layoutTab.id));

    await waitFor(() => expect(hostElements(view.container)).toHaveLength(1));
    await waitFor(() =>
      expect(previewControllers.applyFocusedDocumentCalls.at(-1)?.recordId).toBe('main'),
    );

    const payload = previewControllers.applyFocusedDocumentCalls.at(-1);
    expect(previewControllers.resetCalls).toBe(0);
    expect(previewControllers.setPreviewModeCalls).toHaveLength(0);
    expect(payload).toMatchObject({
      kind: 'layout-preview',
      recordId: 'main',
      data: expect.objectContaining({
        schema: 'noveltea.layout-preview',
        contentMode: 'layout',
        layoutId: 'main',
        scalePolicy: { ui: 'inherit', text: 'inherit' },
        environment: expect.objectContaining({
          profile: expect.objectContaining({
            scalePolicy: { ui: 'inherit', text: 'inherit' },
          }),
        }),
        rml: expect.objectContaining({ kind: 'inline' }),
        rcss: expect.objectContaining({ kind: 'inline' }),
        lua: expect.objectContaining({ kind: 'inline' }),
      }),
    });
    expect(payload?.revision).toEqual(expect.any(String));
    expect(hostElements(view.container)[0]).toHaveAttribute('data-preview-host-pane-id', 'main');
    expect(view.container.querySelector('[data-preview-pane-mode="layout"]')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Collapse preview' })).not.toBeInTheDocument();
  });

  it('loads without the obsolete cleanup reset bridge', async () => {
    const view = renderGroup(group(layoutTab.id));

    await waitFor(() =>
      expect(previewControllers.applyFocusedDocumentCalls.at(-1)?.recordId).toBe('main'),
    );
    expect(previewControllers.resetCalls).toBe(0);
    expect(previewControllers.setPreviewModeCalls).toHaveLength(0);
    expect(hostElements(view.container)[0]).toHaveAttribute('data-preview-host-claimed');
  });

  it('keeps the Room iframe warm while Layout claims its own host', async () => {
    const view = renderGroup(group(roomTab.id));

    await waitFor(() =>
      expect(previewControllers.applyFocusedDocumentCalls.at(-1)?.recordId).toBe('room-a'),
    );
    const roomHost = hostElements(view.container)[0]!;
    const roomIframe = roomHost.querySelector('iframe');

    rerenderGroup(view, group(layoutTab.id));

    await waitFor(() =>
      expect(previewControllers.applyFocusedDocumentCalls.at(-1)?.recordId).toBe('main'),
    );
    expect(hostElements(view.container)).toHaveLength(2);
    expect(roomHost).not.toHaveAttribute('data-preview-host-claimed');
    expect(roomHost.querySelector('iframe')).toBe(roomIframe);
    expect(
      hostElements(view.container).find(
        (host) => host.dataset.previewHostOwnerTabId === layoutTab.id,
      ),
    ).toHaveAttribute('data-preview-host-claimed', 'true');
    expect(previewControllers.loadPreviewDocumentCalls).toHaveLength(0);
    expect(previewControllers.applyFocusedDocumentCalls.map((call) => call.kind)).toEqual([
      'room-preview',
      'layout-preview',
    ]);
    expect(previewControllers.setPreviewModeCalls).toHaveLength(0);
    expect(previewControllers.resetCalls).toBe(0);
  });

  it('lets Room use its own host while an inactive Layout apply finishes late', async () => {
    let resolveLayoutApply: (() => void) | null = null;
    previewControllers.nextApplyFocusedPromise = new Promise<void>((resolve) => {
      resolveLayoutApply = resolve;
    });
    const view = renderGroup(group(layoutTab.id));

    await waitFor(() =>
      expect(previewControllers.applyFocusedDocumentCalls.map((call) => call.kind)).toEqual([
        'layout-preview',
      ]),
    );
    const layoutHost = hostElements(view.container)[0]!;

    rerenderGroup(view, group(roomTab.id));

    await waitFor(() =>
      expect(previewControllers.applyFocusedDocumentCalls.map((call) => call.kind)).toEqual([
        'layout-preview',
        'room-preview',
      ]),
    );
    const roomHost = await waitFor(() => {
      const host = hostElements(view.container).find(
        (candidate) => candidate.dataset.previewHostOwnerTabId === roomTab.id,
      );
      expect(host).toHaveAttribute('data-preview-host-visible', 'true');
      return host!;
    });
    expect(hostElements(view.container)).toHaveLength(2);
    expect(layoutHost).not.toHaveAttribute('data-preview-host-claimed');
    expect(roomHost).toHaveAttribute('data-preview-host-pane-id', 'main');

    await act(async () => {
      resolveLayoutApply?.();
      await Promise.resolve();
    });

    expect(previewControllers.applyFocusedDocumentCalls.map((call) => call.kind)).toEqual([
      'layout-preview',
      'room-preview',
    ]);
    expect(roomHost).toHaveAttribute('data-preview-host-visible', 'true');
  });

  it('shares preview size with Room while preserving Layout tab state', async () => {
    const view = renderGroup(group(layoutTab.id));

    await waitFor(() => expect(screen.getAllByLabelText('source-json').at(-1)).toBeInTheDocument());
    const scrollContainer = view.container.querySelector<HTMLElement>(
      '[data-layout-editor-scroll]',
    )!;
    scrollContainer.scrollTop = 128;
    scrollContainer.scrollLeft = 12;
    const rmlEditor = screen.getByLabelText('source-rml');
    rmlEditor.scrollTop = 22;
    rmlEditor.scrollLeft = 3;
    fireEvent.change(screen.getAllByLabelText('source-json').at(-1)!, {
      target: { value: '{ invalid json' },
    });
    act(() => {
      useEditorPreviewSplitSyncStore.getState().setSize('horizontal', 56);
      usePreferencesStore.getState().setEditorPreviewSplitSize('horizontal', 56);
    });

    expect(usePreferencesStore.getState().editorPreviewSplitSizes.horizontal).toBe(56);

    rerenderGroup(view, group(roomTab.id));

    await waitFor(() => {
      expect(
        view.container.querySelector<HTMLElement>('[data-panel-id="editor-preview"]'),
      ).toHaveAttribute('data-default-size', '56%');
    });

    await waitFor(() => {
      expect(useWorkbenchTabStateStore.getState().tabStatesById[layoutTab.id]).toMatchObject({
        schema: 'noveltea.editor.tab-state.layout',
        schemaVersion: 2,
        payload: {
          leftScroll: { scrollTop: 128, scrollLeft: 12 },
          sourceViewStates: {
            rml: { scroll: { scrollTop: 22, scrollLeft: 3 } },
          },
          sampleStateDraft: '{ invalid json',
          previewCollapsed: false,
        },
      });
    });

    rerenderGroup(view, group(layoutTab.id));

    expect(screen.getAllByLabelText('source-json').at(-1)).toHaveValue('{ invalid json');
    await waitFor(() => {
      expect(
        view.container.querySelector<HTMLElement>('[data-panel-id="editor-preview"]'),
      ).toHaveAttribute('data-default-size', '56%');
    });
    await waitFor(() =>
      expect(
        view.container.querySelector<HTMLElement>('[data-layout-editor-scroll]')?.scrollTop,
      ).toBe(128),
    );
    expect(
      view.container.querySelector<HTMLElement>('[data-layout-editor-scroll]')?.scrollLeft,
    ).toBe(12);
    expect(screen.getByLabelText('source-rml').scrollTop).toBe(22);
  });

  it('keeps preview collapse tab-scoped and releases the collapsed host as inactive', async () => {
    const view = renderGroup(group(layoutTab.id));

    const layoutHost = await waitFor(() => {
      const host = hostElements(view.container).find(
        (candidate) => candidate.dataset.previewHostOwnerTabId === layoutTab.id,
      );
      expect(host).toHaveAttribute('data-preview-host-visible', 'true');
      return host!;
    });

    act(() => {
      setTabPreviewVisible(layoutTab, false);
    });

    await waitFor(() => {
      expect(layoutHost).not.toHaveAttribute('data-preview-host-claimed');
      expect(layoutHost).not.toHaveAttribute('data-preview-host-visible');
    });
    expect(hostElements(view.container)).toHaveLength(1);

    rerenderGroup(view, group(roomTab.id));

    await waitFor(() => {
      expect(
        hostElements(view.container).find(
          (candidate) => candidate.dataset.previewHostOwnerTabId === roomTab.id,
        ),
      ).toHaveAttribute('data-preview-host-visible', 'true');
    });
    expect(useWorkbenchTabStateStore.getState().tabStatesById[layoutTab.id]).toMatchObject({
      schema: 'noveltea.editor.tab-state.layout',
      schemaVersion: 2,
      payload: { previewCollapsed: true },
    });

    rerenderGroup(view, group(layoutTab.id));

    await waitFor(() => {
      expect(layoutHost).not.toHaveAttribute('data-preview-host-claimed');
    });

    act(() => {
      setTabPreviewVisible(layoutTab, true);
    });

    await waitFor(() => {
      expect(layoutHost).toHaveAttribute('data-preview-host-visible', 'true');
    });
  });

  it('does not reload the already-active layout preview when the iframe reports interaction', async () => {
    renderGroup(group(layoutTab.id));

    await waitFor(() =>
      expect(previewControllers.applyFocusedDocumentCalls.at(-1)?.recordId).toBe('main'),
    );
    await waitFor(() => expect(previewControllers.onMessages.length).toBeGreaterThan(0));
    const loadCount = previewControllers.applyFocusedDocumentCalls.length;
    const resetCount = previewControllers.resetCalls;

    act(() => {
      previewControllers.onMessages.at(-1)?.({
        version: 1,
        type: 'preview-interacted',
        interaction: 'pointer',
      });
    });

    expect(previewControllers.applyFocusedDocumentCalls).toHaveLength(loadCount);
    expect(previewControllers.resetCalls).toBe(resetCount);
  });

  it('releases the focused layout lease without invoking the obsolete ABI', async () => {
    const view = renderGroup(group(layoutTab.id));

    await waitFor(() => expect(previewControllers.applyFocusedDocumentCalls).toHaveLength(1));

    rerenderGroup(view, group(nonPreviewTab.id));
    await waitFor(() =>
      expect(hostElements(view.container)[0]).not.toHaveAttribute('data-preview-host-claimed'),
    );
    expect(previewControllers.applyFocusedDocumentCalls).toHaveLength(1);
    expect(previewControllers.loadPreviewDocumentCalls).toHaveLength(0);
    expect(previewControllers.setPreviewModeCalls).toHaveLength(0);
  });
});
