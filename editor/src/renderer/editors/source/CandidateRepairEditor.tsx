import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  SourceEditor,
  type SourceEditorHandle,
  type SourceEditorDiagnostic,
} from '@/components/source/SourceEditor';
import { useCandidateRepairStore } from '@/project/candidate-repair-store';
import { useRepairPromptStore } from '@/project/repair-prompt-store';
import { repairDiagnosticKey } from '@/project/repair-prompt';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { dispatchWorkspaceToolbarCommand } from '@/workspace/workspace-toolbar-events';
import { registerWorkbenchTargetHandler } from '@/workbench/workbench-navigation';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';

export function CandidateRepairEditor({ tab }: WorkbenchEditorProps) {
  const { t } = useTranslation('workspace');
  const id = tab.resource?.sourceId;
  const entry = useCandidateRepairStore((state) => (id ? state.entries[id] : undefined));
  const load = useCandidateRepairStore((state) => state.load);
  const save = useCandidateRepairStore((state) => state.save);
  const setBuffer = useCandidateRepairStore((state) => state.setBuffer);
  const applyDiskSource = useCandidateRepairStore((state) => state.useDisk);
  const requestPrompt = useRepairPromptStore((state) => state.request);
  const setTabDirty = useWorkbenchStore((state) => state.setTabDirty);
  const sourceEditor = useRef<SourceEditorHandle>(null);
  const dirty = Boolean(entry?.source && entry.buffer !== entry.source.text);
  const diagnosticsCurrent = !entry?.diagnosticsNeedRefresh && !dirty;

  useEffect(() => {
    if (id) void load(id);
  }, [id, load]);
  useEffect(() => {
    setTabDirty(tab.id, dirty);
  }, [dirty, setTabDirty, tab.id]);
  useEffect(
    () =>
      registerWorkbenchTargetHandler(tab.id, 'source.line', (target) => {
        const position = target.payload as { line?: number; column?: number } | null;
        if (!sourceEditor.current) return false;
        sourceEditor.current.revealLine(position?.line ?? 1, position?.column);
        return true;
      }),
    [tab.id],
  );
  useEffect(() => {
    if (!id || !entry?.source) return;
    const diagnostic = entry.diagnostics.find(
      (item) => item.line && (item.sourcePath === 'project.yaml' || item.path === '/project.yaml'),
    );
    if (!diagnostic) return;
    sourceEditor.current?.revealLine(diagnostic.line!, diagnostic.column);
  }, [id, entry?.source, entry?.diagnostics]);

  if (!id || !entry) return <p className="p-4 text-sm">{t('candidateRepair.expired')}</p>;
  const source = entry.source;
  const diagnostics: SourceEditorDiagnostic[] = (entry.diagnostics || [])
    .filter((d) => d.line && (d.sourcePath === 'project.yaml' || d.path === '/project.yaml'))
    .map((d) => {
      const lines = (entry.buffer ?? '').split('\n');
      const before = lines.slice(0, Math.max(0, d.line! - 1)).join('\n');
      const from = before.length + (d.line! > 1 ? 1 : 0) + Math.max(0, (d.column ?? 1) - 1);
      return { from, to: from, message: d.message, severity: d.severity };
    });
  const repairErrorKey = !entry.error
    ? null
    : /changed on disk|changed during Save|was created outside|disk source changed/iu.test(
          entry.error,
        )
      ? 'stale'
      : /ordinary source file|size limit|ELOOP/iu.test(entry.error)
        ? 'unsafeTarget'
        : /root changed/iu.test(entry.error)
          ? 'rootChanged'
          : /expired/iu.test(entry.error)
            ? 'expired'
            : /requires strong NovelTea candidate evidence/iu.test(entry.error)
              ? 'missingEvidence'
              : /EACCES|EPERM|permission denied/iu.test(entry.error)
                ? 'permission'
                : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3" data-candidate-repair-id={id}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{t('candidateRepair.title')}</div>
          <div className="truncate font-mono text-xs text-muted-foreground" title={entry.root}>
            {entry.root}/project.yaml
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            if (!entry.status?.ready || !entry.status.revision) return;
            dispatchWorkspaceToolbarCommand({
              command: 'open-project',
              projectPath: entry.root,
              repairCandidateId: id,
              readyRevision: entry.status.revision,
            });
          }}
          disabled={
            entry.admitted ||
            !entry.status?.ready ||
            !entry.status.revision ||
            dirty ||
            entry.saving ||
            !!entry.diskSource
          }
        >
          {t('candidateRepair.openProject')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void load(id, true);
            void useCandidateRepairStore.getState().observe(id);
          }}
          disabled={entry.loading || entry.saving || entry.admitted}
        >
          {t('candidateRepair.readDisk')}
        </Button>
        <Button
          size="sm"
          onClick={() => void save(id)}
          disabled={!source || !dirty || entry.saving || !!entry.diskSource || entry.admitted}
        >
          {entry.saving ? t('candidateRepair.saving') : t('candidateRepair.save')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('candidateRepair.description')}</p>
      {entry.diagnosticsNeedRefresh || dirty ? (
        <p className="text-xs text-muted-foreground" role="status">
          {t('repairPrompt.candidateRefresh')}
        </p>
      ) : null}
      {diagnosticsCurrent &&
      entry.diagnostics.some((diagnostic) => diagnostic.severity !== 'info') ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Button
            size="sm"
            variant="outline"
            onClick={() => requestPrompt({ kind: 'candidate', id, scope: 'all' })}
          >
            {t('repairPrompt.fixAll')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!entry.diagnostics.some((diagnostic) => diagnostic.severity === 'error')}
            onClick={() => requestPrompt({ kind: 'candidate', id, scope: 'errors' })}
          >
            {t('repairPrompt.fixAllErrors')}
          </Button>
          {entry.diagnostics
            .filter((diagnostic) => diagnostic.severity !== 'info')
            .map((diagnostic, index) => (
              <Button
                key={`${repairDiagnosticKey(diagnostic)}:${index}`}
                size="sm"
                variant="outline"
                title={diagnostic.message}
                onClick={() => {
                  if (diagnostic.sourcePath === 'project.yaml' && diagnostic.line)
                    sourceEditor.current?.revealLine(diagnostic.line, diagnostic.column);
                  requestPrompt({
                    kind: 'candidate',
                    id,
                    scope: 'one',
                    selectedKey: repairDiagnosticKey(diagnostic),
                  });
                }}
              >
                {t('repairPrompt.fix')} · {index + 1}
              </Button>
            ))}
        </div>
      ) : null}
      {entry.recognition === 'weak' ? (
        <p className="text-xs text-amber-600">{t('candidateRepair.weak')}</p>
      ) : null}
      {entry.admitted ? (
        <p className="text-xs text-muted-foreground">{t('candidateRepair.admitted')}</p>
      ) : null}
      {entry.status?.ready && !dirty ? (
        <p className="text-xs text-muted-foreground">{t('candidateRepair.ready')}</p>
      ) : null}
      {entry.error ? (
        <p role="alert" className="text-xs text-destructive">
          {repairErrorKey ? t(`candidateRepair.errors.${repairErrorKey}`) : entry.error}
        </p>
      ) : null}
      {entry.diskText !== undefined ? (
        <details className="text-xs">
          <summary>{t('candidateRepair.diskChanged')}</summary>
          <pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">
            {entry.diskText}
          </pre>
          <Button size="sm" variant="outline" onClick={() => applyDiskSource(id)}>
            {t('candidateRepair.useDisk')}
          </Button>
        </details>
      ) : null}
      {source ? (
        <div className="min-h-0 flex-1 overflow-hidden rounded border">
          <SourceEditor
            ref={sourceEditor}
            value={entry.buffer ?? ''}
            onChange={(text) => setBuffer(id, text)}
            language="text"
            diagnostics={diagnostics}
            className="h-full min-h-0 rounded-none border-0"
          />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {entry.loading ? t('candidateRepair.loading') : t('candidateRepair.unavailable')}
        </p>
      )}
    </div>
  );
}
