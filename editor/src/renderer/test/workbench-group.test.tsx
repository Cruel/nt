import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { Workbench } from '@/workbench/Workbench';
import { WorkbenchGroup } from '@/workbench/WorkbenchGroup';
import { WorkbenchTabDndContext } from '@/workbench/WorkbenchTabDndContext';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { enqueueWorkbenchRevealTarget } from '@/workbench/workbench-navigation';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchGroup as WorkbenchGroupModel, WorkbenchTab } from '@/workbench/workbench-types';

const counters = vi.hoisted(() => ({
  normalMounts: 0,
  normalUnmounts: 0,
  playMounts: 0,
  playUnmounts: 0,
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
        <section data-testid="normal-anchor" data-workbench-anchor="normal.target">Target</section>
      </div>
    );
  }

  function PlayEditor() {
    React.useEffect(() => {
      counters.playMounts += 1;
      return () => {
        counters.playUnmounts += 1;
      };
    }, []);
    return <button data-testid="play-editor">Play editor</button>;
  }

  function DelayedAnchorEditor() {
    const [visible, setVisible] = React.useState(false);
    React.useEffect(() => {
      const timeout = window.setTimeout(() => setVisible(true), 20);
      return () => window.clearTimeout(timeout);
    }, []);
    return (
      <div data-testid="delayed-editor">
        {visible ? <section data-testid="delayed-anchor" data-workbench-anchor="delayed.target">Delayed Target</section> : null}
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
  resource: { kind: 'record', stableId: 'record:rooms:foyer', collection: 'rooms', entityId: 'foyer' },
};

const delayedTab: WorkbenchTab = {
  id: 'tab:delayed',
  title: 'Delayed',
  editorType: 'delayed-editor',
  resource: { kind: 'record', stableId: 'record:rooms:delayed', collection: 'rooms', entityId: 'delayed' },
};

function group(activeTabId: string | null, tabIds: string[] = [playTab.id, normalTab.id]): WorkbenchGroupModel {
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

function replaceWorkbenchGroup(activeTabId: string | null, tabs: WorkbenchTab[] = [playTab, normalTab]) {
  useWorkbenchStore.getState().replaceWorkbench({
    layout: { kind: 'group', groupId: 'root' },
    groupsById: { root: group(activeTabId, tabs.map((tab) => tab.id)) },
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

beforeEach(() => {
  counters.normalMounts = 0;
  counters.normalUnmounts = 0;
  counters.playMounts = 0;
  counters.playUnmounts = 0;
  useWorkbenchStore.getState().resetWorkbench();
  useProjectStore.getState().loadProjectDocument({
    document: { schema: 'noveltea.authoring.project', rooms: {} },
    projectPath: '/mock',
    projectFilePath: '/mock/project.json',
  });
  rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function mockRect(this: HTMLElement) {
    if (this.hasAttribute('data-workbench-root')) return rect(10, 20, 800, 600);
    if (this.hasAttribute('data-workbench-persistent-editor-slot')) return rect(30, 60, 400, 300);
    return rect(0, 0, 0, 0);
  });
});

afterEach(() => rectSpy.mockRestore());

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
    expect(screen.getByTestId('play-editor').closest('[data-workbench-editor-pane]')).toBe(playPane);
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

  it('renders a slot instead of a group-owned editor for an active persistent tab', () => {
    const view = renderGroup(group(playTab.id));

    expect(screen.queryByTestId('play-editor')).not.toBeInTheDocument();
    expect(view.container.querySelector('[data-workbench-persistent-editor-slot="tab:full-game-preview"]')).toBeInTheDocument();
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

  it('reveals and flashes queued anchors after the active pane mounts', async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    enqueueWorkbenchRevealTarget(normalTab, { id: 'normal.target', block: 'center', flash: true });

    try {
      renderGroup(group(normalTab.id));

      const anchor = await screen.findByTestId('normal-anchor');
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: 'smooth',
        block: 'center',
        inline: 'nearest',
      }));
      expect(anchor).toHaveAttribute('data-workbench-anchor-flash');
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('retries queued anchors that appear after editor state changes', async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    enqueueWorkbenchRevealTarget(delayedTab, { id: 'delayed.target', block: 'center', flash: true });

    try {
      renderGroup(group(delayedTab.id, [delayedTab.id]), [delayedTab]);

      const anchor = await screen.findByTestId('delayed-anchor');
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: 'smooth',
        block: 'center',
        inline: 'nearest',
      }));
      expect(anchor).toHaveAttribute('data-workbench-anchor-flash');
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });
});
