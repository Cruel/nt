import { useEffect } from 'react';
import { ChevronRight } from 'lucide-react';
import { useCloseGuardStore } from './close-guard-store';
import { useWorkbenchStore } from './workbench-store';
import type { WorkbenchGroup, WorkbenchSplitDirection, WorkbenchTab } from './workbench-types';

export interface WorkbenchTabContextMenuState {
  groupId: string;
  tabId: string;
  x: number;
  y: number;
}

interface WorkbenchTabContextMenuProps {
  state: WorkbenchTabContextMenuState | null;
  group: WorkbenchGroup;
  tabs: WorkbenchTab[];
  onClose: () => void;
}

export function WorkbenchTabContextMenu({ state, group, tabs, onClose }: WorkbenchTabContextMenuProps) {
  const requestCloseTab = useCloseGuardStore((store) => store.requestCloseTab);
  const requestCloseOtherTabs = useCloseGuardStore((store) => store.requestCloseOtherTabs);
  const requestCloseTabsToRight = useCloseGuardStore((store) => store.requestCloseTabsToRight);
  const requestCloseAllTabsInGroup = useCloseGuardStore((store) => store.requestCloseAllTabsInGroup);
  const splitGroup = useWorkbenchStore((store) => store.splitGroup);

  useEffect(() => {
    if (!state) return;
    const close = () => onClose();
    window.addEventListener('click', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', close);
    };
  }, [onClose, state]);

  if (!state || state.groupId !== group.id) return null;
  const tabIndex = group.tabIds.indexOf(state.tabId);
  const tab = tabs.find((candidate) => candidate.id === state.tabId) ?? null;
  if (!tab || tabIndex < 0) return null;
  const targetTab = tab;

  const hasOtherTabs = group.tabIds.length > 1;
  const hasTabsToRight = tabIndex < group.tabIds.length - 1;
  const itemClass = 'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent disabled:pointer-events-none disabled:opacity-50';

  function run(action: () => void) {
    action();
    onClose();
  }

  function split(direction: WorkbenchSplitDirection, placement: 'before' | 'after') {
    splitGroup({
      sourceGroupId: group.id,
      direction,
      placement,
      tabId: targetTab.id,
      moveTab: false,
    });
  }

  return (
    <div
      className="fixed z-50 min-w-44 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg"
      style={{ left: state.x, top: state.y }}
      onClick={(event) => event.stopPropagation()}
    >
      <button className={itemClass} onClick={() => run(() => requestCloseTab(group.id, targetTab.id))}>Close</button>
      <button className={itemClass} disabled={!hasOtherTabs} onClick={() => run(() => requestCloseOtherTabs(group.id, targetTab.id))}>Close Others</button>
      <button className={itemClass} disabled={!hasTabsToRight} onClick={() => run(() => requestCloseTabsToRight(group.id, targetTab.id))}>Close to the Right</button>
      <button className={itemClass} disabled={group.tabIds.length === 0} onClick={() => run(() => requestCloseAllTabsInGroup(group.id))}>Close All</button>
      <div className="my-1 h-px bg-border" />
      <div className="group/split relative">
        <button className={`${itemClass} pr-1`}>
          <span className="flex-1">Split</span>
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <div className="absolute left-full top-0 hidden min-w-36 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg group-hover/split:block group-focus-within/split:block">
          <button className={itemClass} onClick={() => run(() => split('vertical', 'before'))}>Split Up</button>
          <button className={itemClass} onClick={() => run(() => split('vertical', 'after'))}>Split Down</button>
          <button className={itemClass} onClick={() => run(() => split('horizontal', 'before'))}>Split Left</button>
          <button className={itemClass} onClick={() => run(() => split('horizontal', 'after'))}>Split Right</button>
        </div>
      </div>
    </div>
  );
}
