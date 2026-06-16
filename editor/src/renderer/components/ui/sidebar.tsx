import {
  createContext,
  useContext,
  useState,
  useCallback,
  type HTMLAttributes,
  type ComponentProps,
} from 'react';
import { cn } from '@/lib/utils';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';

interface SidebarContextValue {
  expanded: boolean;
  setExpanded: (v: boolean) => void;
  toggle: () => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

function useSidebar() {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error('useSidebar must be used within a SidebarProvider');
  return ctx;
}

interface SidebarProviderProps {
  defaultExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (v: boolean) => void;
  children: React.ReactNode;
}

function SidebarProvider({
  defaultExpanded = true,
  expanded: controlledExpanded,
  onExpandedChange,
  children,
}: SidebarProviderProps) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const expanded =
    controlledExpanded !== undefined ? controlledExpanded : internalExpanded;

  const setExpanded = useCallback(
    (v: boolean) => {
      setInternalExpanded(v);
      onExpandedChange?.(v);
    },
    [onExpandedChange],
  );

  const toggle = useCallback(
    () => setExpanded(!expanded),
    [expanded, setExpanded],
  );

  return (
    <SidebarContext.Provider value={{ expanded, setExpanded, toggle }}>
      {children}
    </SidebarContext.Provider>
  );
}

function Sidebar({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  const { expanded } = useSidebar();
  return (
    <div
      data-expanded={expanded}
      className={cn(
        'group/sidebar relative flex flex-col border-r bg-sidebar-background text-sidebar-foreground transition-all duration-200',
        expanded ? 'w-60' : 'w-0 overflow-hidden border-r-0',
        className,
      )}
      {...props}
    />
  );
}

function SidebarHeader({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex h-12 items-center border-b px-4', className)}
      {...props}
    />
  );
}

function SidebarContent({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex-1 overflow-y-auto', className)}
      {...props}
    />
  );
}

function SidebarFooter({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex items-center border-t px-4 py-2',
        className,
      )}
      {...props}
    />
  );
}

function SidebarGroup({
  className,
  label,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { label?: string }) {
  return (
    <div className={cn('px-3 py-2', className)} {...props}>
      {label && (
        <div className="mb-1 px-2 text-xs font-semibold uppercase tracking-wider text-sidebar-foreground/60">
          {label}
        </div>
      )}
      {children}
    </div>
  );
}

function SidebarMenu({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col gap-0.5', className)}
      {...props}
    />
  );
}

function SidebarMenuItem({
  className,
  active,
  ...props
}: HTMLAttributes<HTMLDivElement> & { active?: boolean }) {
  return (
    <div
      data-active={active || undefined}
      className={cn(
        'group/menuitem',
        active && 'bg-sidebar-accent text-sidebar-accent-foreground',
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenuButton({
  className,
  children,
  ...props
}: ComponentProps<'button'>) {
  return (
    <button
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground aria-disabled:opacity-50 group-data-[active]/menuitem:bg-sidebar-accent group-data-[active]/menuitem:text-sidebar-accent-foreground',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

function SidebarRail() {
  const { expanded, toggle } = useSidebar();
  return (
    <button
      type="button"
      onClick={toggle}
      className="absolute -right-3 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border bg-background shadow-sm hover:bg-accent"
    >
      {expanded ? (
        <PanelLeftClose className="h-3 w-3" />
      ) : (
        <PanelLeftOpen className="h-3 w-3" />
      )}
    </button>
  );
}

export {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarRail,
  useSidebar,
};
