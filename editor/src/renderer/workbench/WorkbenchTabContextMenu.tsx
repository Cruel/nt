import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu';
import { useCloseGuardStore } from './close-guard-store';
import { useWorkbenchStore } from './workbench-store';
import type { WorkbenchGroup, WorkbenchSplitDirection, WorkbenchTab } from './workbench-types';

interface WorkbenchTabContextMenuProps {
  group: WorkbenchGroup;
  tab: WorkbenchTab;
}

export function WorkbenchTabContextMenu({ group, tab }: WorkbenchTabContextMenuProps) {
  const requestCloseTab = useCloseGuardStore((store) => store.requestCloseTab);
  const requestCloseOtherTabs = useCloseGuardStore((store) => store.requestCloseOtherTabs);
  const requestCloseTabsToRight = useCloseGuardStore((store) => store.requestCloseTabsToRight);
  const requestCloseAllTabsInGroup = useCloseGuardStore(
    (store) => store.requestCloseAllTabsInGroup,
  );
  const splitGroup = useWorkbenchStore((store) => store.splitGroup);
  const tabIndex = group.tabIds.indexOf(tab.id);
  if (tabIndex < 0) return null;

  const hasOtherTabs = group.tabIds.length > 1;
  const hasTabsToRight = tabIndex < group.tabIds.length - 1;

  function split(direction: WorkbenchSplitDirection, placement: 'before' | 'after') {
    splitGroup({
      sourceGroupId: group.id,
      direction,
      placement,
      tabId: tab.id,
      moveTab: false,
    });
  }

  return (
    <ContextMenuContent className="min-w-44">
      <ContextMenuItem onClick={() => requestCloseTab(group.id, tab.id)}>Close</ContextMenuItem>
      <ContextMenuItem
        disabled={!hasOtherTabs}
        onClick={() => requestCloseOtherTabs(group.id, tab.id)}
      >
        Close Others
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!hasTabsToRight}
        onClick={() => requestCloseTabsToRight(group.id, tab.id)}
      >
        Close to the Right
      </ContextMenuItem>
      <ContextMenuItem
        disabled={group.tabIds.length === 0}
        onClick={() => requestCloseAllTabsInGroup(group.id)}
      >
        Close All
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuSub>
        <ContextMenuSubTrigger>Split</ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuItem onClick={() => split('vertical', 'before')}>Split Up</ContextMenuItem>
          <ContextMenuItem onClick={() => split('vertical', 'after')}>Split Down</ContextMenuItem>
          <ContextMenuItem onClick={() => split('horizontal', 'before')}>
            Split Left
          </ContextMenuItem>
          <ContextMenuItem onClick={() => split('horizontal', 'after')}>
            Split Right
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
    </ContextMenuContent>
  );
}
