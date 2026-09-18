import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DiagnosticList } from '@/diagnostics/DiagnosticList';
import { useShaderCompileStore } from './shader-compile-store';

export function ShaderCompilePanel() {
  const compiling = useShaderCompileStore((state) => state.compiling);
  const diagnostics = useShaderCompileStore((state) => state.diagnostics);
  const outputs = useShaderCompileStore((state) => state.outputs);
  const error = useShaderCompileStore((state) => state.error);
  const clear = useShaderCompileStore((state) => state.clear);
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
        target: null,
      })),
    [diagnostics],
  );

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
          {outputs.length} derived output{outputs.length === 1 ? '' : 's'}, {diagnostics.length}{' '}
          diagnostic{diagnostics.length === 1 ? '' : 's'}
        </span>
        <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={clear}>
          Clear
        </Button>
      </div>
      {diagnostics.length > 0 ? (
        <section className="space-y-2">
          <div className="font-medium">Diagnostics</div>
          <DiagnosticList items={diagnosticItems} />
        </section>
      ) : null}
      {outputs.length > 0 ? (
        <section className="space-y-2">
          <div className="font-medium">Derived outputs</div>
          {outputs.map((output, index) => (
            <div
              key={`${output.program}-${output.stage}-${output.variant}-${index}`}
              className="rounded border p-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={output.cacheHit ? 'outline' : 'secondary'}>
                  {output.cacheHit ? 'cache hit' : 'compiled'}
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
