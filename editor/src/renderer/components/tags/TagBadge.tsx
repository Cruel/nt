import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { TagColor } from '../../../shared/project-schema/authoring-tags';
import { tagColorClasses } from './tag-styles';

interface TagBadgeProps {
  name: string;
  color: TagColor;
  removable?: boolean;
  onRemove?: () => void;
  className?: string;
}

export function TagBadge({ name, color, removable = false, onRemove, className }: TagBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn('gap-1 border px-2 py-0.5', tagColorClasses[color], className)}
    >
      <span className="max-w-36 truncate">{name}</span>
      {removable ? (
        <button
          type="button"
          className="-mr-1 rounded p-0.5 opacity-80 transition-colors hover:bg-foreground/5 hover:opacity-100 dark:hover:bg-background/20"
          aria-label={`Remove ${name} tag`}
          onClick={onRemove}
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </Badge>
  );
}
