import * as React from 'react';
import { Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface SearchInputProps extends Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange' | 'type'> {
  value: string;
  onValueChange: (value: string) => void;
  clearAriaLabel?: string;
  inputClassName?: string;
  endActions?: React.ReactNode;
}

function SearchInput({
  value,
  onValueChange,
  clearAriaLabel = 'Clear search',
  className,
  inputClassName,
  endActions,
  ...props
}: SearchInputProps) {
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="text"
        value={value}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        className={cn('pl-7', value || endActions ? 'pr-8' : undefined, inputClassName)}
        {...props}
      />
      {value || endActions ? (
        <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center">
          {value ? (
            <button
              type="button"
              className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              aria-label={clearAriaLabel}
              title="Clear search"
              onClick={() => onValueChange('')}
            >
              <X className="size-3.5" />
            </button>
          ) : null}
          {endActions}
        </div>
      ) : null}
    </div>
  );
}

export { SearchInput };
