import type { ComponentType, ReactNode, Ref, SVGProps } from 'react';
import { cn } from '@/lib/utils';

type CategorizedEditorIcon = ComponentType<SVGProps<SVGSVGElement>>;

export interface CategorizedEditorCategory<Id extends string = string> {
  id: Id;
  label: string;
  description?: string;
  icon: CategorizedEditorIcon;
  trailing?: ReactNode;
}

interface CategorizedEditorLayoutProps<Id extends string> {
  categories: readonly CategorizedEditorCategory<Id>[];
  activeCategory: Id;
  onCategoryChange: (category: Id) => void;
  navigationLabel: string;
  header: ReactNode;
  children: ReactNode;
  sidebarFooter?: ReactNode;
  contentRef?: Ref<HTMLDivElement>;
  className?: string;
  contentContainerClassName?: string;
  showActiveDescription?: boolean;
}

export function CategorizedEditorLayout<Id extends string>({
  categories,
  activeCategory,
  onCategoryChange,
  navigationLabel,
  header,
  children,
  sidebarFooter,
  contentRef,
  className,
  contentContainerClassName,
  showActiveDescription = true,
}: CategorizedEditorLayoutProps<Id>) {
  const active = categories.find((category) => category.id === activeCategory) ?? categories[0];

  return (
    <div
      className={cn(
        'flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background sm:flex-row',
        className,
      )}
    >
      <aside className="flex shrink-0 flex-col border-b bg-muted/10 p-2 sm:w-48 sm:border-r sm:border-b-0">
        <nav
          aria-label={navigationLabel}
          className="flex gap-1 overflow-x-auto sm:min-h-0 sm:flex-1 sm:flex-col sm:overflow-x-visible sm:overflow-y-auto"
        >
          {categories.map((category) => {
            const Icon = category.icon;
            const selected = category.id === active?.id;
            return (
              <button
                key={category.id}
                type="button"
                aria-current={selected ? 'page' : undefined}
                className={cn(
                  'flex h-8 shrink-0 items-center gap-2 rounded-md px-2.5 text-left text-xs font-medium outline-none transition-colors',
                  'focus-visible:ring-2 focus-visible:ring-ring/40',
                  selected
                    ? 'bg-accent text-accent-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
                )}
                onClick={() => onCategoryChange(category.id)}
              >
                <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate whitespace-nowrap">{category.label}</span>
                {category.trailing ? (
                  <span
                    aria-hidden="true"
                    className="shrink-0 text-[10px] tabular-nums text-muted-foreground"
                  >
                    {category.trailing}
                  </span>
                ) : null}
              </button>
            );
          })}
        </nav>
        {sidebarFooter ? (
          <div className="mt-2 shrink-0 border-t pt-2 sm:mt-auto">{sidebarFooter}</div>
        ) : null}
      </aside>

      <main ref={contentRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className={cn('mx-auto w-full max-w-5xl p-3 sm:p-4', contentContainerClassName)}>
          {header}
          {showActiveDescription && active?.description ? (
            <p className="mt-1 text-xs text-muted-foreground">{active.description}</p>
          ) : null}
          <div className="mt-3 space-y-2 [&_[data-slot=card]]:[--card-spacing:--spacing(3)]">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
