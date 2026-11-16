import { Badge } from '@/components/ui/badge';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { visualForEditorType } from '@/workspace/collection-visuals';
import { useTranslation } from 'react-i18next';
import {
  navigateToWorkbenchTarget,
  type WorkbenchNavigationRequest,
} from '@/workbench/workbench-navigation';
import { localizedDiagnosticMessage } from './diagnostic-i18n';
import type { DiagnosticObservedAgainst } from '../../shared/editor-tooling';

export interface EditorDiagnosticItem {
  code?: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  path?: string;
  category?: string;
  sourcePath?: string;
  line?: number;
  column?: number;
  target?: WorkbenchNavigationRequest | null;
  observedAgainst?: DiagnosticObservedAgainst;
  dirtyOwner?: boolean;
  context?: { sessionId?: string; previewTarget?: string; source?: string; timestamp?: number };
}

interface DiagnosticListProps {
  items: EditorDiagnosticItem[];
  emptyMessage?: string;
  showPath?: boolean;
  compact?: boolean;
  onFix?: (item: EditorDiagnosticItem, index: number) => void;
  onExplain?: (item: EditorDiagnosticItem, index: number) => void;
}

function severityVariant(severity: EditorDiagnosticItem['severity']) {
  return severity === 'error' ? 'destructive' : severity === 'warning' ? 'secondary' : 'outline';
}

function compactSeverityBorder(severity: EditorDiagnosticItem['severity']) {
  return severity === 'error'
    ? 'border-l-destructive'
    : severity === 'warning'
      ? 'border-l-amber-500'
      : 'border-l-sky-500';
}

export function DiagnosticCard({
  item,
  showPath = true,
  compact = false,
}: {
  item: EditorDiagnosticItem;
  showPath?: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation('workspace');
  const message = localizedDiagnosticMessage(item, t);
  const sourceLocation = item.sourcePath
    ? [
        item.observedAgainst === 'working-file'
          ? `.noveltea/editor/working/files/${item.sourcePath}`
          : item.sourcePath,
        item.line,
        item.column,
      ]
        .filter((part) => part !== undefined)
        .join(':')
    : null;
  const observation =
    item.observedAgainst === 'working'
      ? t('diagnostics.observedWorking')
      : item.observedAgainst === 'disk'
        ? t('diagnostics.observedDisk')
        : item.observedAgainst === 'working-file'
          ? t('diagnostics.observedWorkingFile')
          : null;
  const originText = [observation, item.dirtyOwner ? t('diagnostics.unsavedOwner') : null]
    .filter(Boolean)
    .join(' · ');
  if (compact) {
    const targetTab = item.target?.tab;
    const targetVisual = targetTab
      ? visualForEditorType(targetTab.editorType, targetTab.resource?.collection)
      : null;
    const TargetIcon = targetVisual?.icon;
    // Native validation always observes the acknowledged working Project, even when
    // it equals disk. Only independently detected unsaved edits merit an inline marker.
    const targetLabel = targetTab?.title ?? item.category;
    const displayLabel =
      targetLabel ??
      (item.observedAgainst === 'working-file' ? t('diagnostics.observedWorkingFile') : null);
    const content = (
      <div className="col-span-full grid min-w-0 grid-cols-subgrid items-center gap-x-2">
        {displayLabel ? (
          <span
            className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs font-medium text-muted-foreground"
            title={displayLabel}
          >
            {TargetIcon ? (
              <TargetIcon
                className={`size-3.5 shrink-0 ${targetVisual?.colorClassName ?? ''}`}
                aria-hidden="true"
              />
            ) : null}
            <span className="min-w-0 flex-1 truncate">{displayLabel}</span>
            {item.dirtyOwner ? (
              <span
                role="img"
                aria-label={t('diagnostics.unsavedOwner')}
                title={t('diagnostics.unsavedOwner')}
                className="size-1.5 shrink-0 rounded-full bg-amber-500"
              />
            ) : null}
          </span>
        ) : null}
        <span className={`${displayLabel ? '' : 'col-span-2'} min-w-0 truncate`} title={message}>
          {message}
          {showPath && sourceLocation ? (
            <span className="ml-1 font-mono text-[10px] text-muted-foreground">
              {sourceLocation}
            </span>
          ) : null}
        </span>
        {showPath ? (
          <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
            {item.path ?? ''}
          </span>
        ) : null}
      </div>
    );
    const className = `col-span-full grid w-full grid-cols-subgrid border-l-2 px-1.5 py-0.5 text-left text-xs leading-5 ${compactSeverityBorder(
      item.severity,
    )}`;

    const diagnostic = !item.target ? (
      <div className={className}>{content}</div>
    ) : (
      <button
        type="button"
        className={`${className} cursor-pointer transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30`}
        onClick={() => item.target && navigateToWorkbenchTarget(item.target)}
      >
        {content}
      </button>
    );
    return diagnostic;
  }

  const content = (
    <>
      <div className="mb-1 flex min-w-0 items-center gap-2">
        <Badge variant={severityVariant(item.severity)}>{item.severity}</Badge>
        {item.category ? <Badge variant="outline">{item.category}</Badge> : null}
        {originText ? (
          <span className="text-[10px] text-muted-foreground">{originText}</span>
        ) : null}
        {showPath && item.path ? (
          <span className="truncate font-mono text-[10px] text-muted-foreground">{item.path}</span>
        ) : null}
      </div>
      <div>{message}</div>
      {sourceLocation ? (
        <div className="font-mono text-[10px] text-muted-foreground">{sourceLocation}</div>
      ) : null}
    </>
  );

  if (!item.target) {
    return <div className="rounded border p-2">{content}</div>;
  }

  return (
    <button
      type="button"
      className="w-full rounded border p-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
      onClick={() => item.target && navigateToWorkbenchTarget(item.target)}
    >
      {content}
    </button>
  );
}

export function diagnosticDetailsText(item: EditorDiagnosticItem, message = item.message): string {
  return [
    `Severity: ${item.severity}`,
    ...(item.code ? [`Code: ${item.code}`] : []),
    ...(item.category ? [`Category: ${item.category}`] : []),
    ...(item.context?.source ? [`Source: ${item.context.source}`] : []),
    ...(item.context?.sessionId ? [`Preview session: ${item.context.sessionId}`] : []),
    ...(item.context?.previewTarget ? [`Preview target: ${item.context.previewTarget}`] : []),
    ...(item.context?.timestamp
      ? [`Observed: ${new Date(item.context.timestamp).toISOString()}`]
      : []),
    ...(item.path ? [`Path: ${item.path}`] : []),
    ...(item.sourcePath
      ? [
          `File: ${item.sourcePath}${item.line ? `:${item.line}${item.column ? `:${item.column}` : ''}` : ''}`,
        ]
      : []),
    ...(item.observedAgainst ? [`Observed against: ${item.observedAgainst}`] : []),
    `Message: ${message}`,
  ].join('\n');
}

export function DiagnosticList({
  items,
  emptyMessage,
  showPath = true,
  compact = false,
  onFix,
  onExplain,
}: DiagnosticListProps) {
  const { t } = useTranslation('workspace');
  if (items.length === 0) {
    return emptyMessage ? <p className="text-muted-foreground">{emptyMessage}</p> : null;
  }
  return (
    <div
      className={
        compact
          ? showPath
            ? 'grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)_minmax(0,13rem)] divide-y'
            : 'grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] divide-y'
          : 'space-y-1'
      }
    >
      {items.map((item, index) => (
        <ContextMenu key={`${item.path ?? ''}:${item.message}:${index}`}>
          <ContextMenuTrigger
            className={compact ? 'col-span-full grid min-w-0 grid-cols-subgrid' : 'block min-w-0'}
          >
            <DiagnosticCard item={item} showPath={showPath} compact={compact} />
          </ContextMenuTrigger>
          <ContextMenuContent className="min-w-48">
            <ContextMenuItem
              onClick={() =>
                void navigator.clipboard.writeText(localizedDiagnosticMessage(item, t))
              }
            >
              {t('diagnostics.copyMessage')}
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() =>
                void navigator.clipboard.writeText(
                  diagnosticDetailsText(item, localizedDiagnosticMessage(item, t)),
                )
              }
            >
              {t('diagnostics.copyDetails')}
            </ContextMenuItem>
            {onExplain || (onFix && item.severity !== 'info') ? <ContextMenuSeparator /> : null}
            {onExplain ? (
              <ContextMenuItem onClick={() => onExplain(item, index)}>
                {t('diagnostics.explainWithAi')}
              </ContextMenuItem>
            ) : null}
            {onFix && item.severity !== 'info' ? (
              <ContextMenuItem onClick={() => onFix(item, index)}>
                {t('diagnostics.fixWithAi')}
              </ContextMenuItem>
            ) : null}
            {item.target ? (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => navigateToWorkbenchTarget(item.target!)}>
                  {t('diagnostics.goToSource')}
                </ContextMenuItem>
              </>
            ) : null}
          </ContextMenuContent>
        </ContextMenu>
      ))}
    </div>
  );
}
