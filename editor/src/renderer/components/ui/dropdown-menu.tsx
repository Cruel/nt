import { Menu as BaseMenu } from '@base-ui/react/menu';
import { cn } from '@/lib/utils';
import type { ComponentProps, ReactNode } from 'react';

type MenuProps = ComponentProps<typeof BaseMenu.Root>;

function Menu({ children, ...props }: MenuProps) {
  return <BaseMenu.Root {...props}>{children}</BaseMenu.Root>;
}

type MenuTriggerProps = ComponentProps<typeof BaseMenu.Trigger>;

function MenuTrigger({ className, ...props }: MenuTriggerProps) {
  return <BaseMenu.Trigger className={cn(className)} {...props} />;
}

interface MenuPopupProps extends ComponentProps<typeof BaseMenu.Popup> {
  children: ReactNode;
}

function MenuPopup({ className, children, ...props }: MenuPopupProps) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner>
        <BaseMenu.Popup
          className={cn(
            'z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
            className,
          )}
          {...props}
        >
          {children}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

type MenuItemProps = ComponentProps<typeof BaseMenu.Item>;

function MenuItem({ className, ...props }: MenuItemProps) {
  return (
    <BaseMenu.Item
      className={cn(
        'relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0',
        className,
      )}
      {...props}
    />
  );
}

type MenuSeparatorProps = ComponentProps<typeof BaseMenu.Separator>;

function MenuSeparator({ className, ...props }: MenuSeparatorProps) {
  return (
    <BaseMenu.Separator
      className={cn('-mx-1 my-1 h-px bg-muted', className)}
      {...props}
    />
  );
}

export { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator };
