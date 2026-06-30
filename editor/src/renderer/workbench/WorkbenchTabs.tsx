import { ArrowDownToLine, ArrowRightToLine, ChevronLeft, ChevronRight, PanelRightOpen, RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { defaultEditorRegistry } from './default-editors';
import { editorIconForType, renderEditorToolbar } from './editor-registry';
import { buildPrimaryPreviewTab } from './editor-registry';
import { useProjectStore } from '@/project/project-store';
import { useCloseGuardStore } from './close-guard-store';
import { selectDraftDirtyByTabId, useDraftDirtyStore } from './draft-dirty-store';
import { getTabDirtyState } from './dirty-state';
import { useWorkbenchStore } from './workbench-store';
import type { WorkbenchGroup, WorkbenchTab } from './workbench-types';

interface WorkbenchTabsProps {
  group: WorkbenchGroup;
  tabs: WorkbenchTab[];
}

export function WorkbenchTabs({ group, tabs }: WorkbenchTabsProps) {
  const activeGroupId = useWorkbenchStore((state) => state.activeGroupId);
  const groupsById = useWorkbenchStore((state) => state.groupsById);
  const recentlyClosedTabs = useWorkbenchStore((state) => state.recentlyClosedTabs);
  const activateTab = useWorkbenchStore((state) => state.activateTab);
  const requestCloseTab = useCloseGuardStore((state) => state.requestCloseTab);
  const splitGroup = useWorkbenchStore((state) => state.splitGroup);
  const moveTab = useWorkbenchStore((state) => state.moveTab);
  const moveTabWithinGroup = useWorkbenchStore((state) => state.moveTabWithinGroup);
  const openTab = useWorkbenchStore((state) => state.openTab);
  const reopenLastClosedTab = useWorkbenchStore((state) => state.reopenLastClosedTab);
  const project = useProjectStore((state) => state.document);
  const savedDocument = useProjectStore((state) => state.savedDocument);
  const draftEntries = useDraftDirtyStore((state) => state.entriesByKey);
  const draftDirtyByTabId = selectDraftDirtyByTabId({ entriesByKey: draftEntries });
  const activeTabId = group.activeTabId;
  const activeTab = activeTabId ? tabs.find((tab) => tab.id === activeTabId) ?? null : null;
  const otherGroup = Object.values(groupsById).find((candidate) => candidate.id !== group.id);
  const focused = activeGroupId === group.id;

  const splitActive = (direction: 'horizontal' | 'vertical') => {
    splitGroup({
      sourceGroupId: group.id,
      direction,
      tabId: activeTab?.id,
      moveTab: false,
    });
  };

  return (
    <div className={`flex h-10 shrink-0 items-center border-b bg-muted/20 ${focused ? 'ring-1 ring-inset ring-primary/20' : ''}`}>
      <div className="flex min-w-0 flex-1 self-stretch overflow-x-auto">
        {tabs.map((tab, index) => {
          const Icon = editorIconForType(tab.editorType);
          const active = tab.id === activeTabId;
          const dirty = getTabDirtyState(tab, project, savedDocument, draftDirtyByTabId).dirty;
          return (
            <div
              key={tab.id}
              className={`group/tab flex min-w-32 max-w-56 items-center gap-1 border-r px-2 text-xs ${
                active ? 'bg-background text-foreground' : 'text-muted-foreground hover:bg-accent/60'
              }`}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1 text-left"
                onClick={() => activateTab(group.id, tab.id)}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">
                  {dirty ? '● ' : ''}
                  {tab.title}
                </span>
              </button>
              <button
                type="button"
                className="rounded p-0.5 opacity-60 hover:bg-muted hover:opacity-100"
                aria-label={`Move ${tab.title} left`}
                disabled={index === 0}
                onClick={() => moveTabWithinGroup(group.id, tab.id, index - 1)}
              >
                <ChevronLeft className="h-3 w-3" />
              </button>
              <button
                type="button"
                className="rounded p-0.5 opacity-60 hover:bg-muted hover:opacity-100"
                aria-label={`Move ${tab.title} right`}
                disabled={index === tabs.length - 1}
                onClick={() => moveTabWithinGroup(group.id, tab.id, index + 1)}
              >
                <ChevronRight className="h-3 w-3" />
              </button>
              {otherGroup ? (
                <button
                  type="button"
                  className="rounded p-0.5 opacity-60 hover:bg-muted hover:opacity-100"
                  aria-label={`Move ${tab.title} to another group`}
                  onClick={() => moveTab({ tabId: tab.id, fromGroupId: group.id, toGroupId: otherGroup.id })}
                >
                  <PanelRightOpen className="h-3 w-3" />
                </button>
              ) : null}
              <button
                type="button"
                className="rounded p-0.5 opacity-60 hover:bg-muted hover:opacity-100"
                aria-label={`Close ${tab.title}`}
                onClick={() => requestCloseTab(group.id, tab.id)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
      <div className="flex shrink-0 items-center gap-1 px-2">
        {activeTab ? renderEditorToolbar(defaultEditorRegistry, activeTab) : null}
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label="Split right" onClick={() => splitActive('horizontal')}>
          <ArrowRightToLine className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label="Split down" onClick={() => splitActive('vertical')}>
          <ArrowDownToLine className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          aria-label="Reopen closed tab"
          disabled={recentlyClosedTabs.length === 0}
          onClick={reopenLastClosedTab}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
        {tabs.length === 0 ? (
          <Button size="sm" variant="outline" className="h-7" onClick={() => openTab(buildPrimaryPreviewTab())}>
            Reopen Preview
          </Button>
        ) : null}
      </div>
    </div>
  );
}
