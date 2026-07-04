import { useDroppable } from '@dnd-kit/core';
import { useProjectStore } from '@/project/project-store';
import { WorkspaceDashboard } from '@/workspace/WorkspaceDashboard';
import { defaultEditorRegistry } from './default-editors';
import { missingEditorRegistration } from './editor-registry';
import { WorkbenchTabs } from './WorkbenchTabs';
import { workbenchTabDockDndId } from './WorkbenchTabDndContext';
import { useWorkbenchStore } from './workbench-store';
import type { WorkbenchGroup as WorkbenchGroupModel, WorkbenchTab } from './workbench-types';

interface WorkbenchGroupProps {
  group: WorkbenchGroupModel;
  tabs: WorkbenchTab[];
}

export function WorkbenchGroup({ group, tabs }: WorkbenchGroupProps) {
  const project = useProjectStore((state) => state.document);
  const activateGroup = useWorkbenchStore((state) => state.activateGroup);
  const activeTab = group.activeTabId ? tabs.find((tab) => tab.id === group.activeTabId) ?? null : null;
  const { setNodeRef: setDockNodeRef } = useDroppable({
    id: workbenchTabDockDndId(group.id),
    data: { kind: 'workbench-tab-dock-group', groupId: group.id },
  });
  const registration = activeTab
    ? defaultEditorRegistry.resolve(activeTab.editorType) ?? missingEditorRegistration
    : null;
  const EditorComponent = registration?.component;

  return (
    // The data attribute lets nested iframe widgets activate their containing group via postMessage activity.
    <div ref={setDockNodeRef} className="flex h-full min-h-0 flex-col overflow-hidden border-x border-b bg-background" data-workbench-group-id={group.id} onFocusCapture={() => activateGroup(group.id)} onPointerDownCapture={() => activateGroup(group.id)}>
      <WorkbenchTabs group={group} tabs={tabs} />
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab && EditorComponent ? (
          <EditorComponent tab={activeTab} />
        ) : project ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
            <div>
              <div className="font-medium text-foreground">No tab open</div>
              <div className="mt-1">Open a project record or reopen the preview.</div>
            </div>
          </div>
        ) : (
          <WorkspaceDashboard />
        )}
      </div>
    </div>
  );
}
