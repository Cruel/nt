import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useProjectStore } from '@/project/project-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import { usePendingInputStore } from '@/workbench/pending-input-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { buildTestDetailTabForRecord } from '@/workbench/editor-registry';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import {
  getAuthoringTestRunReadiness,
  type TestRunReadiness,
} from '../../../shared/project-schema/test-playback-project';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';

type SuiteStatus = 'passed' | 'failed' | 'blocked' | 'error';

type SuiteEntry = {
  id: string;
  runner: 'runtime' | 'runtime-ui' | null;
  status: SuiteStatus;
  report?: unknown;
  diagnostics?: Array<{ message?: string }>;
};

type SuiteReport = {
  counts: {
    total: number;
    passed: number;
    failed: number;
    blocked: number;
    error: number;
  };
  entries: SuiteEntry[];
};

function parseSuiteReport(value: unknown): SuiteReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const report = value as Record<string, unknown>;
  if (report.schema !== 'noveltea.test-suite-report') return null;
  if (!report.counts || typeof report.counts !== 'object' || Array.isArray(report.counts))
    return null;
  if (!Array.isArray(report.entries)) return null;
  const counts = report.counts as Record<string, unknown>;
  const number = (key: string) =>
    typeof counts[key] === 'number' && Number.isInteger(counts[key]) ? (counts[key] as number) : 0;
  const entries = report.entries.flatMap((value): SuiteEntry[] => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const entry = value as Record<string, unknown>;
    if (typeof entry.id !== 'string') return [];
    if (
      entry.status !== 'passed' &&
      entry.status !== 'failed' &&
      entry.status !== 'blocked' &&
      entry.status !== 'error'
    )
      return [];
    const runner =
      entry.runner === 'runtime' || entry.runner === 'runtime-ui' ? entry.runner : null;
    const diagnostics = Array.isArray(entry.diagnostics)
      ? entry.diagnostics.flatMap((diagnostic) =>
          diagnostic && typeof diagnostic === 'object' && !Array.isArray(diagnostic)
            ? [{ message: (diagnostic as Record<string, unknown>).message as string | undefined }]
            : [],
        )
      : undefined;
    return [
      {
        id: entry.id,
        runner,
        status: entry.status,
        ...(entry.report !== undefined ? { report: entry.report } : {}),
        ...(diagnostics ? { diagnostics } : {}),
      },
    ];
  });
  return {
    counts: {
      total: number('total'),
      passed: number('passed'),
      failed: number('failed'),
      blocked: number('blocked'),
      error: number('error'),
    },
    entries,
  };
}

function suiteBadgeVariant(status: SuiteStatus): 'default' | 'secondary' | 'destructive' {
  if (status === 'passed') return 'default';
  if (status === 'blocked') return 'secondary';
  return 'destructive';
}

export function TestSuiteEditor(_props: WorkbenchEditorProps) {
  const { t } = useTranslation('workspace');
  const projectDocument = useProjectStore((state) => state.document);
  const projectSessionId = useProjectStore((state) => state.projectSessionId);
  const openTab = useWorkbenchStore((state) => state.openTab);
  const setLastPlaybackReport = useWorkspaceStore((state) => state.setLastPlaybackReport);
  const setStatusMessage = useWorkspaceStore((state) => state.setStatusMessage);
  const addTimelineEntry = useWorkspaceStore((state) => state.addTimelineEntry);
  const setBottomPanel = useBottomPanelStore((state) => state.setActivePanelId);
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const [tests, setTests] = useState<
    Array<{
      id: string;
      record: NonNullable<typeof project>['tests'][string];
      readiness: TestRunReadiness;
      label: string;
    }>
  >([]);
  const [suiteReport, setSuiteReport] = useState<SuiteReport | null>(null);
  const [runningSuite, setRunningSuite] = useState(false);

  useEffect(() => {
    let current = true;
    setSuiteReport(null);
    if (!project) {
      setTests([]);
      return () => {
        current = false;
      };
    }
    void Promise.all(
      Object.entries(project.tests).map(async ([id, record]) => ({
        id,
        record,
        readiness: await getAuthoringTestRunReadiness(project, id),
        label: record.label || id,
      })),
    ).then((next) => {
      if (current)
        setTests(
          next.sort(
            (left, right) =>
              left.label.localeCompare(right.label) || left.id.localeCompare(right.id),
          ),
        );
    });
    return () => {
      current = false;
    };
  }, [project]);

  const suiteEntryById = useMemo(
    () => new Map((suiteReport?.entries ?? []).map((entry) => [entry.id, entry])),
    [suiteReport],
  );

  if (!project)
    return <div className="p-4 text-sm text-muted-foreground">{t('tests.openProject')}</div>;
  const activeProject = project;

  async function runTest(testId: string) {
    const result = await window.noveltea.runPlaybackTest(
      projectSessionId,
      activeProject,
      testId,
      usePendingInputStore.getState().entriesBySaveUnitId,
    );
    setLastPlaybackReport(result.report ?? result);
    const message = result.ok
      ? t('tests.ranTest', { testId })
      : (result.error ?? t('tests.testRunFailed'));
    setStatusMessage(message);
    addTimelineEntry({
      source: 'playback',
      message,
      detail: result,
    });
    setBottomPanel('test-playback');
  }

  async function runAll() {
    setRunningSuite(true);
    try {
      const result = await window.noveltea.runPlaybackSuite(
        projectSessionId,
        activeProject,
        usePendingInputStore.getState().entriesBySaveUnitId,
      );
      const report = parseSuiteReport(result.report);
      setSuiteReport(report);
      const message = result.ok
        ? result.success === false
          ? t('tests.suiteCompletedWithFailures')
          : t('tests.suiteCompleted')
        : (result.error ?? t('tests.suiteFailed'));
      setStatusMessage(message);
      addTimelineEntry({ source: 'playback', message, detail: result });
    } finally {
      setRunningSuite(false);
    }
  }

  function showReport(entry: SuiteEntry) {
    if (entry.report === undefined) return;
    setLastPlaybackReport(entry.report);
    setBottomPanel('test-playback');
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-background p-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">{t('tests.title')}</h2>
          <p className="text-xs text-muted-foreground">{t('tests.description')}</p>
          {suiteReport ? (
            <div className="mt-1 text-xs text-muted-foreground">
              {t('tests.summary', suiteReport.counts)}
            </div>
          ) : null}
        </div>
        <Button size="sm" onClick={() => void runAll()} disabled={runningSuite}>
          {runningSuite ? t('tests.running') : t('tests.runAll')}
        </Button>
      </div>
      <div className="mt-4 space-y-2">
        {tests.map((test) => {
          const suiteEntry = suiteEntryById.get(test.id);
          const diagnostics =
            suiteEntry?.diagnostics?.map((item) => item.message).filter(Boolean) ?? [];
          return (
            <div
              key={test.id}
              data-testid={`suite-test-${test.id}`}
              className="flex items-center gap-3 rounded border p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{test.label}</span>
                  {suiteEntry ? (
                    <Badge variant={suiteBadgeVariant(suiteEntry.status)}>
                      {t(`tests.statuses.${suiteEntry.status}`)}
                    </Badge>
                  ) : (
                    <Badge variant={test.readiness.runnable ? 'default' : 'secondary'}>
                      {test.readiness.runnable ? t('tests.ready') : t('tests.statuses.blocked')}
                    </Badge>
                  )}
                </div>
                <div className="mt-1 font-mono text-[10px] text-muted-foreground">{test.id}</div>
                {suiteEntry ? (
                  diagnostics.map((message) => (
                    <div key={message} className="mt-1 text-xs text-muted-foreground">
                      {message}
                    </div>
                  ))
                ) : !test.readiness.runnable ? (
                  <div className="mt-1 text-xs text-muted-foreground">{test.readiness.reason}</div>
                ) : null}
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => openTab(buildTestDetailTabForRecord(test.id, test.label))}
              >
                {t('tests.open')}
              </Button>
              {suiteEntry?.report !== undefined ? (
                <Button size="sm" variant="outline" onClick={() => showReport(suiteEntry)}>
                  {t('tests.report')}
                </Button>
              ) : null}
              <Button
                size="sm"
                onClick={() => void runTest(test.id)}
                disabled={!test.readiness.runnable}
              >
                {t('tests.run')}
              </Button>
            </div>
          );
        })}
      </div>
      {tests.length === 0 ? (
        <div className="mt-8 rounded border p-4 text-sm text-muted-foreground">
          {t('tests.empty')}
        </div>
      ) : null}
    </div>
  );
}
