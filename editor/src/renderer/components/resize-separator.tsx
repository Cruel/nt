import { Separator as PanelSeparator } from 'react-resizable-panels';
import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '@/lib/utils';

export type ResizeSeparatorOrientation = 'horizontal' | 'vertical';

function isHorizontalGroup(orientation: ResizeSeparatorOrientation) {
  return orientation === 'horizontal';
}

function resizeSeparatorRootClasses(orientation: ResizeSeparatorOrientation) {
  return cn(
    'relative z-10 shrink-0 overflow-visible bg-border transition-colors hover:bg-primary/50 data-[resize-handle-active]:bg-primary/60',
    isHorizontalGroup(orientation) ? 'w-[2px] cursor-col-resize' : 'h-[2px] cursor-row-resize',
  );
}

function ResizeSeparatorHitTarget({ orientation }: { orientation: ResizeSeparatorOrientation }) {
  return (
    <div
      className={cn(
        'absolute bg-transparent',
        isHorizontalGroup(orientation)
          ? 'inset-y-0 left-1/2 w-2 -translate-x-1/2'
          : 'inset-x-0 top-1/2 h-2 -translate-y-1/2',
      )}
    />
  );
}

export function PanelResizeSeparator({
  orientation,
  className,
  ...props
}: ComponentPropsWithoutRef<typeof PanelSeparator> & { orientation: ResizeSeparatorOrientation }) {
  return (
    <PanelSeparator className={cn(resizeSeparatorRootClasses(orientation), className)} {...props}>
      <ResizeSeparatorHitTarget orientation={orientation} />
    </PanelSeparator>
  );
}

export function ResizeSeparatorOverlay({
  orientation,
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<'div'> & { orientation: ResizeSeparatorOrientation }) {
  return (
    <div className={cn(resizeSeparatorRootClasses(orientation), className)} {...props}>
      <ResizeSeparatorHitTarget orientation={orientation} />
      {children}
    </div>
  );
}
