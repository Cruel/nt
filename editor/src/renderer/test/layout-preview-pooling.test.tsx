import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkbenchGroup } from '@/workbench/WorkbenchGroup';
import { WorkbenchTabDndContext } from '@/workbench/WorkbenchTabDndContext';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { useWorkbenchTabStateStore, clearWorkbenchTabStates } from '@/workbench/workbench-tab-state';
import type { WorkbenchGroup as WorkbenchGroupModel, WorkbenchTab } from '@/workbench/workbench-types';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';

const previewControllers = vi.hoisted(() => ({
  created: 0,
  resetCalls: 0,
  setPreviewModeCalls: [] as string[],
  loadPreviewDocumentCalls: [] as Array<{ kind: string; recordId: string; revision: string; data: Record<string, unknown> }>,
  nextResetPromise: null as Promise<void> | null,
  onMessages: [] as Array<(message: { version: 1; type: 'preview-interacted'; interaction: 'pointer' | 'focus' }) => void>,
}));

vi.mock('@/hooks/use-engine-preview', () => ({
  useEnginePreview: (options: { onMessage?: (message: { version: 1; type: 'preview-interacted'; interaction: 'pointer' | 'focus' }) => void } = {}) => {
    previewControllers.created += 1;
    const hostIndex = previewControllers.created;
    if (options.onMessage) previewControllers.onMessages.push(options.onMessage);
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
      setPreviewMode: vi.fn((mode: string) => {
        previewControllers.setPreviewModeCalls.push(mode);
        return Promise.resolve();
      }),
      loadPreviewDocument: vi.fn((document: { kind: string; recordId: string; revision: string; data: Record<string, unknown> }) => {
        previewControllers.loadPreviewDocumentCalls.push(document);
        return Promise.resolve();
      }),
    };
  },
}));

vi.mock('@/components/engine-preview-host', () => ({
  EnginePreviewHost: ({ iframeSrc }: { iframeSrc: string | null }) => (
    <iframe title="NovelTea engine preview" src={iframeSrc ?? undefined} />
  ),
}));

vi.mock('react-resizable-panels', () => ({
  Group: ({ children, onLayoutChange }: { children: React.ReactNode; onLayoutChange?: (sizes: Record<string, number>) => void }) => (
    <div data-testid="layout-panel-group">
      <button type="button" aria-label="mock-layout-split-44-56" onClick={() => onLayoutChange?.({ left: 44, right: 56 })} />
      {children}
    </div>
  ),
  Panel: ({ children, defaultSize }: { children: React.ReactNode; defaultSize?: number }) => <div data-testid="layout-panel" data-default-size={defaultSize}>{children}</div>,
  Separator: () => <div data-testid="resize-separator" />,
}));

vi.mock('@/components/source/SourceEditor', async () => {
  const React = await import('react');
  return {
    SourceEditor: React.forwardRef(function SourceEditor(
      { language = 'text', value, onChange }: { language?: string; value: string; onChange?: (value: string) => void },
      ref: React.ForwardedRef<{ captureViewState: () => { scroll: { scrollTop: number; scrollLeft: number }; selection: unknown }; restoreViewState: (state: unknown) => void }>,
    ) {
      const editorRef = React.useRef<HTMLTextAreaElement | null>(null);
      React.useImperativeHandle(ref, () => ({
        captureViewState: () => ({
          scroll: {
            scrollTop: editorRef.current?.scrollTop ?? 0,
            scrollLeft: editorRef.current?.scrollLeft ?? 0,
          },
          selection: { ranges: [{ anchor: editorRef.current?.selectionStart ?? 0, head: editorRef.current?.selectionEnd ?? 0 }], main: 0 },
        }),
        restoreViewState: (state) => {
          if (!editorRef.current || typeof state !== 'object' || state === null || !('scroll' in state)) return;
          const scroll = (state as { scroll?: { scrollTop?: number; scrollLeft?: number } }).scroll;
          editorRef.current.scrollTop = scroll?.scrollTop ?? 0;
          editorRef.current.scrollLeft = scroll?.scrollLeft ?? 0;
        },
      }));
      return <textarea ref={editorRef} aria-label={`source-${language}`} value={value} onChange={(event) => onChange?.(event.currentTarget.value)} />;
    }),
  };
});

const layoutTab: WorkbenchTab = {
  id: 'tab:layout-detail:layouts:main',
  title: 'Main UI',
  editorType: 'layout-detail',
  resource: { kind: 'record', stableId: 'record:layouts:main', collection: 'layouts', entityId: 'main' },
};

const roomTab: WorkbenchTab = {
  id: 'tab:room-detail:rooms:room-a',
  title: 'Room A',
  editorType: 'room-detail',
  resource: { kind: 'record', stableId: 'record:rooms:room-a', collection: 'rooms', entityId: 'room-a' },
};

const nonPreviewTab: WorkbenchTab = {
  id: 'tab:non-preview',
  title: 'Non Preview',
  editorType: 'missing-test-editor',
  resource: { kind: 'tool', stableId: 'tool:non-preview' },
};

function group(activeTabId: string | null, tabIds: string[] = [layoutTab.id, roomTab.id, nonPreviewTab.id]): WorkbenchGroupModel {
  return { id: 'root', activeTabId, tabIds };
}

function renderGroup(model: WorkbenchGroupModel, tabs: WorkbenchTab[] = [layoutTab, roomTab, nonPreviewTab]) {
  return render(
    <WorkbenchTabDndContext>
      <WorkbenchGroup group={model} tabs={tabs} />
    </WorkbenchTabDndContext>,
  );
}

function rerenderGroup(view: ReturnType<typeof render>, model: WorkbenchGroupModel, tabs: WorkbenchTab[] = [layoutTab, roomTab, nonPreviewTab]) {
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
  previewControllers.nextResetPromise = null;
  previewControllers.onMessages = [];
}

beforeEach(() => {
  resetPreviewControllerState();
  useCommandStore.getState().resetCommandHistory();
  useWorkbenchStore.getState().resetWorkbench();
  useProjectStore.getState().clearProject();
  clearWorkbenchTabStates();

  const project = createAuthoringProject();
  project.layouts.main = { id: 'main', label: 'Main UI', tags: [], data: defaultLayoutData('Main UI') };
  project.rooms['room-a'] = { id: 'room-a', label: 'Room A', tags: [], data: defaultRoomData('Room A') };
  useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });
});

describe('LayoutEditor pooled layout preview', () => {
  it('claims a pooled host and sends a complete layout preview payload', async () => {
    const view = renderGroup(group(layoutTab.id));

    await waitFor(() => expect(hostElements(view.container)).toHaveLength(1));
    await waitFor(() => expect(previewControllers.loadPreviewDocumentCalls.at(-1)?.recordId).toBe('main'));

    const payload = previewControllers.loadPreviewDocumentCalls.at(-1);
    expect(previewControllers.resetCalls).toBe(1);
    expect(previewControllers.setPreviewModeCalls.at(-1)).toBe('layout');
    expect(payload).toMatchObject({
      kind: 'layout-preview',
      recordId: 'main',
      data: expect.objectContaining({
        schema: 'noveltea.layout-preview.v1',
        layoutId: 'main',
        rml: expect.objectContaining({ sourceMode: 'inline' }),
        rcss: expect.objectContaining({ sourceMode: 'inline' }),
        lua: expect.objectContaining({ sourceMode: 'inline' }),
      }),
    });
    expect(payload?.revision).toEqual(expect.any(String));
    expect(hostElements(view.container)[0]).toHaveAttribute('data-preview-host-pane-id', 'main');
    expect(view.container.querySelector('[data-preview-pane-mode="layout"]')).toBeInTheDocument();
  });

  it('resets and replaces stale Room preview state before loading a layout payload', async () => {
    const view = renderGroup(group(roomTab.id));

    await waitFor(() => expect(previewControllers.loadPreviewDocumentCalls.at(-1)?.recordId).toBe('room-a'));
    const firstHostId = hostElements(view.container)[0]?.dataset.previewHostId;

    rerenderGroup(view, group(layoutTab.id));

    await waitFor(() => expect(previewControllers.loadPreviewDocumentCalls.at(-1)?.recordId).toBe('main'));
    expect(hostElements(view.container)).toHaveLength(1);
    expect(hostElements(view.container)[0]?.dataset.previewHostId).toBe(firstHostId);
    expect(previewControllers.loadPreviewDocumentCalls.map((call) => call.kind)).toEqual(['room-preview', 'layout-preview']);
    expect(previewControllers.setPreviewModeCalls).toEqual(['room', 'layout']);
    expect(previewControllers.resetCalls).toBe(1);
  });

  it('preserves layout tab state when switching away and back', async () => {
    const view = renderGroup(group(layoutTab.id));

    await waitFor(() => expect(screen.getByLabelText('source-json')).toBeInTheDocument());
    const scrollContainer = view.container.querySelector<HTMLElement>('[data-layout-editor-scroll]')!;
    scrollContainer.scrollTop = 128;
    scrollContainer.scrollLeft = 12;
    const rmlEditor = screen.getByLabelText('source-rml');
    rmlEditor.scrollTop = 22;
    rmlEditor.scrollLeft = 3;
    fireEvent.change(screen.getByLabelText('source-json'), { target: { value: '{ invalid json' } });
    fireEvent.click(screen.getByLabelText('mock-layout-split-44-56'));

    rerenderGroup(view, group(nonPreviewTab.id));

    await waitFor(() => {
      expect(useWorkbenchTabStateStore.getState().tabStatesById[layoutTab.id]).toMatchObject({
        schema: 'noveltea.editor.tab-state.layout',
        payload: {
          leftScroll: { scrollTop: 128, scrollLeft: 12 },
          horizontalSplit: { sizes: [44, 56] },
          sourceViewStates: {
            rml: { scroll: { scrollTop: 22, scrollLeft: 3 } },
          },
          sampleStateDraft: '{ invalid json',
        },
      });
    });

    rerenderGroup(view, group(layoutTab.id));

    expect(screen.getByLabelText('source-json')).toHaveValue('{ invalid json');
    await waitFor(() => {
      const panels = view.container.querySelectorAll<HTMLElement>('[data-testid="layout-panel"]');
      expect(panels[0]).toHaveAttribute('data-default-size', '44');
      expect(panels[1]).toHaveAttribute('data-default-size', '56');
    });
    await waitFor(() => expect(view.container.querySelector<HTMLElement>('[data-layout-editor-scroll]')?.scrollTop).toBe(128));
    expect(view.container.querySelector<HTMLElement>('[data-layout-editor-scroll]')?.scrollLeft).toBe(12);
    expect(screen.getByLabelText('source-rml').scrollTop).toBe(22);
  });

  it('does not reload the already-active layout preview when the iframe reports interaction', async () => {
    renderGroup(group(layoutTab.id));

    await waitFor(() => expect(previewControllers.loadPreviewDocumentCalls.at(-1)?.recordId).toBe('main'));
    await waitFor(() => expect(previewControllers.onMessages.length).toBeGreaterThan(0));
    const loadCount = previewControllers.loadPreviewDocumentCalls.length;
    const resetCount = previewControllers.resetCalls;

    act(() => {
      previewControllers.onMessages.at(-1)?.({ version: 1, type: 'preview-interacted', interaction: 'pointer' });
    });

    expect(previewControllers.loadPreviewDocumentCalls).toHaveLength(loadCount);
    expect(previewControllers.resetCalls).toBe(resetCount);
  });

  it('ignores stale layout sends after the layout preview releases its lease', async () => {
    const releaseLayoutResetRef: { current: (() => void) | null } = { current: null };
    previewControllers.nextResetPromise = new Promise<void>((resolve) => {
      releaseLayoutResetRef.current = resolve;
    });
    const view = renderGroup(group(layoutTab.id));

    await waitFor(() => expect(previewControllers.resetCalls).toBe(1));
    expect(previewControllers.loadPreviewDocumentCalls).toHaveLength(0);

    rerenderGroup(view, group(nonPreviewTab.id));
    await waitFor(() => expect(hostElements(view.container)[0]).not.toHaveAttribute('data-preview-host-claimed'));
    releaseLayoutResetRef.current?.();

    await Promise.resolve();
    expect(previewControllers.loadPreviewDocumentCalls).toHaveLength(0);
    expect(previewControllers.setPreviewModeCalls).toHaveLength(0);
  });
});
