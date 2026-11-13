import { Badge } from '@/components/ui/badge';
import { visualForEditorType } from '@/workspace/collection-visuals';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  navigateToWorkbenchTarget,
  type WorkbenchNavigationRequest,
} from '@/workbench/workbench-navigation';
import { localizedDiagnosticMessage } from './diagnostic-i18n';

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
}

interface DiagnosticListProps {
  items: EditorDiagnosticItem[];
  emptyMessage?: string;
  showPath?: boolean;
  compact?: boolean;
  onFix?: (item: EditorDiagnosticItem, index: number) => void;
  fixLabel?: string;
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
  onFix,
  fixLabel,
}: {
  item: EditorDiagnosticItem;
  showPath?: boolean;
  compact?: boolean;
  onFix?: () => void;
  fixLabel?: string;
}) {
  const { t } = useTranslation('workspace');
  const message = localizedDiagnosticMessage(item, t);
  const sourceLocation = item.sourcePath
    ? [item.sourcePath, item.line, item.column].filter((part) => part !== undefined).join(':')
    : null;
  if (compact) {
    const targetTab = item.target?.tab;
    const targetVisual = targetTab
      ? visualForEditorType(targetTab.editorType, targetTab.resource?.collection)
      : null;
    const TargetIcon = targetVisual?.icon;
    const targetLabel = targetTab?.title ?? item.category;
    const content = (
      <div className="col-span-full grid min-w-0 grid-cols-subgrid items-center gap-x-1.5">
        {targetLabel ? (
          <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
            {TargetIcon ? (
              <TargetIcon
                className={`size-3.5 shrink-0 ${targetVisual?.colorClassName ?? ''}`}
                aria-hidden="true"
              />
            ) : null}
            <span className="truncate">{targetLabel}</span>
          </span>
        ) : null}
        <span className="min-w-0 truncate">
          {message}
          {sourceLocation ? (
            <span className="ml-1 font-mono text-[10px] text-muted-foreground">
              {sourceLocation}
            </span>
          ) : null}
        </span>
        {showPath && item.path ? (
          <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
            {item.path}
          </span>
        ) : null}
      </div>
    );
    const className = `col-span-full grid w-full ${onFix ? (showPath ? 'grid-cols-[minmax(0,9rem)_minmax(0,1fr)_minmax(0,14rem)]' : 'grid-cols-[minmax(0,9rem)_minmax(0,1fr)]') : 'grid-cols-subgrid'} border-l-2 px-1.5 py-0.5 text-left text-xs leading-5 ${compactSeverityBorder(
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
    return onFix ? (
      <div className="col-span-full flex min-w-0 items-center gap-1">
        <div className="min-w-0 flex-1">{diagnostic}</div>
        <Button className="h-7 shrink-0" size="sm" variant="outline" onClick={onFix}>
          {fixLabel}
        </Button>
      </div>
    ) : (
      diagnostic
    );
  }

  const content = (
    <>
      <div className="mb-1 flex min-w-0 items-center gap-2">
        <Badge variant={severityVariant(item.severity)}>{item.severity}</Badge>
        {item.category ? <Badge variant="outline">{item.category}</Badge> : null}
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

export function DiagnosticList({
  items,
  emptyMessage,
  showPath = true,
  compact = false,
  onFix,
  fixLabel,
}: DiagnosticListProps) {
  if (items.length === 0) {
    return emptyMessage ? <p className="text-muted-foreground">{emptyMessage}</p> : null;
  }
  return (
    <div
      className={
        compact
          ? showPath
            ? 'grid grid-cols-[fit-content(10rem)_minmax(0,1fr)_fit-content(18rem)] divide-y'
            : 'grid grid-cols-[fit-content(10rem)_minmax(0,1fr)] divide-y'
          : 'space-y-1'
      }
    >
      {items.map((item, index) => (
        <DiagnosticCard
          key={`${item.path ?? ''}:${item.message}:${index}`}
          item={item}
          showPath={showPath}
          compact={compact}
          onFix={onFix && item.severity !== 'info' ? () => onFix(item, index) : undefined}
          fixLabel={fixLabel}
        />
      ))}
    </div>
  );
}
