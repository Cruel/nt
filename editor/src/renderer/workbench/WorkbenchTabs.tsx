import { ArrowDownToLine, ArrowRightToLine, RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { defaultEditorRegistry } from './default-editors';
import { editorIconClassNameForTab, editorIconForType, renderEditorToolbar } from './editor-registry';
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
  const recentlyClosedTabs = useWorkbenchStore((state) => state.recentlyClosedTabs);
  const activateTab = useWorkbenchStore((state) => state.activateTab);
  const requestCloseTab = useCloseGuardStore((state) => state.requestCloseTab);
  const splitGroup = useWorkbenchStore((state) => state.splitGroup);
  const openTab = useWorkbenchStore((state) => state.openTab);
  const reopenLastClosedTab = useWorkbenchStore((state) => state.reopenLastClosedTab);
  const project = useProjectStore((state) => state.document);
  const savedDocument = useProjectStore((state) => state.savedDocument);
  const draftEntries = useDraftDirtyStore((state) => state.entriesByKey);
  const draftDirtyByTabId = selectDraftDirtyByTabId({ entriesByKey: draftEntries });
  const activeTabId = group.activeTabId;
  const activeTab = activeTabId ? tabs.find((tab) => tab.id === activeTabId) ?? null : null;
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
      <div className="flex min-w-0 flex-1 self-stretch overflow-x-auto">
        {tabs.map((tab, index) => {
          const Icon = editorIconForType(tab.editorType);
          const active = tab.id === activeTabId;
          const activeChrome = index === 0
            ? 'inset -1px 0 0 hsl(var(--border)), inset 0 1px 0 rgba(255,255,255,0.6)'
            : 'inset 1px 0 0 hsl(var(--border)), inset -1px 0 0 hsl(var(--border)), inset 0 1px 0 rgba(255,255,255,0.6)';
          const dirty = getTabDirtyState(tab, project, savedDocument, draftDirtyByTabId).dirty;
          return (
            <div
              key={tab.id}
              className={`group/tab flex min-w-28 max-w-52 items-center gap-1 px-1.5 text-xs ${
                active
                  ? 'border-b border-transparent bg-background text-foreground'
                  : 'border-b border-r bg-background text-muted-foreground hover:bg-accent/60'
              }`}
              style={active ? { boxShadow: activeChrome } : undefined}
            >
              <button
                type="button"
                className="flex h-full min-w-0 flex-1 items-center gap-1 self-stretch text-left"
                onClick={() => activateTab(group.id, tab.id)}
              >
                <Icon className={`h-3.5 w-3.5 shrink-0 ${editorIconClassNameForTab(tab)}`} />
                <span className="truncate">
                  {dirty ? '● ' : ''}
                  {tab.title}
                </span>
              </button>
              <button
                type="button"
                className={`ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center self-center rounded leading-none opacity-0 hover:bg-muted hover:opacity-100 focus-visible:opacity-100 ${
                  active ? 'opacity-70' : 'group-hover/tab:opacity-60'
                }`}
                aria-label={`Close ${tab.title}`}
                onClick={() => requestCloseTab(group.id, tab.id)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
        <div className="min-w-3 flex-1 border-b" />
      </div>
      <div className="flex shrink-0 items-center gap-1 border-b px-1.5">
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
