import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { useCommandStore } from '@/commands/command-store';
import { buildProjectSettingsTab } from '@/workbench/editor-registry';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { cancelComfyUiJob, listComfyUiWorkflows } from '@/comfyui/comfyui-service';
import { useComfyUiStore } from '@/comfyui/comfyui-store';
import { useComfyUiGenerationStore, type GeneratedImageRevision } from '@/comfyui/comfyui-generation-store';
import { useComfyUiQueueStore } from '@/comfyui/comfyui-queue-store';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import type { ComfyUiWorkflowDefinition } from '../../../shared/comfyui-workflows';
import { defaultAssetIdFromFilename, parseAssetData } from '../../../shared/project-schema/authoring-assets';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';

const EMPTY_REVISIONS: GeneratedImageRevision[] = [];

function numericInputValue(value: string) {
  return value.replace(/\D/g, '');
}

function numberOrUndefined(value: string) {
  const trimmed = numericInputValue(value);
  if (!trimmed) return undefined;
  const number = Number(trimmed);
  return Number.isSafeInteger(number) ? number : undefined;
}

function positiveIntegerIssue(label: string, value: string) {
  const number = numberOrUndefined(value);
  if (number === undefined) return `${label} is required.`;
  if (number < 1) return `${label} must be at least 1.`;
  return null;
}

function optionalIntegerIssue(label: string, value: string) {
  const trimmed = numericInputValue(value);
  if (!trimmed) return null;
  return Number.isSafeInteger(Number(trimmed)) ? null : `${label} is too large.`;
}

function firstIssue(...issues: Array<string | null>) {
  return issues.find((issue): issue is string => issue !== null) ?? null;
}

function promptTitle(prompt: string) {
  const trimmed = prompt.trim();
  return trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed || 'Untitled generation';
}

function sourceFromTab(tab: WorkbenchEditorProps['tab']) {
  return {
    sourceAssetId: tab.resource?.entityId ?? undefined,
    sourceProjectRelativePath: tab.resource?.sourceProjectRelativePath,
    mode: tab.resource?.generationMode === 'edit' ? 'edit' : 'generate',
  } as const;
}

function canCancelJob(state: string) {
  return state === 'queued' || state === 'running' || state === 'finalizing';
}

function displayJobState(state: string) {
  return state === 'interrupted' ? 'Canceled' : state;
}

function assetIdForRevision(revision: GeneratedImageRevision) {
  return defaultAssetIdFromFilename(revision.asset.originalName);
}

export function ImageGenerationEditor({ tab }: WorkbenchEditorProps) {
  const project = useProjectStore((state) => state.document);
  const projectFilePath = useProjectStore((state) => state.projectFilePath);
  const executeCommand = useCommandStore((state) => state.executeCommand);
  const comfyUiConfig = useComfyUiStore((state) => state.config);
  const comfyUiStatus = useComfyUiStore((state) => state.status);
  const openWorkbenchTab = useWorkbenchStore((state) => state.openTab);
  const revisions = useComfyUiGenerationStore((state) => state.revisionsByTabId[tab.id] ?? EMPTY_REVISIONS);
  const selectedRevisionId = useComfyUiGenerationStore((state) => state.selectedRevisionByTabId[tab.id] ?? null);
  const queueJobsByPromptId = useComfyUiQueueStore((state) => state.jobsByPromptId);
  const queueOrder = useComfyUiQueueStore((state) => state.order);
  const enqueueJob = useComfyUiQueueStore((state) => state.enqueueJob);
  const markInterrupted = useComfyUiQueueStore((state) => state.markInterrupted);
  const removeQueueJob = useComfyUiQueueStore((state) => state.removeJob);
  const selectRevision = useComfyUiGenerationStore((state) => state.selectRevision);
  const markRevisionAssetAdded = useComfyUiGenerationStore((state) => state.markRevisionAssetAdded);
  const deleteRevision = useComfyUiGenerationStore((state) => state.deleteRevision);
  const initialSource = sourceFromTab(tab);
  const [prompt, setPrompt] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  const [generateWidth, setGenerateWidth] = useState('1024');
  const [generateHeight, setGenerateHeight] = useState('1024');
  const [generateSteps, setGenerateSteps] = useState('20');
  const [generateSeed, setGenerateSeed] = useState('');
  const [editSteps, setEditSteps] = useState('4');
  const [editSeed, setEditSeed] = useState('');
  const [workflowMessage, setWorkflowMessage] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<ComfyUiWorkflowDefinition[]>([]);
  const [generateWorkflowId, setGenerateWorkflowId] = useState('');
  const [editWorkflowId, setEditWorkflowId] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [generateQueuedFeedback, setGenerateQueuedFeedback] = useState(false);
  const [editQueuedFeedback, setEditQueuedFeedback] = useState(false);
  const [sourcePreviewUrl, setSourcePreviewUrl] = useState<string | null>(null);
  const mounted = useRef(true);
  const generateQueuedFeedbackTimer = useRef<number | null>(null);
  const editQueuedFeedbackTimer = useRef<number | null>(null);
  const generateWorkflows = useMemo(() => workflows.filter((workflow) => workflow.role === 'image.generate'), [workflows]);
  const editWorkflows = useMemo(() => workflows.filter((workflow) => workflow.role === 'image.edit'), [workflows]);
  const selectedGenerateWorkflow = useMemo(() => generateWorkflows.find((workflow) => workflow.id === generateWorkflowId) ?? generateWorkflows[0] ?? null, [generateWorkflowId, generateWorkflows]);
  const selectedEditWorkflow = useMemo(() => editWorkflows.find((workflow) => workflow.id === editWorkflowId) ?? editWorkflows[0] ?? null, [editWorkflowId, editWorkflows]);
  const selectedRevision = useMemo(() => revisions.find((revision) => revision.id === selectedRevisionId) ?? revisions.at(-1) ?? null, [revisions, selectedRevisionId]);
  const activeJob = useMemo(() => {
    const projectJobs = queueOrder
      .map((promptId) => queueJobsByPromptId[promptId])
      .filter((job) => job?.projectFilePath === projectFilePath);
    return projectJobs.find((job) => job.state === 'running')
      ?? projectJobs.find((job) => job.state === 'queued')
      ?? projectJobs.find((job) => job.state === 'error')
      ?? projectJobs[0]
      ?? null;
  }, [projectFilePath, queueJobsByPromptId, queueOrder]);
  const sourceAsset = useMemo(() => {
    if (!initialSource.sourceAssetId || !isAuthoringProject(project)) return null;
    const record = project.assets[initialSource.sourceAssetId];
    const data = parseAssetData(record?.data);
    if (!record || !data) return null;
    return { id: initialSource.sourceAssetId, label: record.label, path: data.source.path, kind: data.kind };
  }, [initialSource.sourceAssetId, project]);
  const generateValidationIssue = firstIssue(
    positiveIntegerIssue('Width', generateWidth),
    positiveIntegerIssue('Height', generateHeight),
    positiveIntegerIssue('Generate steps', generateSteps),
    optionalIntegerIssue('Generate seed', generateSeed),
  );
  const editValidationIssue = firstIssue(
    positiveIntegerIssue('Edit steps', editSteps),
    optionalIntegerIssue('Edit seed', editSeed),
  );
  const canQueueGenerate = !!projectFilePath && !!selectedGenerateWorkflow && !!prompt.trim() && !generateValidationIssue && !generateQueuedFeedback;
  const canQueueEdit = !!projectFilePath && !!selectedEditWorkflow && !!editPrompt.trim() && (!!selectedRevision || !!sourceAsset) && !editValidationIssue && !editQueuedFeedback;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (generateQueuedFeedbackTimer.current !== null) {
        window.clearTimeout(generateQueuedFeedbackTimer.current);
        generateQueuedFeedbackTimer.current = null;
      }
      if (editQueuedFeedbackTimer.current !== null) {
        window.clearTimeout(editQueuedFeedbackTimer.current);
        editQueuedFeedbackTimer.current = null;
      }
    };
  }, []);

  function triggerQueuedFeedback(kind: 'generate' | 'edit') {
    const setFeedback = kind === 'generate' ? setGenerateQueuedFeedback : setEditQueuedFeedback;
    const timerRef = kind === 'generate' ? generateQueuedFeedbackTimer : editQueuedFeedbackTimer;
    setFeedback(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      if (!mounted.current) return;
      setFeedback(false);
      timerRef.current = null;
    }, 1000);
  }

  function setMountedMessage(next: string) {
    if (mounted.current) setMessage(next);
  }

  useEffect(() => {
    let canceled = false;
    setWorkflowMessage(null);
    setWorkflows([]);
    if (!projectFilePath || !comfyUiConfig.enabled || comfyUiStatus.state === 'error') return;
    void listComfyUiWorkflows(projectFilePath).then((response) => {
      if (canceled) return;
      setWorkflows(response.workflows);
      const warningCount = response.diagnostics.filter((diagnostic) => diagnostic.severity !== 'info').length;
      setWorkflowMessage(warningCount > 0 ? `${warningCount} workflow diagnostic${warningCount === 1 ? '' : 's'} found. Invalid workflows are hidden from the selectors.` : null);
      const generateDefault = comfyUiConfig.defaultWorkflows['image.generate'] ?? comfyUiConfig.defaultWorkflowId;
      const editDefault = comfyUiConfig.defaultWorkflows['image.edit'];
      const generateChoice = response.workflows.find((workflow) => workflow.role === 'image.generate' && workflow.id === generateDefault) ?? response.workflows.find((workflow) => workflow.role === 'image.generate') ?? null;
      const editChoice = response.workflows.find((workflow) => workflow.role === 'image.edit' && workflow.id === editDefault) ?? response.workflows.find((workflow) => workflow.role === 'image.edit') ?? null;
      setGenerateWorkflowId(generateChoice?.id ?? '');
      setEditWorkflowId(editChoice?.id ?? '');
      if (generateChoice?.defaults.width !== undefined) setGenerateWidth(String(generateChoice.defaults.width));
      if (generateChoice?.defaults.height !== undefined) setGenerateHeight(String(generateChoice.defaults.height));
      if (generateChoice?.defaults.steps !== undefined) setGenerateSteps(String(generateChoice.defaults.steps));
      if (editChoice?.defaults.steps !== undefined) setEditSteps(String(editChoice.defaults.steps));
    }).catch((error) => {
      if (!canceled) setWorkflowMessage(error instanceof Error ? error.message : 'Failed to load ComfyUI workflows.');
    });
    return () => { canceled = true; };
  }, [comfyUiConfig.defaultWorkflowId, comfyUiConfig.defaultWorkflows, comfyUiConfig.enabled, comfyUiStatus.state, projectFilePath]);

  useEffect(() => {
    let canceled = false;
    setSourcePreviewUrl(null);
    if (!projectFilePath || !sourceAsset?.path || sourceAsset.kind !== 'image') return;
    void window.noveltea.resolveProjectAssetUrl(projectFilePath, sourceAsset.path).then((response) => {
      if (!canceled) setSourcePreviewUrl(response?.url ?? null);
    });
    return () => { canceled = true; };
  }, [projectFilePath, sourceAsset?.kind, sourceAsset?.path]);

  function generate() {
    if (!projectFilePath) { setMessage('Save the project before generating images.'); return; }
    if (!selectedGenerateWorkflow) { setMessage('No valid image.generate workflow is available.'); return; }
    if (!prompt.trim()) { setMessage('Enter a prompt before generating.'); return; }
    if (generateValidationIssue) { setMessage(generateValidationIssue); return; }
    enqueueJob({
      kind: 'generate',
      tabId: tab.id,
      config: comfyUiConfig,
      workflowLabel: selectedGenerateWorkflow.label,
      role: selectedGenerateWorkflow.role,
      promptSummary: promptTitle(prompt),
      request: {
        projectFilePath,
        workflowId: selectedGenerateWorkflow.id,
        prompt: prompt.trim(),
        width: numberOrUndefined(generateWidth),
        height: numberOrUndefined(generateHeight),
        steps: numberOrUndefined(generateSteps),
        seed: numberOrUndefined(generateSeed),
      },
    });
    triggerQueuedFeedback('generate');
    setMessage('Added to ComfyUI queue.');
  }

  function editSelected() {
    if (!projectFilePath) { setMessage('Save the project before editing images.'); return; }
    if (!selectedEditWorkflow) { setMessage('No valid image.edit workflow is available.'); return; }
    if (!editPrompt.trim()) { setMessage('Enter an edit prompt first.'); return; }
    if (editValidationIssue) { setMessage(editValidationIssue); return; }
    const sourceProjectRelativePath = selectedRevision?.projectRelativePath ?? sourceAsset?.path;
    const sourceAssetId = selectedRevision?.assetId ?? sourceAsset?.id;
    if (!sourceProjectRelativePath) { setMessage('Generate or select an image before editing.'); return; }
    enqueueJob({
      kind: 'edit',
      tabId: tab.id,
      config: comfyUiConfig,
      workflowLabel: selectedEditWorkflow.label,
      role: selectedEditWorkflow.role,
      promptSummary: promptTitle(editPrompt),
      request: {
        projectFilePath,
        workflowId: selectedEditWorkflow.id,
        sourceAssetId,
        sourceProjectRelativePath,
        prompt: editPrompt.trim(),
        steps: numberOrUndefined(editSteps),
        seed: numberOrUndefined(editSeed),
      },
    });
    triggerQueuedFeedback('edit');
    setMessage('Added edit to ComfyUI queue.');
  }

  async function cancelJob() {
    if (!activeJob) return;
    if (activeJob.state === 'queued') {
      removeQueueJob(activeJob.promptId);
      setMessage('Removed queued ComfyUI job.');
      return;
    }
    markInterrupted(activeJob.promptId);
    const result = await cancelComfyUiJob(comfyUiConfig);
    setMessage(result.success ? 'Canceled active ComfyUI job.' : result.error ?? 'Interrupt failed.');
  }

  function addRevisionAsset(revision: GeneratedImageRevision) {
    if (revision.assetAddedAt) return;
    const result = executeCommand({
      type: 'asset.importFiles',
      label: 'Add generated image to assets',
      payload: { assets: [revision.asset] },
    });
    const failure = result.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    if (failure) {
      setMessage(failure.message);
      return;
    }
    markRevisionAssetAdded(tab.id, revision.id, assetIdForRevision(revision));
    setMessage('Added revision to assets.');
  }

  async function removeRevision(revision: GeneratedImageRevision) {
    if (!revision.assetAddedAt && projectFilePath) {
      const result = await window.noveltea.trashProjectAssetFiles(projectFilePath, [revision.projectRelativePath]);
      if (!result.success) {
        setMessage(result.error ?? result.diagnostics[0]?.message ?? 'Failed to delete generated revision file.');
        return;
      }
    }
    deleteRevision(tab.id, revision.id);
    setMessage(revision.assetAddedAt ? 'Removed revision from the list. Asset file was left intact.' : 'Deleted generated revision.');
  }

  const progressPercent = activeJob?.progressValue !== null && activeJob?.progressValue !== undefined && activeJob?.progressMax ? Math.round((activeJob.progressValue / activeJob.progressMax) * 100) : null;
  const progressLabel = progressPercent !== null && activeJob?.progressValue !== null && activeJob?.progressValue !== undefined && activeJob?.progressMax
    ? `Progress ${activeJob.progressValue}/${activeJob.progressMax}`
    : activeJob?.state === 'queued'
      ? 'Queued'
      : activeJob
        ? displayJobState(activeJob.state)
        : 'Idle';
  const mainPreviewUrl = selectedRevision?.previewUrl ?? sourcePreviewUrl;
  const mainPreviewAlt = selectedRevision ? promptTitle(selectedRevision.prompt) : sourceAsset ? `Source image: ${sourceAsset.label}` : 'Generated image preview';
  const comfyUiUnavailableMessage = !comfyUiConfig.enabled
    ? 'Image generation requires ComfyUI.'
    : comfyUiStatus.state === 'error'
      ? 'Image generation requires ComfyUI, but the current configuration is not working.'
      : null;

  function openComfyUiSettings() {
    openWorkbenchTab(buildProjectSettingsTab());
    for (const delay of [0, 50, 150]) {
      window.setTimeout(() => window.dispatchEvent(new CustomEvent('noveltea:project-settings-scroll', { detail: { section: 'comfyui' } })), delay);
    }
  }

  if (comfyUiUnavailableMessage) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <header className="shrink-0 border-b bg-background px-4 py-2">
          <div className="flex h-8 items-center">
            <h2 className="text-lg font-semibold">Generate Image</h2>
          </div>
        </header>
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="max-w-sm rounded-lg border bg-muted/20 p-5 text-center shadow-sm">
            <h3 className="text-base font-semibold">{comfyUiUnavailableMessage}</h3>
            {comfyUiStatus.message && comfyUiStatus.state === 'error' ? <p className="mt-2 text-xs text-muted-foreground">{comfyUiStatus.message}</p> : null}
            <Button className="mt-4" variant="secondary" onClick={openComfyUiSettings}>Open ComfyUI Settings</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="shrink-0 border-b bg-background px-4 py-2">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold">Generate Image</h2>
            {sourceAsset ? <p className="mt-0.5 truncate text-xs text-muted-foreground">Source image: <span className="font-mono">{sourceAsset.label}</span> ({sourceAsset.path})</p> : null}
          </div>
          <div className="h-8 w-full max-w-md shrink-0">
            {activeJob ? (
              <div className="flex h-full items-center gap-2">
                <FieldLabel htmlFor={`comfyui-progress-${tab.id}`} className="w-20 shrink-0 truncate text-[11px]/none">
                  {progressLabel}
                </FieldLabel>
                <Progress id={`comfyui-progress-${tab.id}`} value={progressPercent ?? 0} />
                {canCancelJob(activeJob.state) ? (
                  <Button size="icon-sm" variant="destructive" className="size-6 rounded-md bg-destructive/25 text-destructive hover:bg-destructive/40 dark:bg-destructive/35 dark:text-destructive-foreground dark:hover:bg-destructive/50" onClick={() => void cancelJob()} aria-label="Cancel ComfyUI job" title="Cancel ComfyUI job">
                    <X className="size-4" />
                  </Button>
                ) : <div className="size-6 shrink-0" aria-hidden="true" />}
              </div>
            ) : <div className="h-8" aria-hidden="true" />}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {workflowMessage ? <div className="mb-4 rounded border p-2 text-xs text-muted-foreground">{workflowMessage}</div> : null}
        <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="min-h-0 rounded border bg-muted/20 p-3">
          <div className="group relative flex min-h-[420px] items-center justify-center overflow-hidden rounded border bg-background">
            {mainPreviewUrl ? <img src={mainPreviewUrl} alt={mainPreviewAlt} className="max-h-[70vh] max-w-full object-contain" /> : <div className="text-sm text-muted-foreground">{sourceAsset ? 'Loading source image…' : 'Generated image revisions will appear here.'}</div>}
            {selectedRevision ? (
              <div className="pointer-events-auto absolute right-3 top-3 z-10 flex gap-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 hover:opacity-100">
                <Button size="sm" variant="secondary" className="bg-popover/95 text-popover-foreground shadow-sm ring-1 ring-border hover:bg-popover disabled:bg-popover/95" onClick={() => addRevisionAsset(selectedRevision)} disabled={!!selectedRevision.assetAddedAt}>{selectedRevision.assetAddedAt ? 'Added' : 'Add Asset'}</Button>
                <Button size="sm" variant="destructive" className="shadow-sm ring-1 ring-destructive/30" onClick={() => void removeRevision(selectedRevision)}>Delete</Button>
              </div>
            ) : null}
          </div>
          <div className="mt-3 space-y-2">
            <Label htmlFor="edit-prompt">Edit selected image</Label>
            <textarea id="edit-prompt" className="min-h-20 w-full rounded-md border bg-background p-2 text-sm" value={editPrompt} onChange={(event) => setEditPrompt(event.currentTarget.value)} placeholder="Describe how to edit the selected image" />
            <div className="space-y-1">
              <Label htmlFor="edit-workflow">Edit workflow</Label>
              <select id="edit-workflow" className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs" value={selectedEditWorkflow?.id ?? ''} onChange={(event) => setEditWorkflowId(event.currentTarget.value)}>
                {editWorkflows.length === 0 ? <option value="">No valid edit workflows</option> : null}
                {editWorkflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.label}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1"><Label htmlFor="edit-steps">Edit steps</Label><Input id="edit-steps" type="text" inputMode="numeric" pattern="[0-9]*" value={editSteps} onChange={(event) => setEditSteps(numericInputValue(event.currentTarget.value))} aria-invalid={positiveIntegerIssue('Edit steps', editSteps) ? true : undefined} /></div>
              <div className="space-y-1"><Label htmlFor="edit-seed">Edit seed</Label><Input id="edit-seed" type="text" inputMode="numeric" pattern="[0-9]*" value={editSeed} onChange={(event) => setEditSeed(numericInputValue(event.currentTarget.value))} placeholder="random" aria-invalid={optionalIntegerIssue('Edit seed', editSeed) ? true : undefined} /></div>
            </div>
            {editValidationIssue ? <p className="text-xs text-destructive">{editValidationIssue}</p> : null}
            <div className="flex gap-2"><Button onClick={() => void editSelected()} disabled={!canQueueEdit}>{editQueuedFeedback ? 'Added to queue!' : 'Edit Selected Image'}</Button></div>
          </div>
        </section>

        <aside className="space-y-4">
          <section className="rounded border p-3">
            <h3 className="text-sm font-medium">Text to Image</h3>
            <div className="mt-3 space-y-3">
              <div className="space-y-1"><Label htmlFor="prompt">Prompt</Label><textarea id="prompt" className="min-h-28 w-full rounded-md border bg-background p-2 text-sm" value={prompt} onChange={(event) => setPrompt(event.currentTarget.value)} placeholder="Describe the image to generate" /></div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1"><Label htmlFor="generate-width">Width</Label><Input id="generate-width" type="text" inputMode="numeric" pattern="[0-9]*" value={generateWidth} onChange={(event) => setGenerateWidth(numericInputValue(event.currentTarget.value))} aria-invalid={positiveIntegerIssue('Width', generateWidth) ? true : undefined} /></div>
                <div className="space-y-1"><Label htmlFor="generate-height">Height</Label><Input id="generate-height" type="text" inputMode="numeric" pattern="[0-9]*" value={generateHeight} onChange={(event) => setGenerateHeight(numericInputValue(event.currentTarget.value))} aria-invalid={positiveIntegerIssue('Height', generateHeight) ? true : undefined} /></div>
                <div className="space-y-1"><Label htmlFor="generate-steps">Generate steps</Label><Input id="generate-steps" type="text" inputMode="numeric" pattern="[0-9]*" value={generateSteps} onChange={(event) => setGenerateSteps(numericInputValue(event.currentTarget.value))} aria-invalid={positiveIntegerIssue('Generate steps', generateSteps) ? true : undefined} /></div>
                <div className="space-y-1"><Label htmlFor="generate-seed">Generate seed</Label><Input id="generate-seed" type="text" inputMode="numeric" pattern="[0-9]*" value={generateSeed} onChange={(event) => setGenerateSeed(numericInputValue(event.currentTarget.value))} placeholder="random" aria-invalid={optionalIntegerIssue('Generate seed', generateSeed) ? true : undefined} /></div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="generate-workflow">Generate workflow</Label>
                <select id="generate-workflow" className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs" value={selectedGenerateWorkflow?.id ?? ''} onChange={(event) => setGenerateWorkflowId(event.currentTarget.value)}>
                  {generateWorkflows.length === 0 ? <option value="">No valid generate workflows</option> : null}
                  {generateWorkflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.label}</option>)}
                </select>
              </div>
              {generateValidationIssue ? <p className="text-xs text-destructive">{generateValidationIssue}</p> : null}
              <Button className="w-full" onClick={() => void generate()} disabled={!canQueueGenerate}>{generateQueuedFeedback ? 'Added to queue!' : 'Generate'}</Button>
            </div>
          </section>

          <section className="rounded border p-3">
            <h3 className="text-sm font-medium">Revisions</h3>
            {revisions.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">No revisions generated in this tab yet.</p> : null}
            <div className="mt-2 max-h-[420px] space-y-2 overflow-auto">
              {revisions.slice().reverse().map((revision) => (
                <div key={revision.id} className={`group relative flex w-full gap-2 rounded border p-2 text-left hover:bg-accent ${selectedRevision?.id === revision.id ? 'bg-accent' : ''}`}>
                  <button type="button" className="flex min-w-0 flex-1 gap-2 text-left" onClick={() => selectRevision(tab.id, revision.id)}>
                    <div className="relative h-14 w-14 shrink-0">
                      <img src={revision.previewUrl} alt="" className="h-14 w-14 rounded object-cover" />
                      {revision.assetAddedAt ? <span className="absolute right-1 top-1 rounded bg-background/90 px-1 text-[10px]">✓</span> : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">{promptTitle(revision.prompt)}</div>
                      <div className="mt-1 font-mono text-[10px] text-muted-foreground">{revision.mode} · {revision.projectRelativePath}</div>
                    </div>
                  </button>
                  <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 hover:opacity-100">
                    <Button size="icon-sm" variant="secondary" className="size-6 bg-popover/95 text-popover-foreground shadow-sm ring-1 ring-border hover:bg-popover disabled:bg-popover/95" onClick={() => addRevisionAsset(revision)} disabled={!!revision.assetAddedAt} aria-label={revision.assetAddedAt ? 'Revision already added to assets' : 'Add revision to assets'} title={revision.assetAddedAt ? 'Added to assets' : 'Add to assets'}>
                      <Plus className="size-3" />
                    </Button>
                    <Button size="icon-sm" variant="destructive" className="size-6 bg-destructive/25 text-destructive shadow-sm ring-1 ring-destructive/50 hover:bg-destructive/40 dark:bg-destructive/35 dark:text-destructive-foreground dark:hover:bg-destructive/50" onClick={() => void removeRevision(revision)} aria-label="Delete revision" title="Delete revision">
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </aside>
        </div>
      </div>
    </div>
  );
}
