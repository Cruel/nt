import { ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  navigateToWorkbenchTarget,
  type WorkbenchNavigationRequest,
} from '@/workbench/workbench-navigation';

export interface EditorDiagnosticItem {
  severity: 'error' | 'warning' | 'info';
  message: string;
  path?: string;
  category?: string;
  target?: WorkbenchNavigationRequest | null;
}

function severityVariant(severity: EditorDiagnosticItem['severity']) {
  return severity === 'error' ? 'destructive' : severity === 'warning' ? 'secondary' : 'outline';
}

export function DiagnosticCard({ item }: { item: EditorDiagnosticItem }) {
  const content = (
    <>
      <div className="mb-1 flex min-w-0 items-center gap-2">
        <Badge variant={severityVariant(item.severity)}>{item.severity}</Badge>
        {item.category ? <Badge variant="outline">{item.category}</Badge> : null}
        {item.path ? (
          <span className="truncate font-mono text-[10px] text-muted-foreground">{item.path}</span>
        ) : null}
      </div>
      <div>{item.message}</div>
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
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0 flex-1">{content}</div>
        <ExternalLink className="mt-0.5 size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      </div>
    </button>
  );
}

export function DiagnosticList({
  items,
  emptyMessage,
}: {
  items: EditorDiagnosticItem[];
  emptyMessage?: string;
}) {
  if (items.length === 0) {
    return emptyMessage ? <p className="text-muted-foreground">{emptyMessage}</p> : null;
  }
  return (
    <div className="space-y-1">
      {items.map((item, index) => (
        <DiagnosticCard key={`${item.path ?? ''}:${item.message}:${index}`} item={item} />
      ))}
    </div>
  );
}
