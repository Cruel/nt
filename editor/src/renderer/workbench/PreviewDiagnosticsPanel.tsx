import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { previewTargetLabel } from '@/preview/preview-manager';
import { usePreviewManagerStore } from '@/preview/preview-manager-store';

export function PreviewDiagnosticsPanel() {
  const diagnosticOrder = usePreviewManagerStore((state) => state.diagnosticOrder);
  const diagnosticsById = usePreviewManagerStore((state) => state.diagnosticsById);
  const clearPreviewDiagnostics = usePreviewManagerStore((state) => state.clearPreviewDiagnostics);
  const diagnostics = useMemo(
    () => diagnosticOrder.map((id) => diagnosticsById[id]).filter(Boolean),
    [diagnosticOrder, diagnosticsById],
  );

  if (diagnostics.length === 0) {
    return <p className="p-3 text-xs text-muted-foreground">No preview diagnostics.</p>;
  }

  return (
    <div className="space-y-2 p-3 text-xs">
      <div className="flex items-center gap-2">
        <Badge variant="outline">Preview diagnostics</Badge>
        <span className="text-muted-foreground">{diagnostics.length} issue{diagnostics.length === 1 ? '' : 's'}</span>
        <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={clearPreviewDiagnostics}>
          Clear
        </Button>
      </div>
      {diagnostics.map((diagnostic) => (
        <div key={diagnostic.id} className="rounded border p-2">
          <div className="flex items-center gap-2">
            <Badge variant={diagnostic.severity === 'error' ? 'destructive' : diagnostic.severity === 'warning' ? 'secondary' : 'outline'}>
              {diagnostic.severity}
            </Badge>
            <Badge variant="outline">{diagnostic.source}</Badge>
            <span className="font-mono text-[10px] text-muted-foreground">{diagnostic.sessionId ?? 'global'}</span>
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">
              {new Date(diagnostic.timestamp).toLocaleTimeString()}
            </span>
          </div>
          <div className="mt-1">{diagnostic.message}</div>
          <div className="mt-1 flex gap-2 font-mono text-[10px] text-muted-foreground">
            <span>{previewTargetLabel(diagnostic.target)}</span>
            {diagnostic.path ? <span>{diagnostic.path}</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}
