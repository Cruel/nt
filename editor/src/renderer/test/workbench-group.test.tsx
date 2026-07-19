import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Workbench } from '@/workbench/Workbench';
import { WorkbenchGroup } from '@/workbench/WorkbenchGroup';
import { WorkbenchTabDndContext } from '@/workbench/WorkbenchTabDndContext';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { enqueueWorkbenchRevealTarget } from '@/workbench/workbench-navigation';
import { useProjectStore } from '@/project/project-store';
import type {
  WorkbenchGroup as WorkbenchGroupModel,
  WorkbenchTab,
} from '@/workbench/workbench-types';

const counters = vi.hoisted(() => ({
  normalMounts: 0,
  normalUnmounts: 0,
  playMounts: 0,
  playUnmounts: 0,
  secondaryMounts: 0,
  secondaryUnmounts: 0,
}));

vi.mock('@/workbench/default-editors', async () => {
  const React = await import('react');

  function NormalEditor() {
    React.useEffect(() => {
      counters.normalMounts += 1;
      return () => {
        counters.normalUnmounts += 1;
      };
    }, []);
    return (
      <div data-testid="normal-editor">
        <div style={{ height: 1000 }}>Top</div>
        <section data-testid="normal-anchor" data-workbench-anchor="normal.target">
          Target
        </section>
      </div>
    );
  }

  function PlayEditor() {
    const [localValue, setLocalValue] = React.useState(0);
    React.useEffect(() => {
      counters.playMounts += 1;
      return () => {
        counters.playUnmounts += 1;
      };
    }, []);
    return (
      <button data-testid="play-editor" onClick={() => setLocalValue((value) => value + 1)}>
        Play editor {localValue}
      </button>
    );
  }

  function SecondaryPersistentEditor() {
    React.useEffect(() => {
      counters.secondaryMounts += 1;
      return () => {
        counters.secondaryUnmounts += 1;
      };
    }, []);
    return <div data-testid="secondary-persistent-editor">Secondary persistent editor</div>;
  }

  function DelayedAnchorEditor() {
    const [visible, setVisible] = React.useState(false);
    React.useEffect(() => {
      const timeout = window.setTimeout(() => setVisible(true), 20);
      return () => window.clearTimeout(timeout);
    }, []);
    return (
      <div data-testid="delayed-editor">
        {visible ? (
          <section data-testid="delayed-anchor" data-workbench-anchor="delayed.target">
            Delayed Target
          </section>
        ) : null}
      </div>
    );
  }

  return {
    defaultEditorRegistry: {
      resolve: (editorType: string) => {
        if (editorType === 'full-game-preview') {
          return {
            type: 'full-game-preview',
            label: 'Play',
            component: PlayEditor,
            mountPolicy: 'keep-mounted-while-open',
            previewHostPolicy: 'dedicated-while-open',
            previewPersistence: 'stateful',
          };
        }
        if (editorType === 'normal-editor') {
          return {
            type: 'normal-editor',
            label: 'Normal',
            component: NormalEditor,
          };
        }
        if (editorType === 'secondary-persistent-editor') {
          return {
            type: 'secondary-persistent-editor',
            label: 'Secondary',
            component: SecondaryPersistentEditor,
            mountPolicy: 'keep-mounted-while-open',
            previewHostPolicy: 'dedicated-while-open',
            previewPersistence: 'stateful',
          };
        }
        if (editorType === 'delayed-editor') {
          return {
            type: 'delayed-editor',
            label: 'Delayed',
            component: DelayedAnchorEditor,
          };
        }
        return null;
      },
      list: () => [],
    },
  };
});

const playTab: WorkbenchTab = {
  id: 'tab:full-game-preview',
  title: 'Play',
  editorType: 'full-game-preview',
  preview: true,
  resource: { kind: 'preview', stableId: 'preview:full-game' },
};

const normalTab: WorkbenchTab = {
  id: 'tab:normal',
  title: 'Normal',
  editorType: 'normal-editor',
  resource: {
    kind: 'record',
    stableId: 'record:rooms:foyer',
    collection: 'rooms',
    entityId: 'foyer',
  },
};

const secondaryPersistentTab: WorkbenchTab = {
  id: 'tab:secondary-persistent',
  title: 'Secondary',
  editorType: 'secondary-persistent-editor',
  resource: { kind: 'tool', stableId: 'tool:secondary-persistent' },
};

const delayedTab: WorkbenchTab = {
  id: 'tab:delayed',
  title: 'Delayed',
  editorType: 'delayed-editor',
  resource: {
    kind: 'record',
    stableId: 'record:rooms:delayed',
    collection: 'rooms',
    entityId: 'delayed',
  },
};

function group(
  activeTabId: string | null,
  tabIds: string[] = [playTab.id, normalTab.id],
): WorkbenchGroupModel {
  return {
    id: 'root',
    tabIds,
    activeTabId,
  };
}

function renderGroup(model: WorkbenchGroupModel, tabs: WorkbenchTab[] = [playTab, normalTab]) {
  return render(
    <WorkbenchTabDndContext>
      <WorkbenchGroup group={model} tabs={tabs} />
    </WorkbenchTabDndContext>,
  );
}

function replaceWorkbenchGroup(
  activeTabId: string | null,
  tabs: WorkbenchTab[] = [playTab, normalTab],
) {
  useWorkbenchStore.getState().replaceWorkbench({
    layout: { kind: 'group', groupId: 'root' },
    groupsById: {
      root: group(
        activeTabId,
        tabs.map((tab) => tab.id),
      ),
    },
    tabsById: Object.fromEntries(tabs.map((tab) => [tab.id, tab])),
    activeGroupId: 'root',
    recentlyClosedTabs: [],
  });
}

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
      id: 'split:test',
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

let rectSpy: ReturnType<typeof vi.spyOn>;

class ResizeObserverMock {
  static observers = new Set<ResizeObserverMock>();

  callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverMock.observers.add(this);
  }

  static notify() {
    for (const observer of ResizeObserverMock.observers)
      observer.callback([], observer as unknown as ResizeObserver);
  }

  observe() {}
  unobserve() {}
  disconnect() {
    ResizeObserverMock.observers.delete(this);
  }
}

beforeEach(() => {
  ResizeObserverMock.observers.clear();
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  counters.normalMounts = 0;
  counters.normalUnmounts = 0;
  counters.playMounts = 0;
  counters.playUnmounts = 0;
  counters.secondaryMounts = 0;
  counters.secondaryUnmounts = 0;
  useWorkbenchStore.getState().resetWorkbench();
  useProjectStore.getState().loadProjectDocument({
    document: { schema: 'noveltea.authoring.project', rooms: {} },
    projectPath: '/mock',
    projectFilePath: '/mock/project.json',
  });
  rectSpy = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function mockRect(this: HTMLElement) {
      if (this.hasAttribute('data-workbench-root')) return rect(10, 20, 800, 600);
      if (this.hasAttribute('data-workbench-persistent-editor-slot')) return rect(30, 60, 400, 300);
      return rect(0, 0, 0, 0);
    });
});

afterEach(() => {
  rectSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe('WorkbenchGroup mount policy rendering', () => {
  it('keeps the Play tab mounted across same-group tab switches', () => {
    replaceWorkbenchGroup(playTab.id);
    render(<Workbench />);

    expect(screen.getByTestId('play-editor')).toBeInTheDocument();
    expect(counters.playMounts).toBe(1);
    const playEditor = screen.getByTestId('play-editor');
    const playPane = playEditor.closest('[data-workbench-editor-pane]');

    act(() => useWorkbenchStore.getState().activateTab('root', normalTab.id));

    expect(screen.getByTestId('play-editor')).toBeInTheDocument();
    expect(counters.playMounts).toBe(1);
    expect(counters.playUnmounts).toBe(0);

    act(() => useWorkbenchStore.getState().activateTab('root', playTab.id));

    expect(screen.getByTestId('play-editor')).toBe(playEditor);
    expect(screen.getByTestId('play-editor').closest('[data-workbench-editor-pane]')).toBe(
      playPane,
    );
    expect(counters.playMounts).toBe(1);
    expect(counters.playUnmounts).toBe(0);
  });

  it('unmounts normal active-only editors when they become inactive', () => {
    const view = renderGroup(group(normalTab.id));

    expect(screen.getByTestId('normal-editor')).toBeInTheDocument();
    expect(counters.normalMounts).toBe(1);

    view.rerender(
      <WorkbenchTabDndContext>
        <WorkbenchGroup group={group(playTab.id)} tabs={[playTab, normalTab]} />
      </WorkbenchTabDndContext>,
    );

    expect(screen.queryByTestId('normal-editor')).not.toBeInTheDocument();
    expect(counters.normalUnmounts).toBe(1);
  });

  it('marks inactive keep-mounted panes aria-hidden, inert, and non-interactive', () => {
    replaceWorkbenchGroup(playTab.id);
    render(<Workbench />);

    act(() => useWorkbenchStore.getState().activateTab('root', normalTab.id));

    const playPane = screen.getByTestId('play-editor').closest('[data-workbench-editor-pane]');
    const normalPane = screen.getByTestId('normal-editor').closest('[data-workbench-editor-pane]');

    expect(playPane).toHaveAttribute('aria-hidden', 'true');
    expect(playPane).toHaveAttribute('inert');
    expect(playPane).toHaveAttribute('data-hidden', 'true');
    expect(playPane).toHaveClass('invisible');
    expect(playPane).toHaveClass('pointer-events-none');
    expect(normalPane).not.toHaveAttribute('aria-hidden');
    expect(normalPane).not.toHaveAttribute('inert');
  });

  it('unmounts the keep-mounted tab when it is closed', () => {
    replaceWorkbenchGroup(playTab.id);
    render(<Workbench />);

    expect(screen.getByTestId('play-editor')).toBeInTheDocument();

    act(() => useWorkbenchStore.getState().closeTab('root', playTab.id));

    expect(screen.queryByTestId('play-editor')).not.toBeInTheDocument();
    expect(counters.playUnmounts).toBe(1);
  });

  it('tears down persistent hosts for close-all, close-others, and project close', () => {
    replaceWorkbenchGroup(playTab.id);
    render(<Workbench />);

    act(() => useWorkbenchStore.getState().closeAllTabsInGroup('root'));
    expect(screen.queryByTestId('play-editor')).not.toBeInTheDocument();
    expect(counters.playUnmounts).toBe(1);

    act(() => replaceWorkbenchGroup(playTab.id));
    expect(screen.getByTestId('play-editor')).toBeInTheDocument();
    act(() => useWorkbenchStore.getState().closeOtherTabs('root', normalTab.id));
    expect(screen.queryByTestId('play-editor')).not.toBeInTheDocument();
    expect(counters.playUnmounts).toBe(2);

    act(() => replaceWorkbenchGroup(playTab.id));
    expect(screen.getByTestId('play-editor')).toBeInTheDocument();
    act(() => useWorkbenchStore.getState().closeProjectTabs());
    expect(screen.queryByTestId('play-editor')).not.toBeInTheDocument();
    expect(counters.playUnmounts).toBe(3);
  });

  it('tears down on reset and creates a new host when a closed tab is reopened', () => {
    replaceWorkbenchGroup(playTab.id);
    render(<Workbench />);
    const firstEditor = screen.getByTestId('play-editor');

    act(() => useWorkbenchStore.getState().closeTab('root', playTab.id));
    expect(counters.playUnmounts).toBe(1);
    act(() => useWorkbenchStore.getState().reopenLastClosedTab());
    const reopenedEditor = screen.getByTestId('play-editor');
    expect(reopenedEditor).not.toBe(firstEditor);
    expect(counters.playMounts).toBe(2);

    act(() => useWorkbenchStore.getState().resetWorkbench());
    expect(screen.queryByTestId('play-editor')).not.toBeInTheDocument();
    expect(counters.playUnmounts).toBe(2);
  });

  it('renders a slot instead of a group-owned editor for an active persistent tab', () => {
    const view = renderGroup(group(playTab.id));

    expect(screen.queryByTestId('play-editor')).not.toBeInTheDocument();
    expect(
      view.container.querySelector(
        '[data-workbench-persistent-editor-slot="tab:full-game-preview"]',
      ),
    ).toBeInTheDocument();
  });

  it('keeps an active persistent host hidden until its current slot has a valid rect', () => {
    rectSpy.mockImplementation(function mockRect(this: HTMLElement) {
      if (this.hasAttribute('data-workbench-root')) return rect(10, 20, 800, 600);
      return rect(0, 0, 0, 0);
    });
    replaceWorkbenchGroup(playTab.id);
    render(<Workbench />);

    const playPane = screen.getByTestId('play-editor').closest('[data-workbench-editor-pane]');
    expect(playPane).toHaveAttribute('aria-hidden', 'true');
    expect(playPane).toHaveAttribute('inert');
    expect(playPane).toHaveAttribute('data-hidden', 'true');
    expect(playPane).toHaveClass('invisible');
    expect(playPane).toHaveClass('pointer-events-none');
  });

  it('preserves the persistent host, pane, and local state when moving between groups', () => {
    replaceSplitWorkbench({
      rootTabIds: [normalTab.id, playTab.id],
      rootActiveTabId: playTab.id,
      targetTabIds: [delayedTab.id],
      targetActiveTabId: delayedTab.id,
      tabs: [playTab, normalTab, delayedTab],
    });
    render(<Workbench />);

    const playEditor = screen.getByTestId('play-editor');
    const playPane = playEditor.closest('[data-workbench-editor-pane]');
    act(() => playEditor.click());
    expect(playEditor).toHaveTextContent('Play editor 1');

    act(() =>
      useWorkbenchStore.getState().moveTab({
        tabId: playTab.id,
        fromGroupId: 'root',
        toGroupId: 'target',
      }),
    );

    expect(screen.getByTestId('play-editor')).toBe(playEditor);
    expect(playEditor.closest('[data-workbench-editor-pane]')).toBe(playPane);
    expect(playEditor).toHaveTextContent('Play editor 1');
    expect(playPane).toHaveAttribute('data-workbench-group-id', 'target');
    expect(counters.playMounts).toBe(1);
    expect(counters.playUnmounts).toBe(0);
  });

  it('preserves the persistent host when moving it prunes the empty source group', () => {
    replaceSplitWorkbench({
      rootTabIds: [playTab.id],
      rootActiveTabId: playTab.id,
      targetTabIds: [normalTab.id],
      targetActiveTabId: normalTab.id,
      tabs: [playTab, normalTab],
    });
    render(<Workbench />);
    const playEditor = screen.getByTestId('play-editor');
    const playPane = playEditor.closest('[data-workbench-editor-pane]');

    act(() =>
      useWorkbenchStore.getState().moveTab({
        tabId: playTab.id,
        fromGroupId: 'root',
        toGroupId: 'target',
      }),
    );

    expect(useWorkbenchStore.getState().groupsById.root).toBeUndefined();
    expect(screen.getByTestId('play-editor')).toBe(playEditor);
    expect(playEditor.closest('[data-workbench-editor-pane]')).toBe(playPane);
    expect(counters.playMounts).toBe(1);
    expect(counters.playUnmounts).toBe(0);
  });

  it.each(['left', 'right', 'top', 'bottom'] as const)(
    'preserves the persistent host when docking to the %s creates a split',
    (edge) => {
      replaceWorkbenchGroup(playTab.id);
      render(<Workbench />);
      const playEditor = screen.getByTestId('play-editor');
      const playPane = playEditor.closest('[data-workbench-editor-pane]');

      act(() =>
        useWorkbenchStore.getState().dockTabToGroupEdge({
          tabId: playTab.id,
          fromGroupId: 'root',
          targetGroupId: 'root',
          edge,
        }),
      );

      expect(useWorkbenchStore.getState().layout.kind).toBe('split');
      expect(screen.getByTestId('play-editor')).toBe(playEditor);
      expect(playEditor.closest('[data-workbench-editor-pane]')).toBe(playPane);
      expect(counters.playMounts).toBe(1);
      expect(counters.playUnmounts).toBe(0);
    },
  );

  it('remeasures a persistent host after a newly created split settles', () => {
    let splitHasSettled = false;
    rectSpy.mockImplementation(function mockRect(this: HTMLElement) {
      if (this.hasAttribute('data-workbench-root')) return rect(10, 20, 800, 600);
      if (this.hasAttribute('data-workbench-persistent-editor-slot')) {
        return splitHasSettled ? rect(30, 60, 390, 300) : rect(30, 60, 780, 300);
      }
      return rect(0, 0, 0, 0);
    });
    replaceWorkbenchGroup(playTab.id);
    render(<Workbench />);
    const playPane = screen.getByTestId('play-editor').closest('[data-workbench-editor-pane]');
    expect(playPane).toHaveStyle({ width: '780px' });

    act(() =>
      useWorkbenchStore.getState().dockTabToGroupEdge({
        tabId: playTab.id,
        fromGroupId: 'root',
        targetGroupId: 'root',
        edge: 'left',
      }),
    );
    expect(playPane).toHaveStyle({ width: '780px' });

    splitHasSettled = true;
    act(() => ResizeObserverMock.notify());

    expect(playPane).toHaveStyle({ width: '390px' });
    expect(counters.playMounts).toBe(1);
    expect(counters.playUnmounts).toBe(0);
  });

  it('tracks split resizing every frame and disables iframe-backed host input until the resize ends', async () => {
    let slotLeft = 30;
    let slotWidth = 400;
    rectSpy.mockImplementation(function mockRect(this: HTMLElement) {
      if (this.hasAttribute('data-workbench-root')) return rect(10, 20, 800, 600);
      if (
        this.getAttribute('data-workbench-group-id') === 'root' &&
        this.hasAttribute('data-workbench-persistent-editor-slot')
      ) {
        return rect(slotLeft, 60, slotWidth, 300);
      }
      return rect(430, 60, 380, 300);
    });
    replaceSplitWorkbench({
      rootTabIds: [playTab.id],
      rootActiveTabId: playTab.id,
      targetTabIds: [normalTab.id],
      targetActiveTabId: normalTab.id,
      tabs: [playTab, normalTab],
    });
    render(<Workbench />);

    const playPane = screen
      .getByTestId('play-editor')
      .closest<HTMLElement>('[data-workbench-editor-pane]')!;
    const resizeHandle = document.querySelector<HTMLElement>('[data-workbench-resize-handle]')!;
    const hostLayer = document.querySelector<HTMLElement>(
      '[data-workbench-persistent-editor-host-layer]',
    )!;
    expect(playPane).toHaveStyle({ left: '20px', width: '400px', pointerEvents: 'auto' });
    expect(resizeHandle).toHaveClass('z-10');
    expect(hostLayer).toHaveClass('z-[1]');

    act(() => {
      fireEvent.pointerDown(resizeHandle, { button: 0, clientX: 430, clientY: 200 });
    });
    expect(playPane).toHaveStyle({ pointerEvents: 'none' });

    slotLeft = 50;
    slotWidth = 275;
    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });

    expect(playPane).toHaveStyle({ left: '40px', width: '275px', pointerEvents: 'none' });

    act(() => {
      fireEvent.pointerUp(window, { button: 0, clientX: 325, clientY: 200 });
    });

    expect(playPane).toHaveStyle({ left: '40px', width: '275px', pointerEvents: 'auto' });

    slotLeft = 70;
    slotWidth = 250;
    fireEvent(window, new Event('resize'));
    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });

    expect(playPane).toHaveStyle({ left: '60px', width: '250px' });
  });

  it('keeps stale old-group placement hidden until a new slot generation is measured', () => {
    let targetSlotHasRect = false;
    rectSpy.mockImplementation(function mockRect(this: HTMLElement) {
      if (this.hasAttribute('data-workbench-root')) return rect(10, 20, 800, 600);
      if (this.getAttribute('data-workbench-group-id') === 'root') return rect(30, 60, 300, 300);
      if (this.getAttribute('data-workbench-group-id') === 'target' && targetSlotHasRect)
        return rect(430, 60, 300, 300);
      return rect(0, 0, 0, 0);
    });
    replaceSplitWorkbench({
      rootTabIds: [delayedTab.id, playTab.id],
      rootActiveTabId: playTab.id,
      targetTabIds: [normalTab.id],
      targetActiveTabId: normalTab.id,
      tabs: [playTab, normalTab, delayedTab],
    });
    render(<Workbench />);
    const playPane = screen.getByTestId('play-editor').closest('[data-workbench-editor-pane]');
    const oldGeneration = document
      .querySelector('[data-workbench-persistent-editor-slot]')
      ?.getAttribute('data-workbench-slot-generation');

    act(() =>
      useWorkbenchStore.getState().moveTab({
        tabId: playTab.id,
        fromGroupId: 'root',
        toGroupId: 'target',
      }),
    );

    expect(playPane).toHaveAttribute('aria-hidden', 'true');
    expect(playPane).toHaveAttribute('data-hidden', 'true');
    expect(playPane).toHaveStyle({ pointerEvents: 'none' });

    targetSlotHasRect = true;
    act(() => useWorkbenchStore.getState().activateTab('target', normalTab.id));
    act(() => useWorkbenchStore.getState().activateTab('target', playTab.id));

    const newSlot = document.querySelector('[data-workbench-persistent-editor-slot]');
    expect(newSlot?.getAttribute('data-workbench-slot-generation')).not.toBe(oldGeneration);
    expect(playPane).not.toHaveAttribute('aria-hidden');
    expect(playPane).toHaveAttribute('data-workbench-group-id', 'target');
  });

  it('mounts and reveals one persistent editor in each split group', () => {
    replaceSplitWorkbench({
      rootTabIds: [playTab.id],
      rootActiveTabId: playTab.id,
      targetTabIds: [secondaryPersistentTab.id],
      targetActiveTabId: secondaryPersistentTab.id,
      tabs: [playTab, secondaryPersistentTab],
    });
    render(<Workbench />);

    const playPane = screen.getByTestId('play-editor').closest('[data-workbench-editor-pane]');
    const secondaryPane = screen
      .getByTestId('secondary-persistent-editor')
      .closest('[data-workbench-editor-pane]');
    expect(playPane).not.toHaveAttribute('aria-hidden');
    expect(secondaryPane).not.toHaveAttribute('aria-hidden');
    expect(playPane).toHaveAttribute('data-workbench-group-id', 'root');
    expect(secondaryPane).toHaveAttribute('data-workbench-group-id', 'target');
    expect(counters.playMounts).toBe(1);
    expect(counters.secondaryMounts).toBe(1);
  });

  it('activates the current group from pointer and focus interaction after a persistent editor moves', () => {
    replaceSplitWorkbench({
      rootTabIds: [playTab.id, delayedTab.id],
      rootActiveTabId: playTab.id,
      targetTabIds: [normalTab.id],
      targetActiveTabId: normalTab.id,
      tabs: [playTab, normalTab, delayedTab],
    });
    render(<Workbench />);
    const playEditor = screen.getByTestId('play-editor');

    act(() =>
      useWorkbenchStore.getState().moveTab({
        tabId: playTab.id,
        fromGroupId: 'root',
        toGroupId: 'target',
      }),
    );
    act(() => useWorkbenchStore.setState({ activeGroupId: 'root' }));

    fireEvent.pointerDown(playEditor);
    expect(useWorkbenchStore.getState().activeGroupId).toBe('target');

    act(() => useWorkbenchStore.setState({ activeGroupId: 'root' }));
    fireEvent.focus(playEditor);
    expect(useWorkbenchStore.getState().activeGroupId).toBe('target');
  });

  it('reveals and flashes queued anchors after the active pane mounts', async () => {
    const scrollIntoView = vi.fn();
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    enqueueWorkbenchRevealTarget(normalTab, { id: 'normal.target', block: 'center', flash: true });

    try {
      renderGroup(group(normalTab.id));

      const anchor = await screen.findByTestId('normal-anchor');
      await waitFor(() =>
        expect(scrollIntoView).toHaveBeenCalledWith({
          behavior: 'smooth',
          block: 'center',
          inline: 'nearest',
        }),
      );
      expect(anchor).toHaveAttribute('data-workbench-anchor-flash');
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5_000);
    } finally {
      setTimeoutSpy.mockRestore();
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('retries queued anchors that appear after editor state changes', async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    enqueueWorkbenchRevealTarget(delayedTab, {
      id: 'delayed.target',
      block: 'center',
      flash: true,
    });

    try {
      renderGroup(group(delayedTab.id, [delayedTab.id]), [delayedTab]);

      const anchor = await screen.findByTestId('delayed-anchor');
      await waitFor(() =>
        expect(scrollIntoView).toHaveBeenCalledWith({
          behavior: 'smooth',
          block: 'center',
          inline: 'nearest',
        }),
      );
      expect(anchor).toHaveAttribute('data-workbench-anchor-flash');
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });
});
