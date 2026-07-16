import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DiagnosticList, type EditorDiagnosticItem } from '@/diagnostics/DiagnosticList';
import { resolveProjectDiagnosticTarget } from '@/diagnostics/diagnostic-navigation';
import { useProjectStore } from '@/project/project-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { isAuthoringProject, type AuthoringProject } from '../../shared/project-schema/authoring-project';

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

function normalizedSeverity(value: unknown): EditorDiagnosticItem['severity'] {
  return value === 'error' || value === 'warning' || value === 'info' ? value : 'warning';
}

function playbackDiagnosticItems(diagnostics: unknown[], project: AuthoringProject | null): EditorDiagnosticItem[] {
  return diagnostics.map((diagnostic) => {
    const item = isRecord(diagnostic) ? diagnostic : {};
    const path = getString(item.path) || undefined;
    return {
      severity: normalizedSeverity(item.severity),
      message: getString(item.message, JSON.stringify(diagnostic)),
      path: path ? `${path}${item.step_index !== undefined ? ` step ${String(item.step_index)}` : ''}` : item.step_index !== undefined ? `step ${String(item.step_index)}` : undefined,
      category: getString(item.category, 'diagnostic'),
      target: project && path ? resolveProjectDiagnosticTarget(project, path) : null,
    };
  });
}

export function TestPlaybackPanel() {
  const [showRaw, setShowRaw] = useState(false);
  const report = useWorkspaceStore((state) => state.lastPlaybackReport);
  const projectDocument = useProjectStore((state) => state.document);
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  if (!report || !isRecord(report)) {
    return <p className="p-3 text-xs text-muted-foreground">No playback report yet.</p>;
  }

  const passed = getBoolean(report.passed);
  const failures = getArray(report.failures);
  const observations = getArray(report.observations);
  const diagnostics = getArray(report.diagnostics);
  const diagnosticItems = playbackDiagnosticItems(diagnostics, project);
  const events = getArray(report.events);
  const trace = getArray(report.trace);
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
              <DiagnosticList items={playbackDiagnosticItems(getArray(item.diagnostics), project)} />
            </div>
          );
        })}
      </section>

      {diagnostics.length > 0 ? <section className="space-y-2 rounded border p-3"><h3 className="text-sm font-medium">Report diagnostics</h3><DiagnosticList items={diagnosticItems} /></section> : null}

      {trace.length > 0 ? (
        <section className="space-y-2 rounded border p-3">
          <h3 className="text-sm font-medium">Trace</h3>
          <div className="grid gap-1 md:grid-cols-2 xl:grid-cols-3">
            {trace.slice(0, 60).map((event, index) => {
              const item = isRecord(event) ? event : {};
              return (
                <div key={index} className="rounded border p-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{String(item.step_index ?? index)}</Badge>
                    <span className="font-medium">{getString(item.type, 'trace')}</span>
                  </div>
                  <div className="mt-1 text-muted-foreground">{getString(item.message, '')}</div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {events.length > 0 ? (
        <section className="space-y-2 rounded border p-3">
          <h3 className="text-sm font-medium">Events</h3>
          <div className="grid gap-1 md:grid-cols-2 xl:grid-cols-3">
            {events.slice(0, 60).map((event, index) => {
              const item = isRecord(event) ? event : {};
              return <div key={index} className="rounded border p-2 font-mono text-[10px]">{String(item.type ?? 'event')}{item.step_index !== undefined ? ` @${String(item.step_index)}` : ''}</div>;
            })}
          </div>
        </section>
      ) : null}

      {showRaw ? <JsonBlock value={report} /> : null}
    </div>
  );
}
