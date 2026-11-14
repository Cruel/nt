import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  SourceEditor,
  type SourceEditorHandle,
  type SourceEditorDiagnostic,
} from '@/components/source/SourceEditor';
import {
  candidateVisibleDiagnostics,
  useCandidateRepairStore,
} from '@/project/candidate-repair-store';
import { candidateManifestSyntaxDiagnostics } from '../../../shared/project-candidate-syntax';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { registerWorkbenchTargetHandler } from '@/workbench/workbench-navigation';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';

export function CandidateRepairEditor({ tab }: WorkbenchEditorProps) {
  const { t } = useTranslation('workspace');
  const id = tab.resource?.sourceId;
  const entry = useCandidateRepairStore((state) => (id ? state.entries[id] : undefined));
  const load = useCandidateRepairStore((state) => state.load);
  const setBuffer = useCandidateRepairStore((state) => state.setBuffer);
  const setSyntaxDiagnostics = useCandidateRepairStore((state) => state.setSyntaxDiagnostics);
  const applyDiskSource = useCandidateRepairStore((state) => state.useDisk);
  const setTabDirty = useWorkbenchStore((state) => state.setTabDirty);
  const sourceEditor = useRef<SourceEditorHandle>(null);
  const dirty = Boolean(entry?.source && entry.buffer !== entry.source.text);
  const currentText = entry?.buffer;

  // The editor and Problems use local syntax for the exact unsaved revision.
  useEffect(() => {
    if (!id || currentText === undefined) return;
    const timer = setTimeout(() => {
      setSyntaxDiagnostics(id, currentText, candidateManifestSyntaxDiagnostics(currentText));
    }, 180);
    return () => clearTimeout(timer);
  }, [id, currentText, setSyntaxDiagnostics]);

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
  const bufferLines = (currentText ?? '').split('\n');
  const diagnostics: SourceEditorDiagnostic[] = candidateVisibleDiagnostics(entry)
    .filter((d) => d.line && (d.sourcePath === 'project.yaml' || d.path === '/project.yaml'))
    .map((d) => {
      const row = Math.min(Math.max(1, d.line!), bufferLines.length);
      const before = bufferLines.slice(0, row - 1).join('\n');
      const from =
        before.length +
        (row > 1 ? 1 : 0) +
        Math.min(Math.max(0, (d.column ?? 1) - 1), bufferLines[row - 1]?.length ?? 0);
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
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <span className="truncate font-mono font-medium" title={`${entry.root}/project.yaml`}>
          project.yaml
        </span>
        <span className="shrink-0 whitespace-nowrap text-muted-foreground">
          {t('candidateRepair.saveHint')}
        </span>
        <span
          role={entry.saving || entry.validatingAfterSave ? 'status' : undefined}
          className="min-w-0 flex-1 text-center text-muted-foreground"
        >
          {entry.saving
            ? t('candidateRepair.saving')
            : entry.validatingAfterSave
              ? t('candidateRepair.validating')
              : null}
        </span>
      </div>
      {entry.recognition === 'weak' ? (
        <p className="text-xs text-amber-600">{t('candidateRepair.weak')}</p>
      ) : null}
      {entry.admitted ? (
        <p className="text-xs text-muted-foreground">{t('candidateRepair.admitted')}</p>
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
