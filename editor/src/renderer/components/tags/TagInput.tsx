import { useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  normalizeTagKey,
  normalizeTagName,
  normalizeTags,
  tagColorForIndex,
  type ProjectTagSummary,
  type TagColor,
} from '../../../shared/project-schema/authoring-tags';
import { TagBadge } from './TagBadge';

interface TagInputProps {
  id?: string;
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions: ProjectTagSummary[];
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
  allowCreate?: boolean;
}

function sortSuggestions(query: string, suggestions: ProjectTagSummary[]) {
  const key = normalizeTagKey(query);
  const filtered = suggestions.filter((tag) => {
    if (!key) return true;
    return tag.key.startsWith(key) || tag.key.includes(key);
  });
  return filtered.sort((left, right) => {
    const leftPrefix = left.key.startsWith(key) ? 0 : 1;
    const rightPrefix = right.key.startsWith(key) ? 0 : 1;
    return (
      leftPrefix - rightPrefix || right.count - left.count || left.name.localeCompare(right.name)
    );
  });
}

export function TagInput({
  id,
  value,
  onChange,
  suggestions,
  placeholder = 'Add tag',
  disabled = false,
  autoFocus = false,
  className,
  allowCreate = true,
}: TagInputProps) {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const normalizedValue = useMemo(() => normalizeTags(value), [value]);
  const selectedKeys = useMemo(
    () => new Set(normalizedValue.map(normalizeTagKey)),
    [normalizedValue],
  );
  const availableSuggestions = useMemo(
    () => suggestions.filter((tag) => !selectedKeys.has(tag.key)),
    [selectedKeys, suggestions],
  );
  const visibleSuggestions = useMemo(
    () =>
      sortSuggestions(showAll ? '' : draft, availableSuggestions).slice(
        0,
        showAll ? availableSuggestions.length : 8,
      ),
    [availableSuggestions, draft, showAll],
  );
  const exactSuggestion = visibleSuggestions.find((tag) => tag.key === normalizeTagKey(draft));

  function colorForTag(tag: string): TagColor {
    const key = normalizeTagKey(tag);
    const existing = suggestions.find((summary) => summary.key === key);
    if (existing) return existing.color;
    const unsavedBefore = normalizedValue.filter(
      (item) =>
        !suggestions.some((summary) => summary.key === normalizeTagKey(item)) &&
        normalizeTagKey(item) !== key,
    );
    return tagColorForIndex(suggestions.length + unsavedBefore.length);
  }

  function commitTags(tags: string[], nextDraft = '') {
    const next = normalizeTags([...normalizedValue, ...tags]);
    onChange(next);
    setDraft(nextDraft);
    setOpen(false);
    setShowAll(false);
  }

  function commitDraft() {
    const tag = normalizeTagName(draft);
    if (!tag) return;
    commitTags([tag]);
  }

  function removeTag(tag: string) {
    const key = normalizeTagKey(tag);
    onChange(normalizedValue.filter((item) => normalizeTagKey(item) !== key));
  }

  function handleChange(nextValue: string) {
    setShowAll(false);
    if (nextValue.includes(',')) {
      const parts = nextValue.split(',');
      const committed = parts.slice(0, -1);
      const tail = parts.at(-1) ?? '';
      commitTags(committed, tail);
      setOpen(Boolean(tail.trim()));
      return;
    }
    setDraft(nextValue);
    setOpen(Boolean(nextValue.trim()));
  }

  function toggleAllSuggestions() {
    inputRef.current?.focus();
    setShowAll((current) => {
      const next = !current;
      setOpen(next || Boolean(draft.trim()));
      return next;
    });
  }

  return (
    <div className={cn('relative', className)}>
      <div
        className={cn(
          'relative flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border border-input bg-input/20 py-1 pl-2 pr-8 text-sm outline-none focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 dark:bg-input/30',
          disabled && 'pointer-events-none opacity-50',
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {normalizedValue.map((tag) => (
          <TagBadge
            key={normalizeTagKey(tag)}
            name={tag}
            color={colorForTag(tag)}
            removable
            onRemove={() => removeTag(tag)}
          />
        ))}
        <input
          id={id}
          ref={inputRef}
          className={cn(
            'flex-1 bg-transparent px-1 py-0.5 text-xs outline-none placeholder:text-muted-foreground',
            normalizedValue.length > 0 ? 'min-w-4' : 'min-w-24',
          )}
          value={draft}
          placeholder={normalizedValue.length === 0 ? placeholder : ''}
          disabled={disabled}
          autoFocus={autoFocus}
          onFocus={() => setOpen(Boolean(draft.trim()))}
          onBlur={() =>
            window.setTimeout(() => {
              setOpen(false);
              setShowAll(false);
            }, 120)
          }
          onChange={(event) => handleChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === ',') {
              event.preventDefault();
              commitDraft();
            } else if (event.key === 'Enter') {
              event.preventDefault();
              commitDraft();
            } else if (
              event.key === 'Backspace' &&
              draft.length === 0 &&
              normalizedValue.length > 0
            ) {
              event.preventDefault();
              const previous = normalizedValue.at(-1)!;
              onChange(normalizedValue.slice(0, -1));
              setDraft(previous);
              setOpen(true);
            } else if (event.key === 'Escape') {
              setOpen(false);
              setShowAll(false);
            }
          }}
        />
        <button
          type="button"
          className="absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          aria-label={showAll ? 'Hide tag suggestions' : 'Show all tag suggestions'}
          aria-expanded={open && showAll}
          disabled={disabled || availableSuggestions.length === 0}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation();
            toggleAllSuggestions();
          }}
        >
          <ChevronDown className={cn('size-3.5 transition-transform', showAll && 'rotate-180')} />
        </button>
      </div>
      {open && (showAll || draft.trim()) ? (
        <div className="absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          {visibleSuggestions.map((tag) => (
            <button
              type="button"
              key={tag.key}
              className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commitTags([tag.name])}
            >
              <TagBadge name={tag.name} color={tag.color} />
              <span className="text-[10px] text-muted-foreground">{tag.count}</span>
            </button>
          ))}
          {visibleSuggestions.length === 0 && showAll ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">No available tags</div>
          ) : null}
          {!showAll && !exactSuggestion && allowCreate ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
              onMouseDown={(event) => event.preventDefault()}
              onClick={commitDraft}
            >
              Create “{normalizeTagName(draft)}”
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
