import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useProjectStore } from '@/project/project-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { buildTestDetailTabForRecord } from '@/workbench/editor-registry';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import { getAuthoringTestRunReadiness } from '../../../shared/project-schema/test-playback-project';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';

export function TestSuiteEditor(_props: WorkbenchEditorProps) {
  const projectDocument = useProjectStore((state) => state.document);
  const openTab = useWorkbenchStore((state) => state.openTab);
  const setLastPlaybackReport = useWorkspaceStore((state) => state.setLastPlaybackReport);
  const setStatusMessage = useWorkspaceStore((state) => state.setStatusMessage);
  const addTimelineEntry = useWorkspaceStore((state) => state.addTimelineEntry);
  const setBottomPanel = useBottomPanelStore((state) => state.setActivePanelId);
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const tests = useMemo(() => {
    if (!project) return [];
    return Object.entries(project.tests)
      .map(([id, record]) => ({ id, record, readiness: getAuthoringTestRunReadiness(project, id), label: record.label || id }))
      .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  }, [project]);

  if (!project) return <div className="p-4 text-sm text-muted-foreground">Open an authoring project to manage tests.</div>;

  async function runTest(testId: string) {
    const result = await window.noveltea.runPlaybackTest(project, testId);
    setLastPlaybackReport(result.report ?? result);
    setStatusMessage(result.ok ? `Ran test ${testId}` : result.error ?? 'Test run failed');
    addTimelineEntry({ source: 'playback', message: result.ok ? `Ran test ${testId}` : result.error ?? 'Test run failed', detail: result });
    setBottomPanel('test-playback');
  }

  async function runAll() {
    for (const test of tests) {
      if (!test.readiness.runnable) continue;
      await runTest(test.id);
    }
  }

  const readyCount = tests.filter((test) => test.readiness.runnable).length;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-background p-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">Tests</h2>
          <p className="text-xs text-muted-foreground">Global test suite. Open a test detail tab for step editing or run the ready tests from here.</p>
        </div>
        <Button size="sm" onClick={() => void runAll()} disabled={readyCount === 0}>Run All Ready</Button>
      </div>
      <div className="mt-4 space-y-2">
        {tests.map((test) => (
          <div key={test.id} className="flex items-center gap-3 rounded border p-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{test.label}</span>
                <Badge variant={test.readiness.runnable ? 'default' : 'secondary'}>{test.readiness.runnable ? 'ready' : 'blocked'}</Badge>
              </div>
              <div className="mt-1 font-mono text-[10px] text-muted-foreground">{test.id}</div>
              {!test.readiness.runnable ? <div className="mt-1 text-xs text-muted-foreground">{test.readiness.reason}</div> : null}
            </div>
            <Button size="sm" variant="outline" onClick={() => openTab(buildTestDetailTabForRecord(test.id, test.label))}>Open</Button>
            <Button size="sm" onClick={() => void runTest(test.id)} disabled={!test.readiness.runnable}>Run</Button>
          </div>
        ))}
      </div>
      {tests.length === 0 ? <div className="mt-8 rounded border p-4 text-sm text-muted-foreground">No tests exist yet.</div> : null}
    </div>
  );
}
