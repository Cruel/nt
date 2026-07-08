import { useDroppable } from '@dnd-kit/core';
import { useEffect } from 'react';
import { useProjectStore } from '@/project/project-store';
import { PreviewHostPoolProvider } from '@/preview/preview-host-pool';
import { WorkspaceDashboard } from '@/workspace/WorkspaceDashboard';
import { defaultEditorRegistry } from './default-editors';
import { missingEditorRegistration, resolveEditorPolicies, type WorkbenchEditorRegistration, type ResolvedWorkbenchEditorPolicies } from './editor-registry';
import { WorkbenchTabs } from './WorkbenchTabs';
import { workbenchTabDockDndId } from './WorkbenchTabDndContext';
import { captureWorkbenchTabState, restoreWorkbenchTabState } from './workbench-tab-state';
import { useWorkbenchStore } from './workbench-store';
import type { WorkbenchGroup as WorkbenchGroupModel, WorkbenchTab } from './workbench-types';

interface WorkbenchGroupProps {
  group: WorkbenchGroupModel;
  tabs: WorkbenchTab[];
}

interface WorkbenchEditorPaneProps {
  tab: WorkbenchTab;
  registration: WorkbenchEditorRegistration;
  policies: ResolvedWorkbenchEditorPolicies;
  isActive: boolean;
}

function WorkbenchEditorPane({ tab, registration, policies, isActive }: WorkbenchEditorPaneProps) {
  const EditorComponent = registration.component;

  useEffect(() => {
    if (isActive) restoreWorkbenchTabState(tab.id);
  }, [isActive, tab.id]);

  useEffect(() => () => {
    if (policies.mountPolicy === 'active-only') captureWorkbenchTabState(tab.id);
  }, [policies.mountPolicy, tab.id]);

  return (
    <div
      aria-hidden={isActive ? undefined : true}
      className={isActive ? 'h-full min-h-0' : 'pointer-events-none invisible absolute inset-0 h-full min-h-0'}
      data-workbench-editor-pane={tab.id}
      data-hidden={isActive ? undefined : true}
      inert={isActive ? undefined : true}
    >
      <EditorComponent tab={tab} />
    </div>
  );
}

export function WorkbenchGroup({ group, tabs }: WorkbenchGroupProps) {
  const project = useProjectStore((state) => state.document);
  const activateGroup = useWorkbenchStore((state) => state.activateGroup);
  const activeTab = group.activeTabId ? tabs.find((tab) => tab.id === group.activeTabId) ?? null : null;
  const { setNodeRef: setDockNodeRef } = useDroppable({
    id: workbenchTabDockDndId(group.id),
    data: { kind: 'workbench-tab-dock-group', groupId: group.id },
  });
  const editorPanes = tabs.flatMap((tab) => {
    const registration = defaultEditorRegistry.resolve(tab.editorType) ?? missingEditorRegistration;
    const policies = resolveEditorPolicies(registration);
    const isActive = tab.id === activeTab?.id;
    if (!isActive && policies.mountPolicy !== 'keep-mounted-while-open') return [];
    return [{ tab, registration, policies, isActive }];
  });

  return (
    // The data attribute lets nested iframe widgets activate their containing group via postMessage activity.
    <div ref={setDockNodeRef} className="flex h-full min-h-0 flex-col overflow-hidden border-x border-b bg-background" data-workbench-group-id={group.id} onFocusCapture={() => activateGroup(group.id)} onPointerDownCapture={() => activateGroup(group.id)}>
      <WorkbenchTabs group={group} tabs={tabs} />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <PreviewHostPoolProvider groupId={group.id} activeTabId={activeTab?.id ?? null}>
          {activeTab ? (
            editorPanes.map(({ tab, registration, policies, isActive }) => {
              return (
                <WorkbenchEditorPane
                  key={tab.id}
                  tab={tab}
                  registration={registration}
                  policies={policies}
                  isActive={isActive}
                />
              );
            })
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
