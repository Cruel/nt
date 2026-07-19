import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface PageHeaderProps extends HTMLAttributes<HTMLDivElement> {
  title: string;
  description?: string;
  actions?: ReactNode;
}

export function PageHeader({ title, description, actions, className, ...props }: PageHeaderProps) {
  return (
    <div
      className={cn('flex items-center justify-between border-b px-6 py-3', className)}
      {...props}
    >
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
        {description && <p className="truncate text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
