import { useMemo } from 'react';
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
    <div className="relative text-xs">
      <div className="pointer-events-none sticky top-1 z-10 h-0">
        <Button
          size="sm"
          variant="ghost"
          className="pointer-events-auto absolute right-1 top-0 h-6 bg-background/90 px-2 text-[11px] backdrop-blur-sm"
          onClick={clearPreviewDiagnostics}
        >
          Clear
        </Button>
      </div>
      <div className="px-3 pb-3 pr-16 pt-1">
        <DiagnosticList items={diagnosticItems} compact showPath={false} />
      </div>
    </div>
  );
}
