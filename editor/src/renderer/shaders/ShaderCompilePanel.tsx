import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useCommandStore } from '@/commands/command-store';
import { useShaderCompileStore } from './shader-compile-store';

export function ShaderCompilePanel() {
  const compiling = useShaderCompileStore((state) => state.compiling);
  const diagnostics = useShaderCompileStore((state) => state.diagnostics);
  const outputs = useShaderCompileStore((state) => state.outputs);
  const error = useShaderCompileStore((state) => state.error);
  const clear = useShaderCompileStore((state) => state.clear);
  const executeCommand = useCommandStore((state) => state.executeCommand);

  function applyOutputs() {
    executeCommand({
      type: 'shader.applyCompiledOutputs',
      label: 'Apply shader compile outputs',
      payload: { outputs },
    });
  }

  if (!compiling && diagnostics.length === 0 && outputs.length === 0 && !error) {
    return <p className="p-3 text-xs text-muted-foreground">No shader compile result yet.</p>;
  }

  return (
    <div className="space-y-3 p-3 text-xs">
      <div className="flex items-center gap-2">
        <Badge variant={error || diagnostics.some((item) => item.severity === 'error') ? 'destructive' : 'secondary'}>
          {compiling ? 'compiling' : error ? 'error' : 'ready'}
        </Badge>
        <span className="text-muted-foreground">{outputs.length} output{outputs.length === 1 ? '' : 's'}, {diagnostics.length} diagnostic{diagnostics.length === 1 ? '' : 's'}</span>
        <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={clear}>Clear</Button>
        {outputs.length > 0 ? <Button size="sm" className="h-7" onClick={applyOutputs}>Apply Outputs</Button> : null}
      </div>
      {diagnostics.length > 0 ? (
        <section className="space-y-2">
          <div className="font-medium">Diagnostics</div>
          {diagnostics.map((diagnostic, index) => (
            <div key={`${diagnostic.message}-${index}`} className="rounded border p-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={diagnostic.severity === 'error' ? 'destructive' : 'secondary'}>{diagnostic.severity}</Badge>
                {diagnostic.code ? <span className="font-mono text-muted-foreground">{diagnostic.code}</span> : null}
                {diagnostic.shader ? <span className="font-mono text-muted-foreground">{diagnostic.shader}</span> : null}
                {diagnostic.stage ? <span className="font-mono text-muted-foreground">{diagnostic.stage}</span> : null}
                {diagnostic.variant ? <span className="font-mono text-muted-foreground">{diagnostic.variant}</span> : null}
              </div>
              <div className="mt-1">{diagnostic.message}</div>
              {diagnostic.commandLine ? <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{diagnostic.commandLine}</div> : null}
            </div>
          ))}
        </section>
      ) : null}
      {outputs.length > 0 ? (
        <section className="space-y-2">
          <div className="font-medium">Outputs</div>
          {outputs.map((output, index) => (
            <div key={`${output.shader}-${output.stage}-${output.variant}-${index}`} className="rounded border p-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={output.cacheHit ? 'outline' : 'secondary'}>{output.cacheHit ? 'cache hit' : 'compiled'}</Badge>
                <span className="font-mono">{output.shader}</span>
                <span className="font-mono text-muted-foreground">{output.stage}</span>
                <span className="font-mono text-muted-foreground">{output.variant}</span>
              </div>
              <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{output.runtimePath}</div>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}
