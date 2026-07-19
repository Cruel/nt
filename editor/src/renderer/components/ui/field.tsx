import * as React from 'react';

import { cn } from '@/lib/utils';

function Field({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="field" className={cn('grid gap-1.5', className)} {...props} />;
}

function FieldLabel({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label
      data-slot="field-label"
      className={cn('flex items-center gap-2 text-xs/relaxed font-medium', className)}
      {...props}
    />
  );
}

export { Field, FieldLabel };
