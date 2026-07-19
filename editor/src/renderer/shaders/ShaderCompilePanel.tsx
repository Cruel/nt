import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useCommandStore } from '@/commands/command-store';
import { SAVE_UNIT_IDS } from '@/project/save-unit-registry';
import { DiagnosticList } from '@/diagnostics/DiagnosticList';
import { resolveProjectDiagnosticTarget } from '@/diagnostics/diagnostic-navigation';
import { useProjectStore } from '@/project/project-store';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import { useShaderCompileStore } from './shader-compile-store';

export function ShaderCompilePanel() {
  const compiling = useShaderCompileStore((state) => state.compiling);
  const diagnostics = useShaderCompileStore((state) => state.diagnostics);
  const outputs = useShaderCompileStore((state) => state.outputs);
  const error = useShaderCompileStore((state) => state.error);
  const clear = useShaderCompileStore((state) => state.clear);
  const executeCommand = useCommandStore((state) => state.executeCommand);
  const projectDocument = useProjectStore((state) => state.document);
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const diagnosticItems = useMemo(
    () =>
      diagnostics.map((diagnostic) => ({
        severity: diagnostic.severity,
        message: diagnostic.message,
        path:
          [diagnostic.shader, diagnostic.stage, diagnostic.variant].filter(Boolean).join(' / ') ||
          undefined,
        category: diagnostic.code,
        target:
          project && diagnostic.shader
            ? resolveProjectDiagnosticTarget(project, `/shaders/${diagnostic.shader}/data`)
            : null,
      })),
    [diagnostics, project],
  );

  function applyOutputs() {
    executeCommand({
      type: 'shader.applyCompiledOutputs',
      label: 'Apply shader compile outputs',
      payload: { outputs },
      originSaveUnitId: SAVE_UNIT_IDS.shaderCompiledOutputWorkflow,
      persistencePolicy: 'manual-save',
    });
  }

  if (!compiling && diagnostics.length === 0 && outputs.length === 0 && !error) {
    return <p className="p-3 text-xs text-muted-foreground">No shader compile result yet.</p>;
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
          {compiling ? 'compiling' : error ? 'error' : 'ready'}
        </Badge>
        <span className="text-muted-foreground">
          {outputs.length} output{outputs.length === 1 ? '' : 's'}, {diagnostics.length} diagnostic
          {diagnostics.length === 1 ? '' : 's'}
        </span>
        <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={clear}>
          Clear
        </Button>
        {outputs.length > 0 ? (
          <Button size="sm" className="h-7" onClick={applyOutputs}>
            Apply Outputs
          </Button>
        ) : null}
      </div>
      {diagnostics.length > 0 ? (
        <section className="space-y-2">
          <div className="font-medium">Diagnostics</div>
          <DiagnosticList items={diagnosticItems} />
        </section>
      ) : null}
      {outputs.length > 0 ? (
        <section className="space-y-2">
          <div className="font-medium">Outputs</div>
          {outputs.map((output, index) => (
            <div
              key={`${output.shader}-${output.stage}-${output.variant}-${index}`}
              className="rounded border p-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={output.cacheHit ? 'outline' : 'secondary'}>
                  {output.cacheHit ? 'cache hit' : 'compiled'}
                </Badge>
                <span className="font-mono">{output.shader}</span>
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
