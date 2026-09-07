import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface EditorHelpIconProps {
  label: string;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

export function EditorHelpIcon({
  label,
  children,
  className,
  contentClassName,
}: EditorHelpIconProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            className={cn(
              'inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30',
              className,
            )}
          />
        }
      >
        <Info className="size-3.5" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent side="right" className={cn('max-w-72 text-xs', contentClassName)}>
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

interface EditorSectionHeadingProps {
  title: ReactNode;
  help?: ReactNode;
  helpLabel?: string;
  className?: string;
  titleClassName?: string;
}

export function EditorSectionHeading({
  title,
  help,
  helpLabel = 'About this section',
  className,
  titleClassName,
}: EditorSectionHeadingProps) {
  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <h3 className={cn('text-sm font-semibold', titleClassName)}>{title}</h3>
      {help ? <EditorHelpIcon label={helpLabel}>{help}</EditorHelpIcon> : null}
    </div>
  );
}
