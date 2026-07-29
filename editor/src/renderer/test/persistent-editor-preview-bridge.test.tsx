import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, render, screen, waitFor } from '@testing-library/react';
import { Workbench } from '@/workbench/Workbench';
import { useProjectStore } from '@/project/project-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import type { PreviewDocument, PreviewToEditorMessage } from '../../shared/preview-protocol';
import type { WorkbenchTab } from '@/workbench/workbench-types';

const bridgeTestState = vi.hoisted(() => ({
  persistentMounts: 0,
  persistentUnmounts: 0,
  playMounts: 0,
  playUnmounts: 0,
  dedicatedDerivedMounts: 0,
  dedicatedDerivedUnmounts: 0,
  previewDocument: {
    kind: 'room-preview',
    recordId: 'room:bridge-test',
    revision: 'bridge-revision',
    data: {
      room: { id: 'room:bridge-test', name: 'Bridge Test Room' },
      completePayloadMarker: true,
    },
  },
}));

const previewControllerMocks = vi.hoisted(() => ({
  loadPreviewDocument: vi.fn().mockResolvedValue(undefined),
  loadSession: vi.fn().mockResolvedValue({
    url: 'http://127.0.0.1:5000/?sessionToken=test-token',
    origin: 'http://127.0.0.1:5000',
    sessionToken: 'test-token',
  }),
  requestPreviewState: vi.fn().mockResolvedValue(undefined),
  reset: vi.fn().mockResolvedValue(undefined),
  setPreviewActivity: vi.fn().mockResolvedValue(undefined),
  setPreviewMode: vi.fn().mockResolvedValue(undefined),
  setPreviewWheelRouting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/hooks/use-engine-preview', () => ({
  useEnginePreview: (options: {
    onMessage: (message: PreviewToEditorMessage) => void;
    onReady?: () => void;
  }) => {
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
      iframeKey: 0,
      iframeSrc: 'http://127.0.0.1:5000/?sessionToken=test-token',
      loadPreviewDocument: previewControllerMocks.loadPreviewDocument,
      loadSession: previewControllerMocks.loadSession,
      requestPreviewState: previewControllerMocks.requestPreviewState,
      reset: previewControllerMocks.reset,
      setPreviewActivity: previewControllerMocks.setPreviewActivity,
      setPreviewMode: previewControllerMocks.setPreviewMode,
      setPreviewWheelRouting: previewControllerMocks.setPreviewWheelRouting,
    };
  },
}));

vi.mock('@/components/engine-preview-host', () => ({
  EnginePreviewHost: ({ iframeSrc }: { iframeSrc: string | null }) => (
    <iframe title="NovelTea engine preview" src={iframeSrc ?? undefined} />
  ),
}));

vi.mock('@/workbench/default-editors', async () => {
  const React = await import('react');
  const { DerivedPreviewPane } = await import('@/preview/DerivedPreviewPane');

  function PooledPersistentEditor({ tab }: { tab: WorkbenchTab }) {
    React.useEffect(() => {
      bridgeTestState.persistentMounts += 1;
      return () => {
        bridgeTestState.persistentUnmounts += 1;
      };
    }, []);
    return (
      <div data-testid="pooled-persistent-editor">
        <DerivedPreviewPane
          ownerTabId={tab.id}
          previewMode="room"
          hostPolicy="pooled-per-tab-group"
          previewDocument={bridgeTestState.previewDocument as PreviewDocument}
          resetBeforeLoad
        />
      </div>
    );
  }

  function DedicatedPlayEditor() {
    React.useEffect(() => {
      bridgeTestState.playMounts += 1;
      return () => {
        bridgeTestState.playUnmounts += 1;
      };
    }, []);
    return <div data-testid="dedicated-play-editor">Dedicated Play editor</div>;
  }

  function DedicatedDerivedEditor({ tab }: { tab: WorkbenchTab }) {
    React.useEffect(() => {
      bridgeTestState.dedicatedDerivedMounts += 1;
      return () => {
        bridgeTestState.dedicatedDerivedUnmounts += 1;
      };
    }, []);
    return (
      <div data-testid={`dedicated-derived-editor:${tab.id}`}>
        <DerivedPreviewPane
          ownerTabId={tab.id}
          previewMode="room"
          hostPolicy="dedicated-while-open"
          previewDocument={bridgeTestState.previewDocument as PreviewDocument}
          resetBeforeLoad
        />
      </div>
    );
  }

  function NormalEditor() {
    return <div data-testid="normal-editor">Normal editor</div>;
  }

  return {
    defaultEditorRegistry: {
      resolve: (editorType: string) => {
        if (editorType === 'persistent-pooled-preview') {
          return {
            type: editorType,
            label: 'Persistent pooled preview',
            component: PooledPersistentEditor,
            mountPolicy: 'keep-mounted-while-open',
            previewHostPolicy: 'pooled-per-tab-group',
            previewPersistence: 'derived',
          };
        }
        if (editorType === 'full-game-preview') {
          return {
            type: editorType,
            label: 'Play',
            component: DedicatedPlayEditor,
            mountPolicy: 'keep-mounted-while-open',
            previewHostPolicy: 'dedicated-while-open',
            previewPersistence: 'stateful',
          };
        }
        if (editorType === 'dedicated-derived-preview') {
          return {
            type: editorType,
            label: 'Dedicated derived preview',
            component: DedicatedDerivedEditor,
            previewHostPolicy: 'dedicated-while-open',
            previewPersistence: 'derived',
          };
        }
        if (editorType === 'normal-editor') {
          return {
            type: editorType,
            label: 'Normal',
            component: NormalEditor,
          };
        }
        return null;
      },
      list: () => [],
    },
  };
});

const persistentTab: WorkbenchTab = {
  id: 'tab:persistent-pooled-preview',
  title: 'Persistent pooled preview',
  editorType: 'persistent-pooled-preview',
  resource: { kind: 'tool', stableId: 'tool:persistent-pooled-preview' },
};

const playTab: WorkbenchTab = {
  id: 'tab:full-game-preview',
  title: 'Play',
  editorType: 'full-game-preview',
  preview: true,
  resource: { kind: 'preview', stableId: 'preview:full-game' },
};

const dedicatedDerivedTabA: WorkbenchTab = {
  id: 'tab:dedicated-derived:a',
  title: 'Dedicated derived A',
  editorType: 'dedicated-derived-preview',
  resource: { kind: 'tool', stableId: 'tool:dedicated-derived:a' },
};

const dedicatedDerivedTabB: WorkbenchTab = {
  id: 'tab:dedicated-derived:b',
  title: 'Dedicated derived B',
  editorType: 'dedicated-derived-preview',
  resource: { kind: 'tool', stableId: 'tool:dedicated-derived:b' },
};

const rootNormalTab: WorkbenchTab = {
  id: 'tab:normal-root',
  title: 'Root normal',
  editorType: 'normal-editor',
  resource: { kind: 'tool', stableId: 'tool:normal-root' },
};

const targetNormalTab: WorkbenchTab = {
  id: 'tab:normal-target',
  title: 'Target normal',
  editorType: 'normal-editor',
  resource: { kind: 'tool', stableId: 'tool:normal-target' },
};

function replaceSplitWorkbench({
  rootTabIds,
  rootActiveTabId,
  targetTabIds,
  targetActiveTabId,
  tabs,
}: {
  rootTabIds: string[];
  rootActiveTabId: string | null;
  targetTabIds: string[];
  targetActiveTabId: string | null;
  tabs: WorkbenchTab[];
}) {
  useWorkbenchStore.getState().replaceWorkbench({
    layout: {
      kind: 'split',
      id: 'split:preview-bridge',
      direction: 'horizontal',
      children: [
        { kind: 'group', groupId: 'root' },
        { kind: 'group', groupId: 'target' },
      ],
    },
    groupsById: {
      root: { id: 'root', tabIds: rootTabIds, activeTabId: rootActiveTabId },
      target: { id: 'target', tabIds: targetTabIds, activeTabId: targetActiveTabId },
    },
    tabsById: Object.fromEntries(tabs.map((tab) => [tab.id, tab])),
    activeGroupId: 'root',
    recentlyClosedTabs: [],
  });
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function groupRect(groupId: string | null) {
  return groupId === 'target' ? rect(410, 40, 380, 520) : rect(10, 40, 380, 520);
}

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let rectSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  bridgeTestState.persistentMounts = 0;
  bridgeTestState.persistentUnmounts = 0;
  bridgeTestState.playMounts = 0;
  bridgeTestState.playUnmounts = 0;
  bridgeTestState.dedicatedDerivedMounts = 0;
  bridgeTestState.dedicatedDerivedUnmounts = 0;
  for (const mock of Object.values(previewControllerMocks)) mock.mockClear();
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  useWorkbenchStore.getState().resetWorkbench();
  useProjectStore.getState().loadProjectDocument({
    document: { schema: 'noveltea.authoring.project', rooms: {} },
    projectPath: '/mock',
    projectFilePath: '/mock/project.json',
  });
  rectSpy = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function mockRect(this: HTMLElement) {
      if (this.hasAttribute('data-workbench-root')) return rect(0, 0, 800, 600);
      if (this.hasAttribute('data-workbench-persistent-editor-slot')) {
        return groupRect(this.getAttribute('data-workbench-group-id'));
      }
      if (this.hasAttribute('data-preview-host-layer')) {
        return rect(0, 0, 800, 600);
      }
      if (this.hasAttribute('data-preview-pane-id')) {
        return groupRect(
          this.closest('[data-workbench-editor-pane]')?.getAttribute('data-workbench-group-id') ??
            null,
        );
      }
      return rect(0, 0, 0, 0);
    });
});

afterEach(() => {
  rectSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe('persistent editor group preview service bridge', () => {
  it('moves a persistent pooled preview to the new group pool and resends a complete payload without remounting', async () => {
    replaceSplitWorkbench({
      rootTabIds: [rootNormalTab.id, persistentTab.id],
      rootActiveTabId: persistentTab.id,
      targetTabIds: [targetNormalTab.id],
      targetActiveTabId: targetNormalTab.id,
      tabs: [persistentTab, rootNormalTab, targetNormalTab],
    });
    const { container } = render(<Workbench />);

    const editor = await screen.findByTestId('pooled-persistent-editor');
    const editorPane = editor.closest('[data-workbench-editor-pane]');
    await waitFor(() =>
      expect(
        container.querySelector(
          '[data-preview-host-layer="workbench"] [data-preview-host-pool-key="root"][data-preview-host-claimed="true"]',
        ),
      ).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(previewControllerMocks.loadPreviewDocument).toHaveBeenCalledTimes(1),
    );

    act(() =>
      useWorkbenchStore.getState().moveTab({
        tabId: persistentTab.id,
        fromGroupId: 'root',
        toGroupId: 'target',
      }),
    );

    expect(screen.getByTestId('pooled-persistent-editor')).toBe(editor);
    expect(editor.closest('[data-workbench-editor-pane]')).toBe(editorPane);
    expect(editorPane).toHaveAttribute('data-workbench-group-id', 'target');
    expect(bridgeTestState.persistentMounts).toBe(1);
    expect(bridgeTestState.persistentUnmounts).toBe(0);

    await waitFor(() =>
      expect(
        container.querySelector(
          '[data-preview-host-layer="workbench"] [data-preview-host-pool-key="root"]',
        ),
      ).not.toHaveAttribute('data-preview-host-claimed'),
    );
    await waitFor(() =>
      expect(
        container.querySelector(
          '[data-preview-host-layer="workbench"] [data-preview-host-pool-key="target"][data-preview-host-claimed="true"]',
        ),
      ).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(previewControllerMocks.loadPreviewDocument).toHaveBeenCalledTimes(2),
    );

    expect(previewControllerMocks.reset).toHaveBeenCalledTimes(2);
    expect(previewControllerMocks.setPreviewMode).toHaveBeenNthCalledWith(1, 'room');
    expect(previewControllerMocks.setPreviewMode).toHaveBeenNthCalledWith(2, 'room');
    expect(
      previewControllerMocks.loadPreviewDocument.mock.calls.map(([document]) => document),
    ).toEqual([bridgeTestState.previewDocument, bridgeTestState.previewDocument]);
  });

  it('moves a dedicated derived preview between existing groups without recreating its iframe', async () => {
    replaceSplitWorkbench({
      rootTabIds: [dedicatedDerivedTabA.id],
      rootActiveTabId: dedicatedDerivedTabA.id,
      targetTabIds: [targetNormalTab.id],
      targetActiveTabId: targetNormalTab.id,
      tabs: [dedicatedDerivedTabA, targetNormalTab],
    });
    const { container } = render(<Workbench />);

    await screen.findByTestId(`dedicated-derived-editor:${dedicatedDerivedTabA.id}`);
    await waitFor(() =>
      expect(previewControllerMocks.loadPreviewDocument).toHaveBeenCalledTimes(1),
    );
    const host = container.querySelector<HTMLElement>(
      `[data-preview-host-owner-tab-id="${dedicatedDerivedTabA.id}"]`,
    );
    expect(host).toBeInTheDocument();
    expect(container.querySelectorAll('[data-preview-host-layer="workbench"]')).toHaveLength(1);
    expect(host).toHaveAttribute('data-preview-host-id', 'preview-host:workbench:1');
    const iframe = host!.querySelector('iframe');

    act(() =>
      useWorkbenchStore.getState().moveTab({
        tabId: dedicatedDerivedTabA.id,
        fromGroupId: 'root',
        toGroupId: 'target',
      }),
    );

    await waitFor(() => expect(host).toHaveAttribute('data-preview-host-group-id', 'target'));
    expect(host).toHaveAttribute('data-preview-host-claimed', 'true');
    expect(host!.querySelector('iframe')).toBe(iframe);
    expect(container.querySelectorAll('[data-preview-host-id]')).toHaveLength(1);
    expect(previewControllerMocks.loadPreviewDocument).toHaveBeenCalledTimes(1);
    expect(previewControllerMocks.reset).toHaveBeenCalledTimes(1);
    expect(bridgeTestState.dedicatedDerivedMounts).toBe(2);
    expect(bridgeTestState.dedicatedDerivedUnmounts).toBe(1);
  });

  it('preserves every warm dedicated iframe when edge docking reconstructs the target layout', async () => {
    replaceSplitWorkbench({
      rootTabIds: [rootNormalTab.id],
      rootActiveTabId: rootNormalTab.id,
      targetTabIds: [dedicatedDerivedTabA.id, dedicatedDerivedTabB.id],
      targetActiveTabId: dedicatedDerivedTabA.id,
      tabs: [rootNormalTab, dedicatedDerivedTabA, dedicatedDerivedTabB],
    });
    const { container } = render(<Workbench />);

    await waitFor(() =>
      expect(previewControllerMocks.loadPreviewDocument).toHaveBeenCalledTimes(1),
    );
    act(() => useWorkbenchStore.getState().activateTab('target', dedicatedDerivedTabB.id));
    await waitFor(() =>
      expect(previewControllerMocks.loadPreviewDocument).toHaveBeenCalledTimes(2),
    );

    const hostA = container.querySelector<HTMLElement>(
      `[data-preview-host-owner-tab-id="${dedicatedDerivedTabA.id}"]`,
    );
    const hostB = container.querySelector<HTMLElement>(
      `[data-preview-host-owner-tab-id="${dedicatedDerivedTabB.id}"]`,
    );
    expect(hostA).toBeInTheDocument();
    expect(hostB).toBeInTheDocument();
    const iframeA = hostA!.querySelector('iframe');
    const iframeB = hostB!.querySelector('iframe');

    act(() =>
      useWorkbenchStore.getState().dockTabToGroupEdge({
        tabId: rootNormalTab.id,
        fromGroupId: 'root',
        targetGroupId: 'target',
        edge: 'right',
      }),
    );

    await waitFor(() => expect(hostB).toHaveAttribute('data-preview-host-claimed', 'true'));
    expect(hostA!.querySelector('iframe')).toBe(iframeA);
    expect(hostB!.querySelector('iframe')).toBe(iframeB);
    expect(container.querySelectorAll('[data-preview-host-id]')).toHaveLength(2);
    expect(previewControllerMocks.loadPreviewDocument).toHaveBeenCalledTimes(2);
    expect(previewControllerMocks.reset).toHaveBeenCalledTimes(2);
  });

  it('does not allocate or migrate pooled hosts for the dedicated Play runtime', async () => {
    replaceSplitWorkbench({
      rootTabIds: [playTab.id],
      rootActiveTabId: playTab.id,
      targetTabIds: [targetNormalTab.id],
      targetActiveTabId: targetNormalTab.id,
      tabs: [playTab, targetNormalTab],
    });
    const { container } = render(<Workbench />);

    expect(await screen.findByTestId('dedicated-play-editor')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-preview-host-id]')).toHaveLength(0);
    expect(previewControllerMocks.loadSession).not.toHaveBeenCalled();

    act(() =>
      useWorkbenchStore.getState().moveTab({
        tabId: playTab.id,
        fromGroupId: 'root',
        toGroupId: 'target',
      }),
    );

    expect(screen.getByTestId('dedicated-play-editor')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-preview-host-id]')).toHaveLength(0);
    expect(previewControllerMocks.loadSession).not.toHaveBeenCalled();
    expect(bridgeTestState.playMounts).toBe(1);
    expect(bridgeTestState.playUnmounts).toBe(0);
  });
});
