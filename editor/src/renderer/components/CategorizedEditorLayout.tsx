import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type Ref,
  type SVGProps,
} from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { usePreferencesStore } from '@/stores/preferences-store';
import { useOptionalWorkbenchEditorLocation } from '@/workbench/workbench-editor-location';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

type CategorizedEditorIcon = ComponentType<SVGProps<SVGSVGElement>>;

const CATEGORIZED_SIDEBAR_COLLAPSED_WIDTH = 40;
const CATEGORIZED_SIDEBAR_INITIAL_EXPANDED_WIDTH = 160;
const CATEGORIZED_SIDEBAR_MIN_EXPANDED_WIDTH = 140;
const CATEGORIZED_SIDEBAR_MAX_EXPANDED_WIDTH = 280;
const CATEGORIZED_SIDEBAR_MEASUREMENT_ALLOWANCE = 6;
const CATEGORIZED_SIDEBAR_EXPAND_MIN_REM = 36;

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
  sidebarFooterTooltip?: ReactNode;
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
  sidebarFooterTooltip,
  contentRef,
  className,
  contentContainerClassName,
  showActiveDescription = true,
}: CategorizedEditorLayoutProps<Id>) {
  const { t } = useTranslation('workspace');
  const active = categories.find((category) => category.id === activeCategory) ?? categories[0];
  const sidebarCollapsed = usePreferencesStore((state) => state.categorizedEditorSidebarCollapsed);
  const setSidebarCollapsed = usePreferencesStore(
    (state) => state.setCategorizedEditorSidebarCollapsed,
  );
  const editorLocation = useOptionalWorkbenchEditorLocation();
  const isVisible = editorLocation?.isVisible ?? true;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [forcedCollapsed, setForcedCollapsed] = useState(false);
  const [expandedWidth, setExpandedWidth] = useState(CATEGORIZED_SIDEBAR_INITIAL_EXPANDED_WIDTH);
  const [animateWidth, setAnimateWidth] = useState(false);
  const previousSidebarCollapsedRef = useRef(sidebarCollapsed);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined' || !isVisible) return;
    const rootFontSize =
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const collapseThreshold = CATEGORIZED_SIDEBAR_EXPAND_MIN_REM * rootFontSize;
    const update = (animate: boolean) => {
      if (container.clientWidth <= 0) return;
      const nextForcedCollapsed = container.clientWidth < collapseThreshold;
      setForcedCollapsed((current) => {
        if (nextForcedCollapsed === current) return current;
        if (animate) setAnimateWidth(true);
        return nextForcedCollapsed;
      });
    };
    update(false);
    const observer = new ResizeObserver(() => update(true));
    observer.observe(container);
    return () => observer.disconnect();
  }, [isVisible]);

  useLayoutEffect(() => {
    const measure = measureRef.current;
    if (!measure) return;
    const update = () => {
      const rows = measure.querySelectorAll<HTMLElement>('[data-sidebar-measure-row]');
      const contentWidth = Array.from(rows).reduce(
        (widest, row) => Math.max(widest, row.scrollWidth, row.getBoundingClientRect().width),
        0,
      );
      const measured = Math.ceil(contentWidth + CATEGORIZED_SIDEBAR_MEASUREMENT_ALLOWANCE);
      setExpandedWidth(
        Math.min(
          CATEGORIZED_SIDEBAR_MAX_EXPANDED_WIDTH,
          Math.max(CATEGORIZED_SIDEBAR_MIN_EXPANDED_WIDTH, measured),
        ),
      );
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(measure);
    return () => observer.disconnect();
  }, []);

  const collapsed = sidebarCollapsed || forcedCollapsed;

  useLayoutEffect(() => {
    const previousSidebarCollapsed = previousSidebarCollapsedRef.current;
    previousSidebarCollapsedRef.current = sidebarCollapsed;
    if (previousSidebarCollapsed !== sidebarCollapsed && isVisible) setAnimateWidth(true);
  }, [isVisible, sidebarCollapsed]);
  const sidebarActionLabel = forcedCollapsed
    ? t('sidebar.categorized.expandWhenWider')
    : collapsed
      ? t('sidebar.categorized.expand')
      : t('sidebar.categorized.collapse');
  const sidebarTooltip = forcedCollapsed
    ? t('sidebar.categorized.expandWhenWiderTooltip')
    : collapsed
      ? t('sidebar.categorized.expand')
      : t('sidebar.categorized.collapse');

  return (
    <TooltipProvider>
      <div
        ref={containerRef}
        className={cn(
          'flex h-full min-h-0 flex-1 flex-row overflow-hidden bg-background',
          className,
        )}
      >
        <aside
          className={cn(
            'group/sidebar relative flex w-10 shrink-0 flex-col overflow-hidden border-r bg-muted/10',
            animateWidth && 'transition-[width]',
          )}
          data-collapsed={collapsed ? 'true' : 'false'}
          style={{ width: collapsed ? CATEGORIZED_SIDEBAR_COLLAPSED_WIDTH : expandedWidth }}
          onTransitionEnd={(event) => {
            if (event.propertyName === 'width') setAnimateWidth(false);
          }}
        >
          <div
            ref={measureRef}
            aria-hidden="true"
            className="pointer-events-none invisible absolute -z-10 flex w-max flex-col gap-0 text-xs font-medium"
          >
            {categories.map((category) => {
              const Icon = category.icon;
              return (
                <div
                  key={category.id}
                  data-sidebar-measure-row
                  className={cn(
                    'grid h-8 w-max items-center gap-2 px-2.5',
                    category.trailing
                      ? 'grid-cols-[1.125rem_max-content_auto]'
                      : 'grid-cols-[1.125rem_max-content]',
                  )}
                >
                  <Icon className="size-4.5 shrink-0" />
                  <span className="whitespace-nowrap">{category.label}</span>
                  {category.trailing ? (
                    <span className="text-[10px] tabular-nums">{category.trailing}</span>
                  ) : null}
                </div>
              );
            })}
            {sidebarFooter ? (
              sidebarFooterTooltip ? (
                <div data-sidebar-measure-row className="flex h-8 w-max items-center gap-2 px-2.5">
                  <span className="size-4.5 shrink-0" />
                  <span className="whitespace-nowrap">{sidebarFooterTooltip}</span>
                </div>
              ) : (
                <div data-sidebar-measure-row className="w-max">
                  {sidebarFooter}
                </div>
              )
            ) : null}
            <div data-sidebar-measure-row className="flex h-8 w-max items-center gap-2 px-2.5">
              <PanelLeftClose className="size-4 shrink-0" />
              <span className="whitespace-nowrap">{t('sidebar.categorized.collapse')}</span>
            </div>
          </div>
          <nav
            aria-label={navigationLabel}
            className="flex min-h-0 flex-1 flex-col gap-0 overflow-x-hidden overflow-y-auto"
          >
            {categories.map((category) => {
              const Icon = category.icon;
              const selected = category.id === active?.id;
              return (
                <Tooltip key={category.id} disabled={!collapsed}>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={category.label}
                        aria-current={selected ? 'page' : undefined}
                        className={cn(
                          'relative grid h-8 w-full shrink-0 items-center gap-2 overflow-hidden px-2.5 text-left text-xs font-medium outline-none transition-colors',
                          category.trailing
                            ? 'grid-cols-[1.125rem_minmax(0,1fr)_auto]'
                            : 'grid-cols-[1.125rem_minmax(0,1fr)]',
                          'focus-visible:ring-2 focus-visible:ring-ring/40',
                          selected
                            ? 'bg-accent text-accent-foreground'
                            : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
                        )}
                        onClick={() => onCategoryChange(category.id)}
                      />
                    }
                  >
                    <Icon className="size-4.5 shrink-0" aria-hidden="true" />
                    <span
                      className={cn(
                        'min-w-0 truncate whitespace-nowrap text-left transition-opacity duration-150',
                        collapsed ? 'opacity-0' : 'opacity-100',
                      )}
                    >
                      {category.label}
                    </span>
                    {category.trailing ? (
                      <span
                        aria-hidden="true"
                        className={cn(
                          'shrink-0 tabular-nums transition-all duration-150',
                          collapsed
                            ? 'absolute top-0.5 right-0.5 min-w-3 rounded-full bg-accent px-1 text-center text-[9px] leading-3 text-accent-foreground opacity-100'
                            : 'text-[10px] text-muted-foreground opacity-100',
                        )}
                      >
                        {category.trailing}
                      </span>
                    ) : null}
                  </TooltipTrigger>
                  <TooltipContent side="right">{category.label}</TooltipContent>
                </Tooltip>
              );
            })}
          </nav>

          <div className="mt-auto shrink-0 overflow-hidden">
            {sidebarFooter ? (
              <div className="overflow-hidden border-t">
                {sidebarFooterTooltip ? (
                  <Tooltip disabled={!collapsed}>
                    <TooltipTrigger render={<div className="w-full" />}>
                      {sidebarFooter}
                    </TooltipTrigger>
                    <TooltipContent side="right">{sidebarFooterTooltip}</TooltipContent>
                  </Tooltip>
                ) : (
                  sidebarFooter
                )}
              </div>
            ) : null}
            <div className="border-t">
              <Tooltip disabled={!collapsed}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={sidebarActionLabel}
                      aria-disabled={forcedCollapsed ? 'true' : undefined}
                      className={cn(
                        'flex h-8 w-full items-center justify-start gap-2 overflow-hidden px-2.5 text-xs font-medium text-muted-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40',
                        forcedCollapsed
                          ? 'cursor-not-allowed opacity-50'
                          : 'hover:bg-muted/70 hover:text-foreground',
                      )}
                      onClick={() => {
                        if (forcedCollapsed) return;
                        setSidebarCollapsed(!sidebarCollapsed);
                      }}
                    />
                  }
                >
                  {collapsed ? (
                    <PanelLeftOpen className="size-4.5 shrink-0" aria-hidden="true" />
                  ) : (
                    <PanelLeftClose className="size-4.5 shrink-0" aria-hidden="true" />
                  )}
                  <span
                    className={cn(
                      'whitespace-nowrap transition-opacity duration-150',
                      collapsed ? 'opacity-0' : 'opacity-100',
                    )}
                  >
                    {t('sidebar.categorized.collapse')}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right">{sidebarTooltip}</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </aside>

        <main ref={contentRef} className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
          <div className={cn('mx-auto w-full max-w-5xl p-3 @xl:p-4', contentContainerClassName)}>
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
    </TooltipProvider>
  );
}
