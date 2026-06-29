import type { ReactNode } from 'react';
import { AppSidebar } from './app-sidebar';
import { SidebarProvider, SidebarRail, Sidebar } from '@/components/ui/sidebar';
import { useWorkspaceStore } from '@/stores/workspace-store';

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const sidebarExpanded = useWorkspaceStore((s) => s.sidebarExpanded);
  const setSidebarExpanded = useWorkspaceStore((s) => s.setSidebarExpanded);

  return (
    <SidebarProvider
      expanded={sidebarExpanded}
      onExpandedChange={setSidebarExpanded}
    >
      <div className="flex h-dvh w-dvw overflow-hidden">
        <Sidebar>
          <AppSidebar />
          <SidebarRail />
        </Sidebar>
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {children}
        </main>
      </div>
    </SidebarProvider>
  );
}
