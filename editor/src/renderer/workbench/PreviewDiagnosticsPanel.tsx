import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DiagnosticList } from '@/diagnostics/DiagnosticList';
import { resolveProjectDiagnosticTarget } from '@/diagnostics/diagnostic-navigation';
import { useProjectStore } from '@/project/project-store';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import { previewTargetLabel } from '@/preview/preview-manager';
import { usePreviewManagerStore } from '@/preview/preview-manager-store';

export function PreviewDiagnosticsPanel() {
  const diagnosticOrder = usePreviewManagerStore((state) => state.diagnosticOrder);
  const diagnosticsById = usePreviewManagerStore((state) => state.diagnosticsById);
  const clearPreviewDiagnostics = usePreviewManagerStore((state) => state.clearPreviewDiagnostics);
  const projectDocument = useProjectStore((state) => state.document);
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const diagnostics = useMemo(
    () => diagnosticOrder.map((id) => diagnosticsById[id]).filter(Boolean),
    [diagnosticOrder, diagnosticsById],
  );
  const diagnosticItems = useMemo(
    () =>
      diagnostics.map((diagnostic) => ({
        severity: diagnostic.severity,
        message: `${diagnostic.message} (${previewTargetLabel(diagnostic.target)})`,
        path: diagnostic.path,
        category: diagnostic.source,
        target:
          project && diagnostic.path
            ? resolveProjectDiagnosticTarget(project, diagnostic.path)
            : null,
      })),
    [diagnostics, project],
  );

  if (diagnostics.length === 0) {
    return <p className="p-3 text-xs text-muted-foreground">No preview diagnostics.</p>;
  }

  return (
    <div className="space-y-2 p-3 text-xs">
      <div className="flex items-center gap-2">
        <Badge variant="outline">Preview diagnostics</Badge>
        <span className="text-muted-foreground">
          {diagnostics.length} issue{diagnostics.length === 1 ? '' : 's'}
        </span>
        <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={clearPreviewDiagnostics}>
          Clear
        </Button>
      </div>
      <DiagnosticList items={diagnosticItems} />
    </div>
  );
}
