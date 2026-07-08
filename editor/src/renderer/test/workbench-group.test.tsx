import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
});

describe('WorkbenchGroup mount policy rendering', () => {
  it('keeps the Play tab mounted across same-group tab switches', () => {
    const view = renderGroup(group(playTab.id));

    expect(screen.getByTestId('play-editor')).toBeInTheDocument();
    expect(counters.playMounts).toBe(1);

    view.rerender(
      <WorkbenchTabDndContext>
        <WorkbenchGroup group={group(normalTab.id)} tabs={[playTab, normalTab]} />
      </WorkbenchTabDndContext>,
    );

    expect(screen.getByTestId('play-editor')).toBeInTheDocument();
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
    const view = renderGroup(group(playTab.id));

    view.rerender(
      <WorkbenchTabDndContext>
        <WorkbenchGroup group={group(normalTab.id)} tabs={[playTab, normalTab]} />
      </WorkbenchTabDndContext>,
    );

    const playPane = screen.getByTestId('play-editor').closest('[data-workbench-editor-pane]');
    const normalPane = screen.getByTestId('normal-editor').closest('[data-workbench-editor-pane]');

    expect(playPane).toHaveAttribute('aria-hidden', 'true');
    expect(playPane).toHaveAttribute('inert');
    expect(playPane).toHaveClass('invisible');
    expect(playPane).toHaveClass('pointer-events-none');
    expect(normalPane).not.toHaveAttribute('aria-hidden');
    expect(normalPane).not.toHaveAttribute('inert');
  });

  it('unmounts the keep-mounted tab when it is closed', () => {
    const view = renderGroup(group(playTab.id));

    expect(screen.getByTestId('play-editor')).toBeInTheDocument();

    view.rerender(
      <WorkbenchTabDndContext>
        <WorkbenchGroup group={group(normalTab.id, [normalTab.id])} tabs={[normalTab]} />
      </WorkbenchTabDndContext>,
    );

    expect(screen.queryByTestId('play-editor')).not.toBeInTheDocument();
    expect(counters.playUnmounts).toBe(1);
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
});
