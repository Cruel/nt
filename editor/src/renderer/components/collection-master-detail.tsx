import {
  useEffect,
  useRef,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Trash2 } from 'lucide-react';
import { EditorSectionHeading } from '@/components/editor-section-heading';
import { cn } from '@/lib/utils';

interface MasterDetailLayoutProps {
  master: ReactNode;
  detail: ReactNode;
  className?: string;
}

function MasterDetailLayout({ master, detail, className }: MasterDetailLayoutProps) {
  return (
    <div className={cn('grid items-start gap-2 @5xl:grid-cols-[13rem_minmax(0,1fr)]', className)}>
      <div className="min-w-0">{master}</div>
      <div data-master-detail-detail className="min-w-0">
        {detail}
      </div>
    </div>
  );
}

function CollectionListAction({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<'button'>) {
  return (
    <button
      type="button"
      className={cn(
        'flex min-h-8 w-full items-center gap-2 px-2.5 py-2 text-left text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

function CollectionItemDeleteAction({
  className,
  ...props
}: Omit<ComponentPropsWithoutRef<'button'>, 'children'>) {
  return (
    <button
      type="button"
      className={cn(
        'flex size-7 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-destructive focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30',
        className,
      )}
      {...props}
    >
      <Trash2 className="size-3.5" aria-hidden="true" />
    </button>
  );
}

interface CollectionItemPresentation {
  label: ReactNode;
  secondary?: ReactNode;
  trailing?: ReactNode;
}

interface SelectableItemListProps<T> {
  items: readonly T[];
  getKey: (item: T, index: number) => string;
  selectedKey: string | null;
  onSelectedKeyChange: (key: string, item: T, index: number) => void;
  getPresentation: (item: T, index: number) => CollectionItemPresentation;
  renderItemActions?: (item: T, context: { index: number; selected: boolean }) => ReactNode;
  footer?: ReactNode;
  ariaLabel?: string;
  getItemAnchor?: (item: T, index: number) => string | undefined;
}

function SelectableItemList<T>({
  items,
  getKey,
  selectedKey,
  onSelectedKeyChange,
  getPresentation,
  renderItemActions,
  footer,
  ariaLabel,
  getItemAnchor,
}: SelectableItemListProps<T>) {
  const selectRelativeItem = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowDown') nextIndex = Math.min(items.length - 1, index + 1);
    else if (event.key === 'ArrowUp') nextIndex = Math.max(0, index - 1);
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = items.length - 1;
    if (nextIndex === null || nextIndex === index) return;
    event.preventDefault();
    const nextItem = items[nextIndex];
    if (!nextItem) return;
    const key = getKey(nextItem, nextIndex);
    onSelectedKeyChange(key, nextItem, nextIndex);
    const list = event.currentTarget.closest('[data-selectable-item-list]');
    const nextButton =
      list?.querySelectorAll<HTMLButtonElement>('[data-collection-key]')[nextIndex];
    nextButton?.focus();
  };

  return (
    <div
      data-selectable-item-list
      role={ariaLabel ? 'group' : undefined}
      aria-label={ariaLabel}
      className="overflow-hidden rounded-md border bg-muted/10"
    >
      {footer ? <div className={cn(items.length > 0 && 'border-b')}>{footer}</div> : null}
      {items.map((item, index) => {
        const key = getKey(item, index);
        const selected = key === selectedKey;
        const presentation = getPresentation(item, index);
        const hasDivider = index < items.length - 1;
        return (
          <div
            key={key}
            className={cn(
              'group/item flex items-stretch transition-colors',
              hasDivider && 'border-b',
              selected
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            <button
              type="button"
              aria-current={selected ? 'true' : undefined}
              data-collection-key={key}
              data-workbench-anchor={getItemAnchor?.(item, index)}
              className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30"
              onClick={() => onSelectedKeyChange(key, item, index)}
              onKeyDown={(event) => selectRelativeItem(event, index)}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-foreground">
                  {presentation.label}
                </span>
                {presentation.secondary ? (
                  <span className="block truncate text-[10px] opacity-70">
                    {presentation.secondary}
                  </span>
                ) : null}
              </span>
              {presentation.trailing ? (
                <span className="shrink-0 truncate text-[10px] opacity-70">
                  {presentation.trailing}
                </span>
              ) : null}
            </button>
            {renderItemActions ? (
              <div className="flex shrink-0 items-center pr-1 opacity-0 transition-opacity group-hover/item:opacity-100 group-focus-within/item:opacity-100">
                {renderItemActions(item, { index, selected })}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

interface CollectionListActionConfig {
  label: ReactNode;
  onClick: () => void;
  icon?: ReactNode;
  disabled?: boolean;
  pressed?: boolean;
  ariaLabel?: string;
}

interface CollectionMasterDetailProps<T> {
  title?: ReactNode;
  description?: ReactNode;
  items: readonly T[];
  getKey: (item: T, index: number) => string;
  selectedKey: string | null;
  onSelectedKeyChange: (key: string, item: T, index: number) => void;
  getItemPresentation: (item: T, index: number) => CollectionItemPresentation;
  onDeleteItem?: (item: T, index: number) => void;
  getDeleteLabel?: (item: T, index: number) => string;
  listAction?: CollectionListActionConfig;
  renderDetail: (item: T, index: number) => ReactNode;
  emptyState: ReactNode;
  detailEmptyState?: ReactNode;
  listAriaLabel?: string;
  className?: string;
  layoutClassName?: string;
  anchor?: string;
  getItemAnchor?: (item: T, index: number) => string | undefined;
}

export function CollectionMasterDetail<T>({
  title,
  description,
  items,
  getKey,
  selectedKey,
  onSelectedKeyChange,
  getItemPresentation,
  onDeleteItem,
  getDeleteLabel,
  listAction,
  renderDetail,
  emptyState,
  detailEmptyState,
  listAriaLabel,
  className,
  layoutClassName,
  anchor,
  getItemAnchor,
}: CollectionMasterDetailProps<T>) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const previousItemCountRef = useRef(items.length);
  const selectedIndex =
    selectedKey === null
      ? -1
      : items.findIndex((item, index) => getKey(item, index) === selectedKey);
  const selectedItem = selectedIndex >= 0 ? items[selectedIndex] : undefined;

  useEffect(() => {
    const previousItemCount = previousItemCountRef.current;
    previousItemCountRef.current = items.length;
    if (items.length <= previousItemCount || selectedIndex < 0) return;

    let innerFrame = 0;
    const outerFrame = window.requestAnimationFrame(() => {
      innerFrame = window.requestAnimationFrame(() => {
        const detail = sectionRef.current?.querySelector<HTMLElement>(
          '[data-master-detail-detail]',
        );
        if (!detail) return;

        let scrollContainer = detail.parentElement;
        while (scrollContainer) {
          const { overflowY } = window.getComputedStyle(scrollContainer);
          if (
            /(auto|scroll)/.test(overflowY) &&
            scrollContainer.scrollHeight > scrollContainer.clientHeight
          ) {
            break;
          }
          scrollContainer = scrollContainer.parentElement;
        }

        if (!scrollContainer) {
          detail.scrollIntoView({ block: 'nearest' });
          return;
        }

        const detailRect = detail.getBoundingClientRect();
        const containerRect = scrollContainer.getBoundingClientRect();
        if (detailRect.height <= containerRect.height) {
          if (detailRect.bottom > containerRect.bottom)
            scrollContainer.scrollTop += detailRect.bottom - containerRect.bottom;
          else if (detailRect.top < containerRect.top)
            scrollContainer.scrollTop -= containerRect.top - detailRect.top;
        } else if (detailRect.top !== containerRect.top) {
          scrollContainer.scrollTop += detailRect.top - containerRect.top;
        }
      });
    });

    return () => {
      window.cancelAnimationFrame(outerFrame);
      if (innerFrame) window.cancelAnimationFrame(innerFrame);
    };
  }, [items.length, selectedIndex, selectedKey]);

  const header = title ? (
    <EditorSectionHeading title={title} help={description} helpLabel="About this collection" />
  ) : null;
  const footer = listAction ? (
    <CollectionListAction
      aria-label={listAction.ariaLabel}
      aria-pressed={listAction.pressed}
      disabled={listAction.disabled}
      onClick={listAction.onClick}
    >
      {listAction.icon}
      {listAction.label}
    </CollectionListAction>
  ) : null;
  const itemActions = onDeleteItem
    ? (item: T, context: { index: number; selected: boolean }) => (
        <CollectionItemDeleteAction
          aria-label={getDeleteLabel?.(item, context.index) ?? 'Delete item'}
          onClick={() => onDeleteItem(item, context.index)}
        />
      )
    : undefined;
  const list = (
    <SelectableItemList
      items={items}
      getKey={getKey}
      selectedKey={selectedKey}
      onSelectedKeyChange={onSelectedKeyChange}
      getPresentation={getItemPresentation}
      renderItemActions={itemActions}
      footer={footer}
      ariaLabel={listAriaLabel}
      getItemAnchor={getItemAnchor}
    />
  );

  return (
    <section
      ref={sectionRef}
      className={cn('space-y-2.5', className)}
      data-workbench-anchor={anchor}
    >
      {header}
      <MasterDetailLayout
        className={cn(items.length === 0 && 'items-stretch', layoutClassName)}
        master={list}
        detail={
          selectedItem ? (
            renderDetail(selectedItem, selectedIndex)
          ) : (
            <div className="flex h-full min-h-8 items-center justify-center rounded-md border border-dashed px-4 py-2 text-center text-xs text-muted-foreground">
              {detailEmptyState ?? emptyState}
            </div>
          )
        }
      />
    </section>
  );
}
