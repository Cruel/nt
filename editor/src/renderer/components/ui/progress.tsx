import * as React from 'react';

import { cn } from '@/lib/utils';

function Progress({
  className,
  value = 0,
  max = 100,
  ...props
}: React.ComponentProps<'div'> & { value?: number | null; max?: number }) {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 100;
  const safeValue = Number.isFinite(value ?? 0) ? Math.min(Math.max(value ?? 0, 0), safeMax) : 0;
  const percent = (safeValue / safeMax) * 100;

  return (
    <div
      data-slot="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={safeValue}
      className={cn('relative h-2 w-full overflow-hidden rounded-full bg-muted', className)}
      {...props}
    >
      <div
        data-slot="progress-indicator"
        className="h-full w-full flex-1 bg-foreground transition-transform"
        style={{ transform: `translateX(-${100 - percent}%)` }}
      />
    </div>
  );
}

export { Progress };
