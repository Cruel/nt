import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DiagnosticList } from '@/diagnostics/DiagnosticList';
import { useShaderCompileStore } from './shader-compile-store';
import { useProjectStore } from '@/project/project-store';
import {
  isAuthoringProject,
  type AuthoringProject,
} from '../../shared/project-schema/authoring-project';
import { resolveMaterialData } from '../../shared/project-schema/authoring-materials';
import { buildDefaultRecordTab } from '@/workbench/editor-registry';
import type { ShaderCompileDiagnostic } from '../../shared/editor-tooling';
import type { WorkbenchNavigationRequest } from '@/workbench/workbench-navigation';

function shaderDiagnosticTarget(
  project: AuthoringProject,
  diagnostic: ShaderCompileDiagnostic,
): WorkbenchNavigationRequest | null {
  const materialPath = diagnostic.path?.match(/^\/materials\/([^/]+)/u)?.[1];
  const normalizedSource = diagnostic.sourcePath?.replaceAll('\\', '/');
  const materialId =
    materialPath ??
    Object.keys(project.materials).find((id) => {
      if (!normalizedSource) return false;
      const resolved = resolveMaterialData(project, id).data;
      if (!resolved) return false;
      return [resolved.vertexSource, resolved.fragmentSource, resolved.varyingDefinition].some(
        (identity) => {
          if (!identity.startsWith('project:/')) return false;
          const relative = identity.slice('project:/'.length);
          return normalizedSource === relative || normalizedSource.endsWith(`/${relative}`);
        },
      );
    });
  if (!materialId) return null;
  const record = project.materials[materialId];
  const tab = buildDefaultRecordTab({
    id: `materials:${materialId}`,
    label: record?.label ?? materialId,
    type: 'material',
    collection: 'materials',
    entityId: materialId,
  });
  return tab ? { tab, target: { id: 'material.shader', flash: true } } : null;
}

export function ShaderCompilePanel() {
  const { t } = useTranslation('workspace');
  const compiling = useShaderCompileStore((state) => state.compiling);
  const diagnostics = useShaderCompileStore((state) => state.diagnostics);
  const outputs = useShaderCompileStore((state) => state.outputs);
  const error = useShaderCompileStore((state) => state.error);
  const clear = useShaderCompileStore((state) => state.clear);
  const projectDocument = useProjectStore((state) => state.document);
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const diagnosticItems = useMemo(
    () =>
      diagnostics.map((diagnostic) => ({
        severity: diagnostic.severity,
        message: diagnostic.message,
        path:
          [diagnostic.stage, diagnostic.variant, diagnostic.sourcePath]
            .filter(Boolean)
            .join(' / ') || undefined,
        category: diagnostic.code,
        target: project ? shaderDiagnosticTarget(project, diagnostic) : null,
      })),
    [diagnostics, project],
  );

  if (!compiling && diagnostics.length === 0 && outputs.length === 0 && !error) {
    return <p className="p-3 text-xs text-muted-foreground">{t('shaderCompilePanel.empty')}</p>;
  }

  return (
    <div className="space-y-3 p-3 text-xs">
      <div className="flex items-center gap-2">
        <Badge
          variant={
            error || diagnostics.some((item) => item.severity === 'error')
              ? 'destructive'
              : 'secondary'
          }
        >
          {compiling
            ? t('shaderCompilePanel.status.compiling')
            : error
              ? t('shaderCompilePanel.status.error')
              : t('shaderCompilePanel.status.ready')}
        </Badge>
        <span className="text-muted-foreground">
          {t('shaderCompilePanel.summary', {
            outputCount: outputs.length,
            diagnosticCount: diagnostics.length,
          })}
        </span>
        <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={clear}>
          {t('shaderCompilePanel.clear')}
        </Button>
      </div>
      {diagnostics.length > 0 ? (
        <section className="space-y-2">
          <div className="font-medium">{t('shaderCompilePanel.diagnostics')}</div>
          <DiagnosticList items={diagnosticItems} />
        </section>
      ) : null}
      {outputs.length > 0 ? (
        <section className="space-y-2">
          <div className="font-medium">{t('shaderCompilePanel.outputs')}</div>
          {outputs.map((output, index) => (
            <div
              key={`${output.program}-${output.stage}-${output.variant}-${index}`}
              className="rounded border p-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={output.cacheHit ? 'outline' : 'secondary'}>
                  {output.cacheHit
                    ? t('shaderCompilePanel.outputStatus.cacheHit')
                    : t('shaderCompilePanel.outputStatus.compiled')}
                </Badge>
                <span className="font-mono">{output.program}</span>
                <span className="font-mono text-muted-foreground">{output.stage}</span>
                <span className="font-mono text-muted-foreground">{output.variant}</span>
              </div>
              <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                {output.runtimePath}
              </div>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}
