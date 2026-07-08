import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ROOT_GROUP_ID } from '@/workbench/workbench-model';
import { WorkbenchTabDndContext } from '@/workbench/WorkbenchTabDndContext';
import { WorkbenchTabs } from '@/workbench/WorkbenchTabs';
import { useCloseGuardStore } from '@/workbench/close-guard-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
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
  useCloseGuardStore.getState().clearPendingClose();
});

describe('workbench tabs', () => {
  it('opens a context menu for the clicked tab and closes other tabs through the guard', async () => {
    const user = userEvent.setup();
    useWorkbenchStore.getState().openTab(rawTab('foyer'));
    useWorkbenchStore.getState().openTab(rawTab('kitchen'));
    renderRootTabs();

    fireEvent.contextMenu(screen.getByText('foyer'));
    expect(screen.getByText('Close Others')).toBeInTheDocument();
    expect(useWorkbenchStore.getState().groupsById[ROOT_GROUP_ID]?.activeTabId).toBe('tab:foyer');

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
});
