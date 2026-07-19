import { useDroppable } from '@dnd-kit/core';
import { useProjectStore } from '@/project/project-store';
import { PreviewHostPoolProvider } from '@/preview/preview-host-pool';
import { WorkspaceDashboard } from '@/workspace/WorkspaceDashboard';
import { defaultEditorRegistry } from './default-editors';
import { resolveWorkbenchEditor } from './editor-registry';
import {
  PersistentEditorSlot,
  usePersistentEditorLayoutInteractionActive,
} from './persistent-editor-host';
import { WorkbenchGroupPreviewHostPoolRegistration } from './workbench-group-services';
import { WorkbenchEditorPane } from './WorkbenchEditorPane';
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
  const activateTab = useWorkbenchStore((state) => state.activateTab);
  const activeTab = group.activeTabId
    ? (tabs.find((tab) => tab.id === group.activeTabId) ?? null)
    : null;
  const { setNodeRef: setDockNodeRef } = useDroppable({
    id: workbenchTabDockDndId(group.id),
    data: { kind: 'workbench-tab-dock-group', groupId: group.id },
  });
  const activeEditor = activeTab ? resolveWorkbenchEditor(defaultEditorRegistry, activeTab) : null;
  const layoutInteractionActive = usePersistentEditorLayoutInteractionActive();

  return (
    // The data attribute lets nested iframe widgets activate their containing group via postMessage activity.
    <div
      ref={setDockNodeRef}
      className="flex h-full min-h-0 flex-col overflow-hidden border-x border-b bg-background"
      data-workbench-group-id={group.id}
      onFocusCapture={() => activateGroup(group.id)}
      onPointerDownCapture={() => activateGroup(group.id)}
    >
      <WorkbenchTabs group={group} tabs={tabs} />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <PreviewHostPoolProvider
          groupId={group.id}
          activeTabId={activeTab?.id ?? null}
          onActivateOwnerTab={(ownerTabId) => activateTab(group.id, ownerTabId)}
          pointerEventsDisabled={layoutInteractionActive}
        >
          <WorkbenchGroupPreviewHostPoolRegistration groupId={group.id} />
          {activeTab ? (
            activeEditor?.policies.mountPolicy === 'keep-mounted-while-open' ? (
              <PersistentEditorSlot key={activeTab.id} tabId={activeTab.id} groupId={group.id} />
            ) : activeEditor ? (
              <WorkbenchEditorPane
                key={activeTab.id}
                tab={activeTab}
                registration={activeEditor.registration}
                policies={activeEditor.policies}
                location={{
                  tabId: activeTab.id,
                  groupId: group.id,
                  isActiveInGroup: true,
                  isVisible: true,
                }}
              />
            ) : null
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
        </PreviewHostPoolProvider>
      </div>
    </div>
  );
}
