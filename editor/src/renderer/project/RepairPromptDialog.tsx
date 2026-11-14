import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCandidateRepairStore } from './candidate-repair-store';
import { useProjectStore } from './project-store';
import { flushNativeProjectSources } from './project-source-store';
import { flushNativeFields } from '../commands/native-field-drafts';
import { useCommandStore } from '../commands/command-store';
import { useDraftDirtyStore } from '../workbench/draft-dirty-store';
import { assertNoUnprojectedRendererDrafts } from './agent-working-source-draft-guard';
import { useWorkspaceStore } from '../stores/workspace-store';
import { useBottomPanelStore } from '../workbench/bottom-panel-store';
import { launchWindowRepairTerminal } from '../workbench/terminal-window-host';
import type { RepairHarness } from '../../shared/repair-harness';
import type { WorkingSourceRepresentations } from '../../shared/editor-tooling';
import { validRepairModelId } from '../../shared/repair-harness';
import { usePreferencesStore } from '../stores/preferences-store';
import { refreshRepairToolCatalog, useRepairToolCatalogStore } from './repair-tool-catalog-store';
import {
  useRepairPromptStore,
  repairPromptIsCurrent,
  repairPromptRunAuthorized,
} from './repair-prompt-store';

async function prepareAgentWorkingSources(
  sessionId: string,
): Promise<WorkingSourceRepresentations> {
  if (!(await flushNativeFields()))
    throw new Error('Unsaved Project fields have not been acknowledged by native editing.');
  await flushNativeProjectSources();
  assertNoUnprojectedRendererDrafts(useDraftDirtyStore.getState().entriesByKey);
  return window.noveltea.nativeProjectFlushWorkingSources(sessionId);
}

export function RepairPromptDialog() {
  const { t } = useTranslation('workspace');
  const visible = useRepairPromptStore((state) => state.visible);
  const draft = useRepairPromptStore((state) => state.draft);
  const close = useRepairPromptStore((state) => state.close);
  const request = useRepairPromptStore((state) => state.request);
  const setText = useRepairPromptStore((state) => state.setText);
  const setWorkingPublication = useRepairPromptStore((state) => state.setWorkingPublication);
  const setAuthorization = useRepairPromptStore((state) => state.setAuthorization);
  // Subscribe to both diagnostic authorities so a visible draft cannot look current
  // after a Project switch, source edit or a successful correction.
  useWorkspaceStore((state) => state.diagnostics);
  useProjectStore((state) => state.projectRevision);
  useProjectStore((state) => state.projectSessionId);
  useCommandStore((state) => state.nativeWorkingRevision);
  useCandidateRepairStore((state) => state.entries);
  const [copyMessage, setCopyMessage] = useState<'copied' | 'failed' | null>(null);
  const repairPreferences = usePreferencesStore((state) => state.repair);
  const harnesses = useRepairToolCatalogStore((state) => state.harnesses);
  const catalogs = useRepairToolCatalogStore((state) => state.catalogs);
  const harness =
    harnesses.find((item) => item === repairPreferences.preferredHarness) ?? harnesses[0] ?? null;
  const catalog = harness ? catalogs[harness] : undefined;
  const [manualOverride, setManualOverride] = useState<{
    harness: RepairHarness;
    text: string;
  } | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const current = draft ? repairPromptIsCurrent(draft) : false;
  const [publishedPrompt, setPublishedPrompt] = useState<string | null>(null);
  const publicationKey = draft
    ? JSON.stringify([
        draft.id,
        draft.sourceFingerprint,
        draft.scope,
        draft.selectedKey,
        draft.requestGeneration,
      ])
    : null;
  const projectionReady =
    !draft ||
    draft.kind === 'candidate' ||
    (draft.workingSources !== undefined && publishedPrompt === publicationKey);
  const draftId = draft?.id;
  const draftKind = draft?.kind;
  const draftSourceFingerprint = draft?.sourceFingerprint;
  const draftScope = draft?.scope;
  const draftSelectedKey = draft?.selectedKey;
  const draftGeneration = draft?.requestGeneration;

  useEffect(() => {
    if (!visible || !draftId || draftKind !== 'active') return;
    let live = true;
    setPublishedPrompt(null);
    setRunError(null);
    void prepareAgentWorkingSources(draftId)
      .then((sources) => {
        if (!live) return;
        if (
          !sources ||
          !setWorkingPublication(
            { kind: 'active', id: draftId, scope: draftScope!, selectedKey: draftSelectedKey },
            draftSourceFingerprint!,
            sources,
          )
        )
          throw new Error(
            'Working Project changed while preparing the prompt. Regenerate from current diagnostics.',
          );
        setPublishedPrompt(
          JSON.stringify([
            draftId,
            draftSourceFingerprint,
            draftScope,
            draftSelectedKey,
            draftGeneration,
          ]),
        );
        setRunError(null);
      })
      .catch((error: unknown) => {
        if (live) setRunError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      live = false;
    };
  }, [
    visible,
    draftId,
    draftKind,
    draftSourceFingerprint,
    draftScope,
    draftSelectedKey,
    draftGeneration,
    setWorkingPublication,
  ]);

  useEffect(() => {
    if (!visible) return;
    // Refresh in the background without clearing cached tools, models, or the
    // user's selection while probing slow external CLIs.
    void refreshRepairToolCatalog(true);
  }, [visible]);

  useEffect(() => {
    if (!visible) setManualOverride(null);
  }, [visible]);

  const storedModel = harness ? repairPreferences.modelByHarness[harness] : '';
  const listedModel =
    !!storedModel &&
    !!catalog &&
    catalog.status === 'available' &&
    catalog.models.includes(storedModel);
  const missingModel = !!storedModel && catalog?.status === 'available' && !listedModel;
  const editingManual = !!harness && manualOverride?.harness === harness;
  const showManual =
    editingManual || (!!storedModel && (missingModel || catalog?.status === 'unavailable'));
  const effectiveModel = editingManual ? manualOverride.text : storedModel;
  const modelIsValid = !effectiveModel || validRepairModelId(effectiveModel);

  async function run() {
    if (
      !draft ||
      !harness ||
      running ||
      !modelIsValid ||
      !draft.text.trim() ||
      !projectionReady ||
      !repairPromptRunAuthorized(draft)
    )
      return;
    setRunning(true);
    setRunError(null);
    try {
      if (draft.kind === 'active') {
        const sources = await prepareAgentWorkingSources(draft.id);
        if (!sources || !setWorkingPublication(draft, draft.sourceFingerprint, sources))
          throw new Error('Working Project changed. Regenerate the prompt before Run.');
        if (!repairPromptRunAuthorized(useRepairPromptStore.getState().draft!))
          throw new Error('Project validation changed before Run.');
      }
      await launchWindowRepairTerminal({
        kind: draft.kind,
        id: draft.id,
        candidateRevision: draft.candidateRevision,
        harness,
        ...(effectiveModel ? { model: effectiveModel } : {}),
        prompt: draft.text,
        authorizeWeak: draft.authorizeWeak,
        authorizeOlder: draft.authorizeOlder,
        authorizeNewer: draft.authorizeNewer,
      });
      usePreferencesStore.getState().setRepairHarness(harness);
      useBottomPanelStore.getState().setActivePanelId('terminal');
      close();
    } catch (error) {
      setRunError(error instanceof Error ? error.message : t('repairPrompt.runFailed'));
    } finally {
      setRunning(false);
    }
  }

  async function copy() {
    if (!draft || !current || !projectionReady) return;
    try {
      if (draft.kind === 'active') {
        const sources = await prepareAgentWorkingSources(draft.id);
        if (!sources || !setWorkingPublication(draft, draft.sourceFingerprint, sources))
          throw new Error('Working Project changed. Regenerate the prompt before Copy.');
      }
      const currentDraft = useRepairPromptStore.getState().draft;
      if (!currentDraft || !repairPromptIsCurrent(currentDraft))
        throw new Error('Project diagnostics changed before Copy.');
      await navigator.clipboard.writeText(currentDraft.text);
      setCopyMessage('copied');
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
      setCopyMessage('failed');
    }
  }

  return (
    <Dialog open={visible} onOpenChange={(open) => !open && close()}>
      <DialogContent className="flex max-h-[90vh] w-[min(56rem,calc(100vw-2rem))] max-w-none flex-col gap-3">
        <DialogHeader>
          <DialogTitle>{t('repairPrompt.title')}</DialogTitle>
        </DialogHeader>
        {draft ? (
          <>
            <div className="truncate font-mono text-xs text-muted-foreground" title={draft.root}>
              {draft.root}
            </div>
            {!current || (draft.kind === 'active' && !projectionReady && runError) ? (
              <div className="space-y-2 text-xs text-amber-600">
                {!current ? <p role="alert">{t('repairPrompt.outdated')}</p> : null}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setCopyMessage(null);
                    setRunError(null);
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
            <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-xs">
              <Label htmlFor="repair-harness">{t('repairPrompt.harnessLabel')}</Label>
              <Select
                items={harnesses.map((available) => ({
                  value: available,
                  label:
                    available === 'claude'
                      ? 'Claude Code'
                      : available === 'codex'
                        ? 'Codex'
                        : 'OpenCode',
                }))}
                value={harness}
                disabled={running || harnesses.length === 0}
                onValueChange={(next) => {
                  if (!next) return;
                  setManualOverride(null);
                  usePreferencesStore.getState().setRepairHarness(next);
                }}
              >
                <SelectTrigger
                  id="repair-harness"
                  className="w-full min-w-0"
                  aria-label={t('repairPrompt.harnessLabel')}
                >
                  <SelectValue placeholder={t('repairPrompt.noHarness')} />
                </SelectTrigger>
                <SelectContent>
                  {harnesses.map((available) => (
                    <SelectItem key={available} value={available}>
                      {available === 'claude'
                        ? 'Claude Code'
                        : available === 'codex'
                          ? 'Codex'
                          : 'OpenCode'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Label htmlFor="repair-model">{t('repairPrompt.modelLabel')}</Label>
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                <Select
                  items={[
                    ...(catalog?.status === 'available'
                      ? catalog.models.map((model) => ({ value: model, label: model }))
                      : []),
                    { value: '__manual__', label: t('repairPrompt.manualModel') },
                  ]}
                  placeholderItem={t('repairPrompt.defaultModel')}
                  value={showManual ? '__manual__' : storedModel || null}
                  disabled={!harness || running}
                  onValueChange={(selected) => {
                    if (!harness) return;
                    if (selected === '__manual__') {
                      setManualOverride({ harness, text: storedModel });
                    } else {
                      setManualOverride(null);
                      usePreferencesStore.getState().setRepairModel(harness, selected ?? '');
                    }
                  }}
                >
                  <SelectTrigger
                    id="repair-model"
                    aria-label={t('repairPrompt.modelLabel')}
                    className="w-full min-w-0 sm:flex-1"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {catalog?.status === 'available'
                      ? catalog.models.map((model) => (
                          <SelectItem key={model} value={model}>
                            {model}
                          </SelectItem>
                        ))
                      : null}
                    <SelectItem value="__manual__">{t('repairPrompt.manualModel')}</SelectItem>
                  </SelectContent>
                </Select>
                {showManual ? (
                  <input
                    className="h-7 min-w-0 rounded-md border border-input bg-background px-2 font-mono text-xs sm:w-48"
                    aria-label={t('repairPrompt.manualModelLabel')}
                    value={editingManual ? manualOverride.text : storedModel}
                    maxLength={256}
                    placeholder={t('repairPrompt.manualModelPlaceholder')}
                    onChange={(event) => {
                      const next = event.target.value;
                      if (!harness) return;
                      setManualOverride({ harness, text: next });
                      if (!next || validRepairModelId(next))
                        usePreferencesStore.getState().setRepairModel(harness, next);
                    }}
                  />
                ) : null}
              </div>
              {harness && catalog?.status === 'unavailable' ? (
                <span className="col-start-2 text-muted-foreground">
                  {t('repairPrompt.modelUnavailable')}
                </span>
              ) : null}
            </div>
            {missingModel ? (
              <p role="alert" className="text-xs text-amber-600">
                {t('repairPrompt.modelMissing', { model: storedModel })}
              </p>
            ) : null}
            <label className="flex min-h-0 flex-1 flex-col gap-1 text-xs font-medium">
              {t('repairPrompt.promptLabel')}
              <textarea
                className="min-h-44 w-full flex-1 resize-y rounded border bg-background p-3 font-mono text-xs font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                value={projectionReady ? draft.text : ''}
                disabled={!projectionReady}
                onChange={(event) => {
                  setText(event.target.value);
                  setCopyMessage(null);
                }}
                spellCheck={false}
              />
            </label>
            {!modelIsValid ? (
              <p role="alert" className="text-xs text-destructive">
                {t('repairPrompt.invalidModel')}
              </p>
            ) : null}
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
          <Button
            disabled={!draft || !current || !projectionReady || !draft.text.trim()}
            onClick={() => void copy()}
          >
            {t('repairPrompt.copy')}
          </Button>
          <span title={harnesses.length === 0 ? t('repairPrompt.noHarnessTooltip') : undefined}>
            <Button
              disabled={
                !draft ||
                !harness ||
                running ||
                !modelIsValid ||
                !projectionReady ||
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
