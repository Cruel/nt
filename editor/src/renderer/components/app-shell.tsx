import { useCallback, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { AppMenuBar } from './app-menu-bar';
import { AppSidebar } from './app-sidebar';
import { ResizeSeparatorOverlay } from './resize-separator';
import { SidebarProvider, Sidebar, SidebarInset } from '@/components/ui/sidebar';
import { useWorkspaceStore } from '@/stores/workspace-store';

interface AppShellProps {
  children: ReactNode;
}

const SIDEBAR_TOP_OFFSET = 32;
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_ICON_WIDTH = 48;

function clampSidebarWidth(width: number) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

export function AppShell({ children }: AppShellProps) {
  const sidebarExpanded = useWorkspaceStore((s) => s.sidebarExpanded);
  const sidebarWidth = useWorkspaceStore((s) => s.sidebarWidth);
  const setSidebarExpanded = useWorkspaceStore((s) => s.setSidebarExpanded);
  const setSidebarWidth = useWorkspaceStore((s) => s.setSidebarWidth);

  const onResizePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!sidebarExpanded || event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;

    function onPointerMove(moveEvent: globalThis.PointerEvent) {
      setSidebarWidth(clampSidebarWidth(startWidth + moveEvent.clientX - startX));
    }

    function onPointerUp() {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
  }, [setSidebarWidth, sidebarExpanded, sidebarWidth]);

  const activeSidebarWidth = sidebarExpanded ? sidebarWidth : SIDEBAR_ICON_WIDTH;

  return (
    <SidebarProvider
      open={sidebarExpanded}
      onOpenChange={setSidebarExpanded}
      style={{
        '--sidebar-width': `${sidebarWidth}px`,
        '--sidebar-width-icon': `${SIDEBAR_ICON_WIDTH}px`,
      } as CSSProperties}
    >
      <div className="flex h-dvh w-dvw flex-col overflow-hidden">
        <AppMenuBar />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <Sidebar collapsible="icon" className="top-8 h-[calc(100svh-2rem)]">
            <AppSidebar />
          </Sidebar>
          {sidebarExpanded && (
            <ResizeSeparatorOverlay
              orientation="horizontal"
              aria-label="Resize sidebar"
              role="separator"
              aria-orientation="vertical"
              className="fixed z-30"
              style={{
                left: activeSidebarWidth - 1,
                top: SIDEBAR_TOP_OFFSET,
                height: `calc(100svh - ${SIDEBAR_TOP_OFFSET}px)`,
              }}
              onPointerDown={onResizePointerDown}
            />
          )}
          <SidebarInset className="min-w-0 overflow-hidden">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {children}
            </div>
          </SidebarInset>
        </div>
      </div>
    </SidebarProvider>
  );
}
