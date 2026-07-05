import {
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from '@/components/ui/sidebar';
import { Puzzle, Settings } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '@/project/project-store';
import { buildProjectTree, useWorkspaceStore } from '@/stores/workspace-store';
import {
  buildComponentsTab,
  buildSettingsTab,
} from '@/workbench/editor-registry';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { ProjectExplorer } from '@/workspace/ProjectExplorer';

const utilityItems = [
  { tab: buildComponentsTab, labelKey: 'workspace:sidebar.components', icon: Puzzle },
  { tab: buildSettingsTab, labelKey: 'workspace:sidebar.settings', icon: Settings },
];

export function AppSidebar() {
  const { t } = useTranslation('workspace');
  const project = useProjectStore((state) => state.document);
  const tests = useWorkspaceStore((state) => state.playbackTests);
  const openTab = useWorkbenchStore((state) => state.openTab);
  const tabsById = useWorkbenchStore((state) => state.tabsById);
  const activeGroupId = useWorkbenchStore((state) => state.activeGroupId);
  const groupsById = useWorkbenchStore((state) => state.groupsById);
  const nodes = useMemo(() => buildProjectTree(project, tests), [project, tests]);
  const activeTabId = groupsById[activeGroupId]?.activeTabId ?? null;

  return (
    <>
      <SidebarContent className="overflow-hidden px-0 py-0">
        <ProjectExplorer nodes={nodes} />
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <div className="flex items-center justify-center gap-1 group-data-[collapsible=icon]:flex-col">
            {utilityItems.map((item) => {
              const Icon = item.icon;
              const tab = item.tab();
              const label = t(item.labelKey);
              const active = activeTabId ? tabsById[activeTabId]?.resource?.stableId === tab.resource?.stableId : false;
              return (
                <SidebarMenuItem key={item.labelKey}>
                  <SidebarMenuButton
                    isActive={active}
                    tooltip={label}
                    className="h-8 w-8 justify-center p-0"
                    onClick={() => openTab(tab)}
                  >
                    <Icon className="h-4 w-4" />
                    <span className="sr-only">{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </div>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}
