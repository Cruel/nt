import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ROOT_GROUP_ID } from '@/workbench/workbench-model';
import { WorkbenchTabDndContext } from '@/workbench/WorkbenchTabDndContext';
import { WorkbenchTabs } from '@/workbench/WorkbenchTabs';
import { useCloseGuardStore } from '@/workbench/close-guard-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import {
  clearWorkbenchTabStates,
  setWorkbenchTabState,
  useWorkbenchTabStateStore,
} from '@/workbench/workbench-tab-state';
import type { WorkbenchLayoutNode, WorkbenchTab } from '@/workbench/workbench-types';

function rawTab(id: string): WorkbenchTab {
  return {
    id: `tab:${id}`,
    title: id,
    editorType: 'raw-json',
    resource: {
      kind: 'record',
      stableId: `record:room:${id}`,
      collection: 'room',
      entityId: id,
    },
  };
}

function groupIdsInLayoutOrder(node: WorkbenchLayoutNode): string[] {
  return node.kind === 'group' ? [node.groupId] : node.children.flatMap(groupIdsInLayoutOrder);
}

function renderRootTabs() {
  const workbench = useWorkbenchStore.getState();
  const group = workbench.groupsById[ROOT_GROUP_ID]!;
  const tabs = group.tabIds.map((tabId) => workbench.tabsById[tabId]!).filter(Boolean);
  return render(
    <WorkbenchTabDndContext>
      <WorkbenchTabs group={group} tabs={tabs} />
    </WorkbenchTabDndContext>,
  );
}

beforeEach(() => {
  useWorkbenchStore.getState().resetWorkbench();
  clearWorkbenchTabStates();
  useCloseGuardStore.getState().clearPendingClose();
});

describe('workbench tabs', () => {
  it('opens a context menu for the clicked tab without activating it and closes other tabs through the guard', async () => {
    const user = userEvent.setup();
    useWorkbenchStore.getState().openTab(rawTab('foyer'));
    useWorkbenchStore.getState().openTab(rawTab('kitchen'));
    renderRootTabs();

    fireEvent.contextMenu(screen.getByText('foyer'));
    expect(screen.getByText('Close Others')).toBeInTheDocument();
    expect(useWorkbenchStore.getState().groupsById[ROOT_GROUP_ID]?.activeTabId).toBe('tab:kitchen');

    await user.click(screen.getByText('Close Others'));

    expect(useWorkbenchStore.getState().groupsById[ROOT_GROUP_ID]?.tabIds).toEqual(['tab:foyer']);
    expect(useCloseGuardStore.getState().pendingClose).toBeNull();
  });

  it('runs close against only the clicked tab through the context menu', async () => {
    const user = userEvent.setup();
    useWorkbenchStore.getState().openTab(rawTab('foyer'));
    useWorkbenchStore.getState().openTab(rawTab('kitchen'));
    renderRootTabs();

    fireEvent.contextMenu(screen.getByText('kitchen'));
    await user.click(screen.getByText('Close'));

    expect(useWorkbenchStore.getState().groupsById[ROOT_GROUP_ID]?.tabIds).toEqual(['tab:foyer']);
  });

  it('shows preview visibility only for supported tabs and updates the clicked tab state', async () => {
    const user = userEvent.setup();
    const roomTab: WorkbenchTab = {
      ...rawTab('foyer'),
      editorType: 'room-detail',
    };
    setWorkbenchTabState(roomTab.id, {
      schema: 'noveltea.editor.tab-state.room',
      payload: { activeCategory: 'general', previewCollapsed: false },
    });
    useWorkbenchStore.getState().openTab(roomTab);
    useWorkbenchStore.getState().openTab(rawTab('raw'));
    renderRootTabs();

    fireEvent.contextMenu(screen.getByText('foyer'));
    const previewItem = screen.getByText('Show Preview');
    expect(previewItem.closest('[role="menuitemcheckbox"]')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.click(previewItem);
    expect(useWorkbenchTabStateStore.getState().tabStatesById[roomTab.id]).toMatchObject({
      payload: { previewCollapsed: true },
    });

    await user.keyboard('{Escape}');
    fireEvent.contextMenu(screen.getByText('raw'));
    expect(screen.queryByText('Show Preview')).not.toBeInTheDocument();
  });

  it('runs close to the right against the clicked tab group', async () => {
    const user = userEvent.setup();
    useWorkbenchStore.getState().openTab(rawTab('foyer'));
    useWorkbenchStore.getState().openTab(rawTab('kitchen'));
    useWorkbenchStore.getState().openTab(rawTab('assets'));
    renderRootTabs();

    fireEvent.contextMenu(screen.getByText('foyer'));
    await user.click(screen.getByText('Close to the Right'));

    expect(useWorkbenchStore.getState().groupsById[ROOT_GROUP_ID]?.tabIds).toEqual(['tab:foyer']);
  });

  it('runs close all against the clicked tab group', async () => {
    const user = userEvent.setup();
    useWorkbenchStore.getState().openTab(rawTab('foyer'));
    useWorkbenchStore.getState().openTab(rawTab('kitchen'));
    renderRootTabs();

    fireEvent.contextMenu(screen.getByText('foyer'));
    await user.click(screen.getByText('Close All'));

    expect(useWorkbenchStore.getState().groupsById[ROOT_GROUP_ID]?.tabIds).toEqual([]);
  });

  it('runs split actions against the clicked tab and requested placement', async () => {
    const user = userEvent.setup();
    useWorkbenchStore.getState().openTab(rawTab('foyer'));
    renderRootTabs();

    fireEvent.contextMenu(screen.getByText('foyer'));
    await user.hover(screen.getByText('Split'));
    const splitLeft = await screen.findByText('Split Left');
    fireEvent.click(splitLeft);

    const workbench = useWorkbenchStore.getState();
    const groupOrder = groupIdsInLayoutOrder(workbench.layout);
    expect(groupOrder).toHaveLength(2);
    expect(groupOrder[1]).toBe(ROOT_GROUP_ID);
    expect(workbench.groupsById[workbench.activeGroupId]?.activeTabId).toBeTruthy();
    expect(workbench.groupsById[ROOT_GROUP_ID]?.tabIds).toEqual(['tab:foyer']);
  });

  it('hides split actions when the group has no active tab', () => {
    renderRootTabs();

    expect(screen.queryByLabelText('Reopen closed tab')).toBeNull();
    expect(screen.queryByLabelText('Split right')).toBeNull();
    expect(screen.queryByLabelText('Split down')).toBeNull();
  });

  it('hides the tab scrollbar and maps wheel movement to horizontal scrolling', () => {
    useWorkbenchStore.getState().openTab(rawTab('foyer'));
    const { container } = renderRootTabs();
    const strip = container.querySelector<HTMLElement>(
      `[data-workbench-tab-strip-id="${ROOT_GROUP_ID}"]`,
    )!;
    Object.defineProperties(strip, {
      clientWidth: { configurable: true, value: 300 },
      scrollWidth: { configurable: true, value: 900 },
    });

    expect(strip).toHaveClass('[scrollbar-width:none]', '[&::-webkit-scrollbar]:hidden');
    fireEvent.wheel(strip, { deltaY: 120 });
    expect(strip.scrollLeft).toBe(120);

    fireEvent.wheel(strip, { deltaX: 40, deltaY: 10 });
    expect(strip.scrollLeft).toBe(160);

    fireEvent.wheel(strip, { deltaY: 80, ctrlKey: true });
    expect(strip.scrollLeft).toBe(160);
  });

  it('scrolls an activated overflowed tab into view', () => {
    useWorkbenchStore.getState().openTab(rawTab('foyer'));
    useWorkbenchStore.getState().openTab(rawTab('kitchen'));
    useWorkbenchStore.getState().activateTab(ROOT_GROUP_ID, 'tab:foyer');
    const view = renderRootTabs();
    const strip = view.container.querySelector<HTMLElement>('[data-workbench-tab-strip-id]')!;
    const kitchen = view.container.querySelector<HTMLElement>(
      '[data-workbench-tab-id="tab:kitchen"]',
    )!;
    strip.scrollLeft = 0;
    Object.defineProperty(strip, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, right: 200 }),
    });
    Object.defineProperty(kitchen, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 180, right: 280 }),
    });

    act(() => {
      useWorkbenchStore.getState().activateTab(ROOT_GROUP_ID, 'tab:kitchen');
      const workbench = useWorkbenchStore.getState();
      const group = workbench.groupsById[ROOT_GROUP_ID]!;
      const tabs = group.tabIds.map((tabId) => workbench.tabsById[tabId]!).filter(Boolean);
      view.rerender(
        <WorkbenchTabDndContext>
          <WorkbenchTabs group={group} tabs={tabs} />
        </WorkbenchTabDndContext>,
      );
    });

    expect(strip.scrollLeft).toBe(80);
  });
});
