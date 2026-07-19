import { useDroppable } from '@dnd-kit/core';
import { RotateCcw, SplitSquareHorizontal, SplitSquareVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import { defaultEditorRegistry } from './default-editors';
import { renderEditorToolbar } from './editor-registry';
import { useProjectStore } from '@/project/project-store';
import { useCloseGuardStore } from './close-guard-store';
import { selectDraftDirtyByTabId, useDraftDirtyStore } from './draft-dirty-store';
import { getTabDirtyState } from './dirty-state';
import { useWorkbenchStore } from './workbench-store';
import { WorkbenchTabContextMenu } from './WorkbenchTabContextMenu';
import { workbenchTabGroupDndId } from './WorkbenchTabDndContext';
import { WorkbenchTabItem } from './WorkbenchTabItem';
import type { WorkbenchGroup, WorkbenchTab } from './workbench-types';

interface WorkbenchTabsProps {
  group: WorkbenchGroup;
  tabs: WorkbenchTab[];
}

export function WorkbenchTabs({ group, tabs }: WorkbenchTabsProps) {
  const recentlyClosedTabs = useWorkbenchStore((state) => state.recentlyClosedTabs);
  const activateTab = useWorkbenchStore((state) => state.activateTab);
  const requestCloseTab = useCloseGuardStore((state) => state.requestCloseTab);
  const splitGroup = useWorkbenchStore((state) => state.splitGroup);
  const reopenLastClosedTab = useWorkbenchStore((state) => state.reopenLastClosedTab);
  const { setNodeRef: setDroppableNodeRef } = useDroppable({
    id: workbenchTabGroupDndId(group.id),
    data: { kind: 'workbench-tab-group', groupId: group.id },
  });
  const project = useProjectStore((state) => state.document);
  const savedDocument = useProjectStore((state) => state.savedDocument);
  const draftEntries = useDraftDirtyStore((state) => state.entriesByKey);
  const draftDirtyByTabId = selectDraftDirtyByTabId({ entriesByKey: draftEntries });
  const activeTabId = group.activeTabId;
  const activeTab = activeTabId ? (tabs.find((tab) => tab.id === activeTabId) ?? null) : null;
  const splitActive = (direction: 'horizontal' | 'vertical') => {
    splitGroup({
      sourceGroupId: group.id,
      direction,
      tabId: activeTab?.id,
      moveTab: false,
    });
  };

  return (
    <div className="flex h-8 shrink-0 items-stretch border-t bg-background">
      <div
        ref={setDroppableNodeRef}
        data-workbench-tab-strip-id={group.id}
        className="relative flex min-w-0 flex-1 self-stretch overflow-x-auto"
      >
        {tabs.map((tab, index) => {
          const active = tab.id === activeTabId;
          const dirty = getTabDirtyState(tab, project, savedDocument, draftDirtyByTabId).dirty;
          return (
            <ContextMenu key={tab.id}>
              <ContextMenuTrigger
                className="contents"
                onContextMenuCapture={() => activateTab(group.id, tab.id)}
              >
                <WorkbenchTabItem
                  groupId={group.id}
                  tab={tab}
                  active={active}
                  dirty={dirty}
                  index={index}
                  onActivate={() => activateTab(group.id, tab.id)}
                  onRequestClose={() => requestCloseTab(group.id, tab.id)}
                />
              </ContextMenuTrigger>
              <WorkbenchTabContextMenu group={group} tab={tab} />
            </ContextMenu>
          );
        })}
        <div className="min-w-3 flex-1 border-b" />
      </div>
      <div className="flex shrink-0 items-center gap-0 border-b px-1">
        {activeTab ? renderEditorToolbar(defaultEditorRegistry, activeTab) : null}
        {activeTab ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0"
              aria-label="Split right"
              onClick={() => splitActive('horizontal')}
            >
              <SplitSquareHorizontal className="h-3 w-3" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0"
              aria-label="Split down"
              onClick={() => splitActive('vertical')}
            >
              <SplitSquareVertical className="h-3 w-3" />
            </Button>
          </>
        ) : null}
        {recentlyClosedTabs.length > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0"
            aria-label="Reopen closed tab"
            onClick={reopenLastClosedTab}
          >
            <RotateCcw className="h-3 w-3" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
