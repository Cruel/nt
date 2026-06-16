import { Link, useLocation } from '@tanstack/react-router';
import {
  SidebarHeader,
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from '@/components/ui/sidebar';
import {
  LayoutDashboard,
  Puzzle,
  Settings,
  SquarePen,
} from 'lucide-react';

const navItems = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/workspace', label: 'Workspace', icon: SquarePen },
  { to: '/components', label: 'Components', icon: Puzzle },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function AppSidebar() {
  const location = useLocation();

  return (
    <>
      <SidebarHeader>
        <Link
          to="/"
          className="flex items-center gap-2 text-lg font-semibold tracking-tight"
        >
          <span className="flex h-6 w-6 items-center justify-center rounded bg-primary text-[10px] font-bold text-primary-foreground">
            NT
          </span>
          NovelTea
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup label="Navigation">
          <SidebarMenu>
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = location.pathname === item.to;
              return (
                <SidebarMenuItem key={item.to} active={active}>
                  <Link to={item.to} className="block">
                    <SidebarMenuButton>
                      <Icon className="h-4 w-4" />
                      {item.label}
                    </SidebarMenuButton>
                  </Link>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
    </>
  );
}
