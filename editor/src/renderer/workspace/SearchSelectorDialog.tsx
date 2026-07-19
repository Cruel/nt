import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, Eye, EyeOff } from 'lucide-react';
import { Dialog, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useTranslation } from 'react-i18next';
import { AssetImageThumbnail } from './AssetImageThumbnail';
import {
  searchSelectorItems,
  type SelectorItem,
  type SelectorMatch,
} from './command-palette-search';

function clampedSnippet(match: SelectorMatch, radius = 28) {
  const first = match.indices[0];
  if (!first) return { text: match.value, offset: 0, prefix: '', suffix: '' };
  const start = Math.max(0, first[0] - radius);
  const end = Math.min(match.value.length, first[1] + 1 + radius);
  return {
    text: match.value.slice(start, end),
    offset: start,
    prefix: start > 0 ? '...' : '',
    suffix: end < match.value.length ? '...' : '',
  };
}

function HighlightedText({
  value,
  indices,
  className = '',
}: {
  value: string;
  indices: readonly (readonly [number, number])[];
  className?: string;
}) {
  const ranges = indices
    .map(([start, end]) => [Math.max(start, 0), Math.min(end + 1, value.length)] as const)
    .filter(([start, end]) => end > start)
    .sort((left, right) => left[0] - right[0]);
  const parts: Array<{ text: string; highlight: boolean }> = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push({ text: value.slice(cursor, start), highlight: false });
    parts.push({ text: value.slice(start, end), highlight: true });
    cursor = end;
  }
  if (cursor < value.length) parts.push({ text: value.slice(cursor), highlight: false });
  return (
    <span className={className}>
      {parts.map((part, index) =>
        part.highlight ? (
          <mark key={index} className="bg-primary/20 text-primary">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </span>
  );
}

function HighlightedMatch({ match }: { match: SelectorMatch | undefined }) {
  if (!match) return null;
  const snippet = clampedSnippet(match);
  const ranges = match.indices.map(
    ([start, end]) => [start - snippet.offset, end - snippet.offset] as const,
  );
  return (
    <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
      <span className="shrink-0 text-muted-foreground/80">{match.fieldLabel}</span>
      <span className="min-w-0 truncate font-mono">
        {snippet.prefix}
        <HighlightedText value={snippet.text} indices={ranges} />
        {snippet.suffix}
      </span>
    </span>
  );
}

function DefaultPreview({ item, className }: { item: SelectorItem; className?: string }) {
  if (item.preview?.kind === 'image') {
    return (
      <AssetImageThumbnail
        label={item.preview.label}
        sourcePath={item.preview.sourcePath}
        className={className}
      />
    );
  }
  return null;
}

interface SearchSelectorDialogProps {
  open: boolean;
  title: string;
  placeholder: string;
  emptyMessage: string;
  items: readonly SelectorItem[];
  selectedId?: string | null;
  onSelect: (item: SelectorItem) => void;
  onOpenChange: (open: boolean) => void;
  limit?: number;
  leadingMediaSize?: {
    width: string;
    height: string;
  };
  renderPreview?: (item: SelectorItem) => ReactNode;
}

export function SearchSelectorDialog({
  open,
  title,
  placeholder,
  emptyMessage,
  items,
  selectedId = null,
  onSelect,
  onOpenChange,
  limit = 24,
  leadingMediaSize,
  renderPreview,
}: SearchSelectorDialogProps) {
  const { t } = useTranslation('workspace');
  const [query, setQuery] = useState('');
  const [viewAll, setViewAll] = useState(false);
  const leadingMediaWidth = leadingMediaSize?.width ?? '3rem';
  const leadingMediaHeight = leadingMediaSize?.height ?? '2.25rem';
  const searchLimit = viewAll ? items.length : limit;
  const searchResults = useMemo(
    () => searchSelectorItems(items, query, searchLimit),
    [items, query, searchLimit],
  );
  const results = useMemo(() => {
    if (!selectedId) return searchResults;
    const nextResults = [...searchResults];
    const selectedIndex = nextResults.findIndex((result) => result.item.id === selectedId);
    if (selectedIndex >= 0) {
      if (selectedIndex === 0) return nextResults;
      const [selectedResult] = nextResults.splice(selectedIndex, 1);
      return [selectedResult, ...nextResults];
    }
    const selectedItem = items.find((item) => item.id === selectedId);
    if (!selectedItem) return nextResults;
    return [{ item: selectedItem, score: 0, matches: [] }, ...nextResults];
  }, [searchResults, selectedId, items]);
  const hasEmptySearchResults = searchResults.length === 0;

  function choose(item: SelectorItem) {
    onSelect(item);
    onOpenChange(false);
    setQuery('');
  }

  function setOpen(nextOpen: boolean) {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setQuery('');
      setViewAll(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup className="top-[5vh] flex max-h-[calc(95vh-1rem)] flex-col overflow-visible translate-y-0 gap-0 p-0 data-[state=open]:slide-in-from-top-2 sm:top-[5vh] sm:translate-y-0 !w-[calc(100vw-1.5rem)] sm:!w-[min(84vw,38rem)] md:!w-[min(70vw,44rem)] lg:!w-[min(58vw,48rem)] xl:!w-[min(50vw,52rem)] !max-w-none">
        <div className="border-b px-3 pb-1.5 pt-2.5">
          <DialogTitle>{title}</DialogTitle>
          <div className="relative mt-1.5">
            <Input
              autoFocus
              className="h-8 w-full pr-10"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && results[0]) {
                  event.preventDefault();
                  choose(results[0].item);
                }
              }}
              placeholder={placeholder}
            />
            <button
              type="button"
              aria-label={
                viewAll ? t('selectors.viewAll.showLimited') : t('selectors.viewAll.showAll')
              }
              title={viewAll ? t('selectors.viewAll.showLimited') : t('selectors.viewAll.showAll')}
              aria-pressed={viewAll}
              className={`absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground ${viewAll ? 'bg-accent text-accent-foreground' : ''}`}
              onClick={() => setViewAll((current) => !current)}
            >
              {viewAll ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <div className={`min-h-0 flex-1 px-1 py-0.5 ${viewAll ? 'overflow-y-auto' : ''}`}>
          {results.map((result) => {
            const Icon = result.item.icon;
            const titleMatch = result.matches.find((match) => match.fieldKind === 'title');
            const sideMatch = result.matches.find((match) => match.fieldKind !== 'title');
            const selected = selectedId === result.item.id;
            const gridTemplateColumns = `${leadingMediaWidth} minmax(22rem,3fr) minmax(0,1fr)`;
            const preview = renderPreview ? (
              renderPreview(result.item)
            ) : result.item.preview?.kind === 'image' ? (
              <DefaultPreview
                item={result.item}
                className={leadingMediaSize ? 'h-full w-full' : undefined}
              />
            ) : null;
            return (
              <button
                key={result.item.id}
                type="button"
                className={`grid w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-0 text-left hover:bg-accent ${selected ? 'bg-accent/70 text-foreground' : ''}`}
                style={{ gridTemplateColumns }}
                aria-selected={selected}
                onClick={() => choose(result.item)}
              >
                <span
                  className="relative flex items-center justify-center overflow-visible"
                  style={{ width: leadingMediaWidth, height: leadingMediaHeight }}
                >
                  {preview ??
                    (Icon ? (
                      <Icon
                        className={`h-4 w-4 shrink-0 ${result.item.iconClassName ?? 'text-muted-foreground'}`}
                      />
                    ) : null)}
                  {selected ? (
                    <Check
                      className="absolute left-0 top-1/2 h-3.5 w-3.5 -translate-x-1/3 -translate-y-1/2 shrink-0 rounded-full bg-emerald-500 text-black"
                      aria-hidden="true"
                    />
                  ) : null}
                </span>
                <span className="min-w-0 truncate text-sm font-medium">
                  {titleMatch ? (
                    <HighlightedText value={result.item.title} indices={titleMatch.indices} />
                  ) : (
                    result.item.title
                  )}
                </span>
                <span className="min-w-0 truncate overflow-hidden justify-self-end text-right">
                  <HighlightedMatch match={sideMatch} />
                </span>
              </button>
            );
          })}
          {hasEmptySearchResults ? (
            <div className="p-3 text-xs text-muted-foreground">{emptyMessage}</div>
          ) : null}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
