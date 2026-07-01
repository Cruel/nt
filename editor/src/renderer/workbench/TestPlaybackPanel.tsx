import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useWorkspaceStore } from '@/stores/workspace-store';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function getString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function getBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function getNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="overflow-auto rounded border bg-muted/20 p-3 font-mono text-[11px] leading-relaxed">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function DiagnosticList({ diagnostics }: { diagnostics: unknown[] }) {
  if (diagnostics.length === 0) return null;
  return (
    <div className="space-y-1">
      {diagnostics.map((diagnostic, index) => {
        const item = isRecord(diagnostic) ? diagnostic : {};
        const severity = getString(item.severity, 'warning');
        return (
          <div key={index} className="rounded border p-2 text-xs">
            <div className="flex items-center gap-2">
              <Badge variant={severity === 'error' ? 'destructive' : 'outline'}>{severity}</Badge>
              <span>{getString(item.category, 'diagnostic')}</span>
            </div>
            <div className="mt-1">{getString(item.message, JSON.stringify(diagnostic))}</div>
            {item.path || item.step_index !== undefined ? <div className="mt-1 font-mono text-[10px] text-muted-foreground">{getString(item.path)}{item.step_index !== undefined ? ` step ${String(item.step_index)}` : ''}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

export function TestPlaybackPanel() {
  const [showRaw, setShowRaw] = useState(false);
  const report = useWorkspaceStore((state) => state.lastPlaybackReport);
  if (!report || !isRecord(report)) {
    return <p className="p-3 text-xs text-muted-foreground">No playback report yet.</p>;
  }

  const passed = getBoolean(report.passed);
  const failures = getArray(report.failures);
  const observations = getArray(report.observations);
  const diagnostics = getArray(report.diagnostics);
  const outputs = getArray(report.outputs);
  const finalState = isRecord(report.final_state) ? report.final_state : isRecord(report.finalState) ? report.finalState : null;

  return (
    <div className="space-y-3 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={passed === false ? 'destructive' : 'default'}>{passed === false ? 'failed' : 'passed'}</Badge>
        <span className="font-medium">{getString(report.id, 'Playback report')}</span>
        <span className="text-muted-foreground">{observations.length} observation{observations.length === 1 ? '' : 's'}</span>
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => setShowRaw(!showRaw)}>{showRaw ? 'Hide Raw' : 'Show Raw'}</Button>
      </div>

      {failures.length > 0 ? (
        <section className="space-y-2 rounded border p-3">
          <h3 className="text-sm font-medium">Failures</h3>
          {failures.map((failure, index) => <div key={index} className="rounded bg-destructive/10 p-2 text-destructive">{String(failure)}</div>)}
        </section>
      ) : null}

      {finalState ? (
        <section className="rounded border p-3">
          <h3 className="mb-2 text-sm font-medium">Final state</h3>
          <div className="grid gap-2 md:grid-cols-5">
            <div><span className="text-muted-foreground">Loaded</span><div>{String(finalState.loaded ?? false)}</div></div>
            <div><span className="text-muted-foreground">Running</span><div>{String(finalState.running ?? false)}</div></div>
            <div><span className="text-muted-foreground">Mode</span><div>{String(finalState.mode ?? 'none')}</div></div>
            <div><span className="text-muted-foreground">Title</span><div>{String(finalState.title ?? '')}</div></div>
            <div><span className="text-muted-foreground">Room</span><div>{String(finalState.current_room ?? '')}</div></div>
          </div>
        </section>
      ) : null}

      <section className="space-y-2 rounded border p-3">
        <h3 className="text-sm font-medium">Observations</h3>
        {observations.length === 0 ? <div className="text-muted-foreground">No observations.</div> : null}
        {observations.map((observation, index) => {
          const item = isRecord(observation) ? observation : {};
          const stepIndex = getNumber(item.step_index) ?? index;
          const itemPassed = getBoolean(item.passed);
          const assertionFailures = getArray(item.assertion_failures);
          return (
            <div key={index} className="rounded border p-2">
              <div className="flex items-center gap-2">
                <Badge variant="outline">{stepIndex}</Badge>
                <span className="font-medium">{getString(item.input, 'input')}</span>
                <Badge variant={itemPassed === false ? 'destructive' : 'secondary'}>{itemPassed === false ? 'failed' : 'passed'}</Badge>
                <span className="text-muted-foreground">handled {String(item.handled ?? false)}</span>
              </div>
              {assertionFailures.length > 0 ? <div className="mt-2 space-y-1">{assertionFailures.map((failure, failureIndex) => <div key={failureIndex} className="rounded bg-destructive/10 p-1 text-destructive">{String(failure)}</div>)}</div> : null}
              <DiagnosticList diagnostics={getArray(item.diagnostics)} />
            </div>
          );
        })}
      </section>

      {diagnostics.length > 0 ? <section className="space-y-2 rounded border p-3"><h3 className="text-sm font-medium">Report diagnostics</h3><DiagnosticList diagnostics={diagnostics} /></section> : null}

      {outputs.length > 0 ? (
        <section className="space-y-2 rounded border p-3">
          <h3 className="text-sm font-medium">Outputs</h3>
          <div className="grid gap-1 md:grid-cols-2 xl:grid-cols-3">
            {outputs.slice(0, 60).map((output, index) => {
              const item = isRecord(output) ? output : {};
              return <div key={index} className="rounded border p-2 font-mono text-[10px]">{String(item.type ?? 'output')}{item.step_index !== undefined ? ` @${String(item.step_index)}` : ''}</div>;
            })}
          </div>
        </section>
      ) : null}

      {showRaw ? <JsonBlock value={report} /> : null}
    </div>
  );
}
