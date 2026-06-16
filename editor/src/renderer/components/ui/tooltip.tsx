import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import { cn } from '@/lib/utils';
import type { ComponentProps, ReactNode } from 'react';

type TooltipProps = ComponentProps<typeof BaseTooltip.Root>;

function Tooltip({ children, ...props }: TooltipProps) {
  return <BaseTooltip.Root {...props}>{children}</BaseTooltip.Root>;
}

type TooltipTriggerProps = ComponentProps<typeof BaseTooltip.Trigger>;

function TooltipTrigger({ className, ...props }: TooltipTriggerProps) {
  return <BaseTooltip.Trigger className={cn(className)} {...props} />;
}

interface TooltipPopupProps extends ComponentProps<typeof BaseTooltip.Popup> {
  children: ReactNode;
}

function TooltipPopup({ className, children, ...props }: TooltipPopupProps) {
  return (
    <BaseTooltip.Portal>
      <BaseTooltip.Positioner>
        <BaseTooltip.Popup
          className={cn(
            'z-50 overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground shadow-md',
            className,
          )}
          {...props}
        >
          {children}
        </BaseTooltip.Popup>
      </BaseTooltip.Positioner>
    </BaseTooltip.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipPopup };
