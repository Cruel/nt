import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useCandidateRepairStore } from './candidate-repair-store';
import { useProjectStore } from './project-store';
import { useWorkspaceStore } from '../stores/workspace-store';
import { useBottomPanelStore } from '../workbench/bottom-panel-store';
import { launchWindowRepairTerminal } from '../workbench/terminal-window-host';
import type { RepairHarness } from '../../shared/repair-harness';
import {
  useRepairPromptStore,
  repairPromptIsCurrent,
  repairPromptRunAuthorized,
} from './repair-prompt-store';

export function RepairPromptDialog() {
  const { t } = useTranslation('workspace');
  const visible = useRepairPromptStore((state) => state.visible);
  const draft = useRepairPromptStore((state) => state.draft);
  const close = useRepairPromptStore((state) => state.close);
  const request = useRepairPromptStore((state) => state.request);
  const setText = useRepairPromptStore((state) => state.setText);
  const setAuthorization = useRepairPromptStore((state) => state.setAuthorization);
  // Subscribe to both diagnostic authorities so a visible draft cannot look current
  // after a Project switch, source edit or a successful correction.
  useWorkspaceStore((state) => state.diagnostics);
  useProjectStore((state) => state.projectRevision);
  useProjectStore((state) => state.projectSessionId);
  useCandidateRepairStore((state) => state.entries);
  const [copyMessage, setCopyMessage] = useState<'copied' | 'failed' | null>(null);
  const [harnesses, setHarnesses] = useState<RepairHarness[]>([]);
  const [harness, setHarness] = useState<RepairHarness | ''>('');
  const [probing, setProbing] = useState(false);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const current = draft ? repairPromptIsCurrent(draft) : false;

  useEffect(() => {
    if (!visible) return;
    let active = true;
    setProbing(true);
    setRunError(null);
    void window.noveltea
      .probeRepairHarnesses()
      .then((installed) => {
        if (!active) return;
        setHarnesses(installed);
        setHarness((previous) =>
          installed.includes(previous as RepairHarness) ? previous : (installed[0] ?? ''),
        );
      })
      .catch((error: unknown) => {
        if (!active) return;
        setHarnesses([]);
        setHarness('');
        setRunError(error instanceof Error ? error.message : t('repairPrompt.probeFailed'));
      })
      .finally(() => {
        if (active) setProbing(false);
      });
    return () => {
      active = false;
    };
  }, [visible, t]);

  async function run() {
    if (!draft || !harness || running || !draft.text.trim() || !repairPromptRunAuthorized(draft))
      return;
    setRunning(true);
    setRunError(null);
    try {
      await launchWindowRepairTerminal({
        kind: draft.kind,
        id: draft.id,
        candidateRevision: draft.candidateRevision,
        harness,
        prompt: draft.text,
        authorizeWeak: draft.authorizeWeak,
        authorizeOlder: draft.authorizeOlder,
        authorizeNewer: draft.authorizeNewer,
      });
      useBottomPanelStore.getState().setActivePanelId('terminal');
      close();
    } catch (error) {
      setRunError(error instanceof Error ? error.message : t('repairPrompt.runFailed'));
    } finally {
      setRunning(false);
    }
  }

  async function copy() {
    if (!draft || !current) return;
    try {
      await navigator.clipboard.writeText(draft.text);
      setCopyMessage('copied');
    } catch {
      setCopyMessage('failed');
    }
  }

  return (
    <Dialog open={visible} onOpenChange={(open) => !open && close()}>
      <DialogContent className="flex max-h-[90vh] w-[min(56rem,calc(100vw-2rem))] max-w-none flex-col gap-3">
        <DialogHeader>
          <DialogTitle>{t('repairPrompt.title')}</DialogTitle>
          <DialogDescription>{t('repairPrompt.description')}</DialogDescription>
        </DialogHeader>
        {draft ? (
          <>
            <div className="truncate font-mono text-xs text-muted-foreground" title={draft.root}>
              {draft.root}
            </div>
            {!current ? (
              <div role="alert" className="space-y-2 text-xs text-amber-600">
                <p>{t('repairPrompt.outdated')}</p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setCopyMessage(null);
                    request({
                      kind: draft.kind,
                      id: draft.id,
                      scope: draft.scope,
                      selectedKey: draft.selectedKey,
                    });
                  }}
                >
                  {t('repairPrompt.regenerate')}
                </Button>
              </div>
            ) : null}
            {draft.kind === 'candidate' &&
            draft.formatRisk === 'unknown' &&
            !draft.manifestAbsent ? (
              <p role="alert" className="text-xs text-amber-600">
                {t('repairPrompt.unknownFormat')}
              </p>
            ) : null}
            {draft.recognition === 'weak' ? (
              <label className="flex items-start gap-2 text-xs text-amber-600">
                <input
                  type="checkbox"
                  checked={draft.authorizeWeak}
                  onChange={(event) => setAuthorization('authorizeWeak', event.target.checked)}
                />
                {t('repairPrompt.weakConsent')}
              </label>
            ) : null}
            {draft.formatRisk === 'newer' ? (
              <label className="flex items-start gap-2 text-xs text-destructive" role="alert">
                <input
                  type="checkbox"
                  checked={draft.authorizeNewer}
                  onChange={(event) => setAuthorization('authorizeNewer', event.target.checked)}
                />
                {t('repairPrompt.newerConsent')}
              </label>
            ) : null}
            {draft.formatRisk === 'older' ? (
              <label className="flex items-start gap-2 text-xs text-amber-600">
                <input
                  type="checkbox"
                  checked={draft.authorizeOlder}
                  onChange={(event) => setAuthorization('authorizeOlder', event.target.checked)}
                />
                {t('repairPrompt.olderConsent')}
              </label>
            ) : null}
            <label className="flex min-h-0 flex-1 flex-col gap-1 text-xs font-medium">
              {t('repairPrompt.promptLabel')}
              <textarea
                className="min-h-44 w-full flex-1 resize-y rounded border bg-background p-3 font-mono text-xs font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                value={draft.text}
                onChange={(event) => {
                  setText(event.target.value);
                  setCopyMessage(null);
                }}
                spellCheck={false}
              />
            </label>
          </>
        ) : null}
        {runError ? (
          <p
            role="alert"
            className="max-h-24 overflow-auto whitespace-pre-wrap break-words text-xs text-destructive"
          >
            {runError}
          </p>
        ) : null}
        <DialogFooter className="items-center">
          {copyMessage ? (
            <span role="status" className="text-xs text-muted-foreground">
              {t(`repairPrompt.${copyMessage}`)}
            </span>
          ) : null}
          <Button variant="outline" onClick={close}>
            {t('repairPrompt.close')}
          </Button>
          <Button disabled={!draft || !current || !draft.text.trim()} onClick={() => void copy()}>
            {t('repairPrompt.copy')}
          </Button>
          <select
            className="h-8 max-w-32 rounded border bg-background px-2 text-xs"
            aria-label={t('repairPrompt.harnessLabel')}
            value={harness}
            disabled={probing || running || harnesses.length === 0}
            onChange={(event) => setHarness(event.target.value as RepairHarness)}
          >
            {harnesses.length === 0 ? (
              <option value="">{t('repairPrompt.noHarness')}</option>
            ) : null}
            {harnesses.map((available) => (
              <option key={available} value={available}>
                {available === 'claude'
                  ? 'Claude Code'
                  : available === 'codex'
                    ? 'Codex'
                    : 'OpenCode'}
              </option>
            ))}
          </select>
          <span title={harnesses.length === 0 ? t('repairPrompt.noHarnessTooltip') : undefined}>
            <Button
              disabled={
                !draft ||
                !harness ||
                probing ||
                running ||
                !draft.text.trim() ||
                !repairPromptRunAuthorized(draft)
              }
              onClick={() => void run()}
            >
              {running ? t('repairPrompt.preparing') : t('repairPrompt.run')}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
