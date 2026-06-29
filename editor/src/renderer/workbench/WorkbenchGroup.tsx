import { defaultEditorRegistry } from './default-editors';
import { missingEditorRegistration } from './editor-registry';
import { WorkbenchTabs } from './WorkbenchTabs';
import type { WorkbenchGroup as WorkbenchGroupModel, WorkbenchTab } from './workbench-types';

interface WorkbenchGroupProps {
  group: WorkbenchGroupModel;
  tabs: WorkbenchTab[];
}

export function WorkbenchGroup({ group, tabs }: WorkbenchGroupProps) {
  const activeTab = group.activeTabId ? tabs.find((tab) => tab.id === group.activeTabId) ?? null : null;
  const registration = activeTab
    ? defaultEditorRegistry.resolve(activeTab.editorType) ?? missingEditorRegistration
    : null;
  const EditorComponent = registration?.component;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden border bg-background">
      <WorkbenchTabs group={group} tabs={tabs} />
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab && EditorComponent ? (
          <EditorComponent tab={activeTab} />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
            <div>
              <div className="font-medium text-foreground">No tab open</div>
              <div className="mt-1">Open a project record or reopen the preview.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
