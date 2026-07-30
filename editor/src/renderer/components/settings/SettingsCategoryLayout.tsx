import type { ComponentType, ReactNode, Ref, SVGProps } from 'react';
import { cn } from '@/lib/utils';

type SettingsCategoryIcon = ComponentType<SVGProps<SVGSVGElement>>;

export interface SettingsCategory {
  id: string;
  label: string;
  description?: string;
  icon: SettingsCategoryIcon;
}

interface SettingsCategoryLayoutProps {
  categories: readonly SettingsCategory[];
  activeCategory: string;
  onCategoryChange: (category: string) => void;
  navigationLabel: string;
  header: ReactNode;
  children: ReactNode;
  sidebarFooter?: ReactNode;
  contentRef?: Ref<HTMLDivElement>;
  className?: string;
  showActiveDescription?: boolean;
}

export function SettingsCategoryLayout({
  categories,
  activeCategory,
  onCategoryChange,
  navigationLabel,
  header,
  children,
  sidebarFooter,
  contentRef,
  className,
  showActiveDescription = true,
}: SettingsCategoryLayoutProps) {
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
                <span className="whitespace-nowrap">{category.label}</span>
              </button>
            );
          })}
        </nav>
        {sidebarFooter ? (
          <div className="mt-2 shrink-0 border-t pt-2 sm:mt-auto">{sidebarFooter}</div>
        ) : null}
      </aside>

      <main ref={contentRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl p-3 sm:p-4">
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
