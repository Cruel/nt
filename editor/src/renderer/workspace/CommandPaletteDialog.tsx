import { useMemo, useState } from 'react';
import { Dialog, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import type { AssetNode } from '@/stores/workspace-store';
import {
  buildAssetsEditorTab,
  buildDefaultRecordTab,
  buildProjectSettingsTab,
  buildTestsEditorTab,
  buildVariablesEditorTab,
} from '@/workbench/editor-registry';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { buildCommandPaletteItems, searchCommandPaletteItems, type CommandPaletteItem, type CommandPaletteMatch } from './command-palette-search';

function nodeForRecord(item: CommandPaletteItem): AssetNode | null {
  if (!item.collection || !item.entityId) return null;
  return {
    id: `${item.collection}:${item.entityId}`,
    label: item.title,
    type:
      item.collection === 'variables' ? 'variable'
        : item.collection === 'assets' ? 'asset'
          : item.collection === 'shaders' ? 'shader'
            : item.collection === 'materials' ? 'material'
              : item.collection === 'layouts' ? 'layout'
                : item.collection === 'characters' ? 'character'
                  : 'folder',
    collection: item.collection,
    entityId: item.entityId,
  };
}

function tabForItem(item: CommandPaletteItem): WorkbenchTab | null {
  if (item.kind === 'record') {
    const node = nodeForRecord(item);
    return node ? buildDefaultRecordTab(node) : null;
  }
  if (item.action === 'project-settings') return buildProjectSettingsTab();
  if (item.action === 'assets') return buildAssetsEditorTab();
  if (item.action === 'variables') return buildVariablesEditorTab();
  if (item.action === 'tests') return buildTestsEditorTab();
  return null;
}

function clampedSnippet(match: CommandPaletteMatch, radius = 28) {
  const first = match.indices[0];
  if (!first) return { text: match.value, offset: 0, prefix: '', suffix: '' };
  const start = Math.max(0, first[0] - radius);
  const end = Math.min(match.value.length, first[1] + 1 + radius);
  return {
    text: match.value.slice(start, end),
    offset: start,
    prefix: start > 0 ? '…' : '',
    suffix: end < match.value.length ? '…' : '',
  };
}

function HighlightedText({ value, indices, className = '' }: { value: string; indices: readonly (readonly [number, number])[]; className?: string }) {
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
      {parts.map((part, index) => part.highlight
        ? <mark key={index} className="bg-primary/20 text-primary">{part.text}</mark>
        : <span key={index}>{part.text}</span>)}
    </span>
  );
}

function HighlightedMatch({ match }: { match: CommandPaletteMatch | undefined }) {
  if (!match) return null;
  const snippet = clampedSnippet(match);
  const ranges = match.indices.map(([start, end]) => [start - snippet.offset, end - snippet.offset] as const);
  return (
    <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
      <span className="shrink-0 text-muted-foreground/80">{match.fieldLabel}</span>
      <span className="min-w-0 truncate font-mono">
        {snippet.prefix}<HighlightedText value={snippet.text} indices={ranges} />{snippet.suffix}
      </span>
    </span>
  );
}

export function CommandPaletteDialog({
  open,
  project,
  onOpenChange,
  onOpenTab,
}: {
  open: boolean;
  project: AuthoringProject | null;
  onOpenChange: (open: boolean) => void;
  onOpenTab: (tab: WorkbenchTab) => void;
}) {
  const [query, setQuery] = useState('');
  const items = useMemo(() => buildCommandPaletteItems(project), [project]);
  const results = useMemo(() => searchCommandPaletteItems(items, query), [items, query]);

  function choose(item: CommandPaletteItem) {
    const tab = tabForItem(item);
    if (!tab) return;
    onOpenTab(tab);
    onOpenChange(false);
    setQuery('');
  }

  function setOpen(nextOpen: boolean) {
    onOpenChange(nextOpen);
    if (!nextOpen) setQuery('');
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup className="top-[5vh] max-w-2xl translate-y-0 gap-0 p-0 data-[state=open]:slide-in-from-top-2 sm:top-[5vh] sm:translate-y-0">
        <div className="border-b px-3 pb-1.5 pt-2.5">
          <DialogTitle>Command Palette</DialogTitle>
          <Input
            autoFocus
            className="mt-1.5 h-8"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && results[0]) {
                event.preventDefault();
                choose(results[0].item);
              }
            }}
            placeholder="Type a command or record name"
          />
        </div>
        <div className="max-h-[55vh] overflow-y-auto px-1 py-0.5">
          {results.map((result) => {
            const Icon = result.item.icon;
            const titleMatch = result.matches.find((match) => match.fieldKind === 'title');
            const sideMatch = result.matches.find((match) => match.fieldKind !== 'title');
            return (
              <button
                key={result.item.id}
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-accent"
                onClick={() => choose(result.item)}
              >
                {Icon ? <Icon className={`h-4 w-4 shrink-0 ${result.item.iconClassName ?? 'text-muted-foreground'}`} /> : null}
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {titleMatch ? <HighlightedText value={result.item.title} indices={titleMatch.indices} /> : result.item.title}
                </span>
                <span className="ml-3 min-w-0 max-w-[45%] shrink text-right">
                  <HighlightedMatch match={sideMatch} />
                </span>
              </button>
            );
          })}
          {results.length === 0 ? <div className="p-3 text-xs text-muted-foreground">No commands or records match.</div> : null}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
