import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { analyzeComfyUiWorkflowImport, importComfyUiWorkflowToLibrary, repairComfyUiWorkflowInLibrary } from '@/comfyui/comfyui-service';
import { useComfyUiStore } from '@/comfyui/comfyui-store';
import type { ComfyUiBindingCandidate } from '../../../shared/comfyui-workflow-inference';
import {
  COMFYUI_WORKFLOW_ROLE_CATALOG,
  SUPPORTED_COMFYUI_WORKFLOW_ROLES,
  type ComfyUiAnalyzeWorkflowImportResponse,
  type ComfyUiSemanticInput,
  type ComfyUiWorkflowContract,
  type ComfyUiWorkflowDefinition,
  type ComfyUiWorkflowRoleInputDefinition,
  type ComfyUiWorkflowDiagnostic,
  type ComfyUiWorkflowLibraryEntry,
  type ComfyUiWorkflowRole,
  type ComfyUiWorkflowValueType,
} from '../../../shared/comfyui-workflows';

interface ComfyUiWorkflowImportDialogProps {
  open: boolean;
  projectFilePath: string | null;
  repairEntry?: ComfyUiWorkflowLibraryEntry | null;
  onOpenChange: (open: boolean) => void;
  onImported: (message: string, diagnostics: ComfyUiWorkflowDiagnostic[]) => void | Promise<void>;
}

type Step = 0 | 1 | 2 | 3 | 4 | 5 | 6;
type InputSelections = Partial<Record<ComfyUiSemanticInput, string>>;
type DefaultsDraft = Partial<Record<ComfyUiSemanticInput, string>>;

const unmappedValue = '__unmapped__';

const stepLabelKeys = [
  'sourceFile',
  'role',
  'summary',
  'inputs',
  'outputs',
  'defaults',
  'review',
] as const;

function slugify(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/\.workflow$/u, '')
    .replace(/\.manifest$/u, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return slug || 'imported-workflow';
}

function labelFromFileName(name: string) {
  const base = name.replace(/\.json$/iu, '').replace(/\.workflow$/iu, '');
  const words = base.split(/[^a-z0-9]+/iu).filter(Boolean);
  if (!words.length) return 'Imported Workflow';
  return words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(' ');
}

function candidateKey(candidate: ComfyUiBindingCandidate) {
  return `${candidate.nodeId}:${candidate.inputName}:${candidate.semanticKey}`;
}

function inputEntries(role: ComfyUiWorkflowRole): Array<[ComfyUiSemanticInput, ComfyUiWorkflowRoleInputDefinition]> {
  const inputs = COMFYUI_WORKFLOW_ROLE_CATALOG[role].contract.inputs;
  return (Object.entries(inputs) as Array<[ComfyUiSemanticInput, ComfyUiWorkflowRoleInputDefinition]>)
    .sort((left, right) => Number(right[1].required) - Number(left[1].required) || left[0].localeCompare(right[0]));
}

function manifestContractForRole(role: ComfyUiWorkflowRole): ComfyUiWorkflowContract {
  const roleContract = COMFYUI_WORKFLOW_ROLE_CATALOG[role].contract;
  const inputs: ComfyUiWorkflowContract['inputs'] = {};
  for (const [semanticKey, input] of Object.entries(roleContract.inputs) as Array<[ComfyUiSemanticInput, ComfyUiWorkflowRoleInputDefinition]>) {
    inputs[semanticKey] = {
      type: input.type,
      required: input.required,
      ...(input.editorField ? { editorField: input.editorField } : {}),
      ...(input.defaultValue !== undefined ? { defaultValue: input.defaultValue } : {}),
    };
  }
  return {
    inputs,
    outputs: {
      images: {
        type: roleContract.outputs.images.type,
        required: roleContract.outputs.images.required,
        primary: roleContract.outputs.images.primary,
      },
    },
  };
}

function roleCandidates(response: ComfyUiAnalyzeWorkflowImportResponse | null, role: ComfyUiWorkflowRole) {
  return response?.roleCandidates[role]?.candidates ?? {};
}

function candidateLabel(candidate: ComfyUiBindingCandidate) {
  const title = candidate.nodeTitle ? `${candidate.nodeTitle} ` : '';
  return `${title}#${candidate.nodeId} ${candidate.classType}.${candidate.inputName}`;
}

function readableValue(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function defaultForCandidate(candidate: ComfyUiBindingCandidate | undefined, fallback: string | number | undefined, semanticKey: ComfyUiSemanticInput) {
  const current = readableValue(candidate?.currentValue);
  if (current !== null) return current;
  if (fallback !== undefined) return String(fallback);
  if (semanticKey === 'filenamePrefix') return 'NovelTea';
  return '';
}

function confidenceVariant(confidence: ComfyUiBindingCandidate['confidence']) {
  if (confidence === 'high') return 'default';
  if (confidence === 'medium') return 'secondary';
  return 'outline';
}

function diagnosticVariant(severity: ComfyUiWorkflowDiagnostic['severity']) {
  if (severity === 'error') return 'destructive';
  if (severity === 'warning') return 'secondary';
  return 'outline';
}

function findCandidate(candidates: ComfyUiBindingCandidate[], key: string | undefined) {
  return candidates.find((candidate) => candidateKey(candidate) === key);
}

function keyForBinding(candidates: ComfyUiBindingCandidate[], binding: ComfyUiWorkflowDefinition['bindings'][ComfyUiSemanticInput]) {
  if (!binding) return undefined;
  const title = binding.selector?.title ?? binding.nodeTitle;
  const classType = binding.selector?.classType ?? binding.classType;
  const inputName = binding.selector?.inputName ?? binding.inputName;
  const match = candidates.find((candidate) => (
    (binding.nodeId ? candidate.nodeId === binding.nodeId : true)
    && candidate.inputName === inputName
    && (!classType || candidate.classType === classType)
  )) ?? candidates.find((candidate) => (
    candidate.inputName === inputName
    && (!title || candidate.nodeTitle === title)
    && (!classType || candidate.classType === classType)
  ));
  return match ? candidateKey(match) : undefined;
}

function keyForOutputBinding(candidates: ComfyUiBindingCandidate[], binding: NonNullable<ComfyUiWorkflowDefinition['outputBindings']['images']>[number]) {
  const match = candidates.find((candidate) => binding.nodeId && candidate.nodeId === binding.nodeId)
    ?? candidates.find((candidate) => (
      (!binding.nodeTitle || candidate.nodeTitle === binding.nodeTitle)
      && (!binding.classType || candidate.classType === binding.classType)
    ));
  return match ? candidateKey(match) : undefined;
}

function selectedInputCandidates(response: ComfyUiAnalyzeWorkflowImportResponse | null, role: ComfyUiWorkflowRole, selections: InputSelections) {
  const candidates = roleCandidates(response, role);
  const selected: Partial<Record<ComfyUiSemanticInput, ComfyUiBindingCandidate>> = {};
  for (const [semanticKey, key] of Object.entries(selections) as Array<[ComfyUiSemanticInput, string]>) {
    const candidate = findCandidate(candidates[semanticKey] ?? [], key);
    if (candidate) selected[semanticKey] = candidate;
  }
  return selected;
}

function buildInitialInputSelections(response: ComfyUiAnalyzeWorkflowImportResponse | null, role: ComfyUiWorkflowRole): InputSelections {
  const candidates = roleCandidates(response, role);
  const selections: InputSelections = {};
  for (const [semanticKey] of inputEntries(role)) {
    const candidate = (candidates[semanticKey] ?? []).find((item) => item.confidence === 'high');
    if (candidate) selections[semanticKey] = candidateKey(candidate);
  }
  return selections;
}

function buildRepairInputSelections(response: ComfyUiAnalyzeWorkflowImportResponse | null, definition: ComfyUiWorkflowDefinition): InputSelections {
  const candidates = roleCandidates(response, definition.role);
  const selections: InputSelections = {};
  for (const [semanticKey] of inputEntries(definition.role)) {
    const key = keyForBinding(candidates[semanticKey] ?? [], definition.bindings[semanticKey]);
    if (key) selections[semanticKey] = key;
  }
  return selections;
}

function buildInitialOutputs(response: ComfyUiAnalyzeWorkflowImportResponse | null, role: ComfyUiWorkflowRole) {
  const candidates = roleCandidates(response, role).images ?? [];
  const preferred = candidates.find((candidate) => candidate.classType === 'SaveImage') ?? candidates[0];
  return preferred ? [candidateKey(preferred)] : [];
}

function buildRepairOutputs(response: ComfyUiAnalyzeWorkflowImportResponse | null, definition: ComfyUiWorkflowDefinition) {
  const candidates = roleCandidates(response, definition.role).images ?? [];
  const bindings = definition.outputBindings.images ?? [];
  const keys = bindings.map((binding) => keyForOutputBinding(candidates, binding)).filter((key): key is string => Boolean(key));
  if (keys.length) return keys;
  return definition.outputNodeIds
    .map((nodeId) => candidates.find((candidate) => candidate.nodeId === nodeId))
    .filter((candidate): candidate is ComfyUiBindingCandidate => Boolean(candidate))
    .map(candidateKey);
}

function selectorFor(candidate: ComfyUiBindingCandidate) {
  return {
    ...(candidate.nodeTitle ? { title: candidate.nodeTitle } : {}),
    classType: candidate.classType,
    inputName: candidate.inputName,
  };
}

function buildManifest(options: {
  role: ComfyUiWorkflowRole;
  workflowId: string;
  label: string;
  description: string;
  workflowFileName: string;
  response: ComfyUiAnalyzeWorkflowImportResponse;
  inputSelections: InputSelections;
  outputSelections: string[];
  defaultsDraft: DefaultsDraft;
}): ComfyUiWorkflowDefinition {
  const roleDefinition = COMFYUI_WORKFLOW_ROLE_CATALOG[options.role];
  const candidates = roleCandidates(options.response, options.role);
  const selectedInputs = selectedInputCandidates(options.response, options.role, options.inputSelections);
  const selectedOutputs = options.outputSelections
    .map((key) => findCandidate(candidates.images ?? [], key))
    .filter((candidate): candidate is ComfyUiBindingCandidate => Boolean(candidate));

  const bindings: ComfyUiWorkflowDefinition['bindings'] = {};
  for (const [semanticKey, candidate] of Object.entries(selectedInputs) as Array<[ComfyUiSemanticInput, ComfyUiBindingCandidate]>) {
    if (candidate.valueType === 'image-list') continue;
    bindings[semanticKey] = {
      nodeId: candidate.nodeId,
      ...(candidate.nodeTitle ? { nodeTitle: candidate.nodeTitle } : {}),
      classType: candidate.classType,
      inputName: candidate.inputName,
      valueType: candidate.valueType as ComfyUiWorkflowValueType,
      selector: selectorFor(candidate),
    };
  }

  const outputBindings = selectedOutputs.map((candidate) => ({
    nodeId: candidate.nodeId,
    ...(candidate.nodeTitle ? { nodeTitle: candidate.nodeTitle } : {}),
    classType: candidate.classType,
    outputName: 'images',
    valueType: 'image-list' as const,
    primary: 'first' as const,
  }));

  const defaults: ComfyUiWorkflowDefinition['defaults'] = { filenamePrefix: options.defaultsDraft.filenamePrefix || 'NovelTea' };
  for (const [semanticKey, value] of Object.entries(options.defaultsDraft) as Array<[ComfyUiSemanticInput, string]>) {
    if (semanticKey === 'filenamePrefix' || value.trim() === '') continue;
    const input = roleDefinition.contract.inputs[semanticKey];
    if (!input) continue;
    defaults[semanticKey] = input.type === 'string' ? value : Number(value);
  }

  return {
    schemaVersion: 2,
    id: options.workflowId,
    label: options.label,
    provider: 'comfyui',
    role: options.role,
    ...(options.description.trim() ? { description: options.description.trim() } : {}),
    workflowFile: options.workflowFileName,
    contract: manifestContractForRole(options.role),
    requiredNodeClasses: [...(options.response.analysis?.classTypes ?? [])].sort(),
    outputNodeIds: selectedOutputs.map((candidate) => candidate.nodeId),
    bindings,
    outputBindings: { images: outputBindings },
    defaults,
  };
}

function DiagnosticRows({ diagnostics, emptyMessage }: { diagnostics: ComfyUiWorkflowDiagnostic[]; emptyMessage: string }) {
  if (!diagnostics.length) return <div className="text-xs text-muted-foreground">{emptyMessage}</div>;
  return (
    <div className="space-y-1">
      {diagnostics.map((diagnostic, index) => (
        <div key={`${diagnostic.path}-${diagnostic.message}-${index}`} className="rounded border p-1.5 text-xs">
          <Badge variant={diagnosticVariant(diagnostic.severity)}>{diagnostic.severity}</Badge>
          <span className="ml-2 font-mono text-[10px] text-muted-foreground">{diagnostic.path}</span>
          <div className="mt-1">{diagnostic.message}</div>
        </div>
      ))}
    </div>
  );
}

export function ComfyUiWorkflowImportDialog({ open, projectFilePath, repairEntry, onOpenChange, onImported }: ComfyUiWorkflowImportDialogProps) {
  const { t } = useTranslation('workspace');
  const config = useComfyUiStore((state) => state.config);
  const mode = repairEntry ? 'repair' : 'import';
  const [step, setStep] = useState<Step>(0);
  const [fileName, setFileName] = useState('');
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [workflowJsonText, setWorkflowJsonText] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [analysisResponse, setAnalysisResponse] = useState<ComfyUiAnalyzeWorkflowImportResponse | null>(null);
  const [role, setRole] = useState<ComfyUiWorkflowRole>('image.generate');
  const [workflowId, setWorkflowId] = useState('imported-workflow');
  const [label, setLabel] = useState('Imported Workflow');
  const [description, setDescription] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [inputSelections, setInputSelections] = useState<InputSelections>({});
  const [outputSelections, setOutputSelections] = useState<string[]>([]);
  const [defaultsDraft, setDefaultsDraft] = useState<DefaultsDraft>({ filenamePrefix: 'NovelTea' });
  const [saveDiagnostics, setSaveDiagnostics] = useState<ComfyUiWorkflowDiagnostic[]>([]);
  const [error, setError] = useState<string | null>(null);

  const candidates = roleCandidates(analysisResponse, role);
  const workflowFileName = `${slugify(workflowId)}.workflow.json`;
  const manifestFileName = `${slugify(workflowId)}.manifest.json`;
  const selectedInputs = useMemo(() => selectedInputCandidates(analysisResponse, role, inputSelections), [analysisResponse, inputSelections, role]);
  const manifest = useMemo(() => {
    if (!analysisResponse?.ok || !analysisResponse.analysis) return null;
    return buildManifest({ role, workflowId: slugify(workflowId), label, description, workflowFileName, response: analysisResponse, inputSelections, outputSelections, defaultsDraft });
  }, [analysisResponse, defaultsDraft, description, inputSelections, label, outputSelections, role, workflowFileName, workflowId]);
  const requiredInputsMissing = inputEntries(role).some(([semanticKey, input]) => input.required && !selectedInputs[semanticKey]);
  const outputCardinality = COMFYUI_WORKFLOW_ROLE_CATALOG[role].contract.outputs.images;
  const requiredOutputsMissing = outputSelections.length < outputCardinality.minBindings;
  const tooManyOutputsSelected = outputSelections.length > outputCardinality.maxBindings;
  const canContinue = analysisResponse?.ok && !analyzing;

  useEffect(() => {
    if (!open) {
      setStep(0);
      setFileName('');
      setFileSize(null);
      setWorkflowJsonText('');
      setAnalyzing(false);
      setSaving(false);
      setAnalysisResponse(null);
      setRole('image.generate');
      setWorkflowId('imported-workflow');
      setLabel('Imported Workflow');
      setDescription('');
      setOverwrite(false);
      setInputSelections({});
      setOutputSelections([]);
      setDefaultsDraft({ filenamePrefix: 'NovelTea' });
      setSaveDiagnostics([]);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !repairEntry?.definition || !repairEntry.workflowJsonText) return;
    const definition = repairEntry.definition;
    setStep(1);
    setFileName(definition.workflowFile);
    setWorkflowJsonText(repairEntry.workflowJsonText);
    setRole(definition.role);
    setWorkflowId(definition.id);
    setLabel(definition.label);
    setDescription(definition.description ?? '');
    setOverwrite(true);
    setDefaultsDraft(Object.fromEntries(Object.entries(definition.defaults).map(([key, value]) => [key, String(value)])) as DefaultsDraft);
    setSaveDiagnostics([]);
    setError(null);
    setAnalyzing(true);
    void analyzeComfyUiWorkflowImport({ projectFilePath, workflowJsonText: repairEntry.workflowJsonText, config }).then((response) => {
      setAnalysisResponse(response);
      setError(response.ok ? null : response.error ?? t('comfyuiImport.errors.repairAnalysisFailed'));
      setInputSelections(buildRepairInputSelections(response, definition));
      setOutputSelections(buildRepairOutputs(response, definition));
    }).catch((caught) => {
      const message = caught instanceof Error ? caught.message : t('comfyuiImport.errors.analyzeRepairFailed');
      setAnalysisResponse({ ok: false, roleCandidates: {}, diagnostics: [{ severity: 'error', category: 'comfyui-workflows', path: '/workflow', message }], error: message });
      setError(message);
    }).finally(() => setAnalyzing(false));
  }, [config, open, projectFilePath, repairEntry, t]);

  useEffect(() => {
    if (mode === 'repair') return;
    setInputSelections(buildInitialInputSelections(analysisResponse, role));
    setOutputSelections(buildInitialOutputs(analysisResponse, role));
  }, [analysisResponse, mode, role]);

  useEffect(() => {
    const nextDefaults: DefaultsDraft = { filenamePrefix: 'NovelTea' };
    for (const [semanticKey, input] of inputEntries(role)) {
      if (input.required || !selectedInputs[semanticKey]) continue;
      nextDefaults[semanticKey] = defaultForCandidate(selectedInputs[semanticKey], input.defaultValue, semanticKey);
    }
    setDefaultsDraft(nextDefaults);
  }, [role, selectedInputs]);

  async function readWorkflowFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setSaveDiagnostics([]);
    setFileName(file.name);
    setFileSize(file.size);
    const nextLabel = labelFromFileName(file.name);
    setLabel(nextLabel);
    setWorkflowId(slugify(nextLabel));
    setAnalyzing(true);
    try {
      const text = await file.text();
      setWorkflowJsonText(text);
      const response = await analyzeComfyUiWorkflowImport({ projectFilePath, workflowJsonText: text, config });
      setAnalysisResponse(response);
      setError(response.ok ? null : response.error ?? t('comfyuiImport.errors.importAnalysisFailed'));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : t('comfyuiImport.errors.readFailed');
      setAnalysisResponse({ ok: false, roleCandidates: {}, diagnostics: [{ severity: 'error', category: 'comfyui-workflows', path: '/workflow', message }], error: message });
      setError(message);
    } finally {
      setAnalyzing(false);
    }
  }

  function nextStep() {
    if (step === 3 && requiredInputsMissing) return;
    if (step === 4 && (requiredOutputsMissing || tooManyOutputsSelected)) return;
    setStep((current) => Math.min(6, current + 1) as Step);
  }

  async function saveImport() {
    if (!manifest || requiredInputsMissing || requiredOutputsMissing || tooManyOutputsSelected) return;
    if (mode === 'repair' && repairEntry?.source === 'project' && !projectFilePath) {
      setError(t('comfyuiImport.errors.saveProjectBeforeImport'));
      return;
    }
    setSaving(true);
    setError(null);
    setSaveDiagnostics([]);
    const response = mode === 'repair' && repairEntry
      ? await repairComfyUiWorkflowInLibrary({
        workflowKey: repairEntry.workflowKey,
        projectFilePath,
        manifest: { ...manifest, workflowFile: repairEntry.definition?.workflowFile ?? manifest.workflowFile },
        overwrite: true,
      })
      : await importComfyUiWorkflowToLibrary({
        workflowFileName,
        manifestFileName,
        workflowJsonText,
        manifest,
        overwrite,
        config,
      });
    setSaveDiagnostics(response.diagnostics);
    setSaving(false);
    if (!response.success) {
      setError(response.error ?? t('comfyuiImport.errors.saveFailed'));
      return;
    }
    await onImported(mode === 'repair'
      ? t('comfyuiImport.messages.repaired', { manifestFile: response.manifestFile ?? manifestFileName })
      : t('comfyuiImport.messages.imported', { workflowFile: response.workflowFile ?? workflowFileName }), response.diagnostics);
    onOpenChange(false);
  }

  function renderStep() {
    if (step === 0 && mode === 'import') {
      return (
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="comfyui-workflow-json">{t('comfyuiImport.sourceFile.apiWorkflowJson')}</Label>
            <input
              id="comfyui-workflow-json"
              type="file"
              accept=".json,application/json"
              className="h-7 w-full min-w-0 rounded-md border border-input bg-input/20 px-2 py-0.5 text-xs"
              onChange={(event) => void readWorkflowFile(event.currentTarget.files?.[0])}
            />
          </div>
          {fileName ? <div className="rounded border p-2 text-xs">{fileName} {fileSize !== null ? <span className="text-muted-foreground">{t('comfyuiImport.sourceFile.fileSize', { bytes: fileSize.toLocaleString() })}</span> : null}</div> : null}
          {analyzing ? <div className="text-xs text-muted-foreground">{t('comfyuiImport.sourceFile.analyzing')}</div> : null}
          {analysisResponse ? <DiagnosticRows diagnostics={analysisResponse.diagnostics} emptyMessage={t('comfyuiImport.diagnostics.empty')} /> : null}
        </div>
      );
    }
    if (step === 1) {
      const selectedRole = COMFYUI_WORKFLOW_ROLE_CATALOG[role];
      return (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1 md:col-span-2">
            <Label>{t('comfyuiImport.metadata.role')}</Label>
            <Select value={role} onValueChange={(value) => setRole(value as ComfyUiWorkflowRole)}>
              <SelectTrigger className="w-full"><SelectValue>{selectedRole.label}</SelectValue></SelectTrigger>
              <SelectContent align="start">
                {SUPPORTED_COMFYUI_WORKFLOW_ROLES.map((nextRole) => (
                  <SelectItem key={nextRole} value={nextRole}>{COMFYUI_WORKFLOW_ROLE_CATALOG[nextRole].label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{selectedRole.description}</p>
          </div>
          <div className="space-y-1">
            <Label>{t('comfyuiImport.metadata.workflowLabel')}</Label>
            <Input value={label} onChange={(event) => setLabel(event.currentTarget.value)} />
          </div>
          <div className="space-y-1">
            <Label>{t('comfyuiImport.metadata.workflowId')}</Label>
            <Input value={workflowId} onChange={(event) => setWorkflowId(slugify(event.currentTarget.value))} />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label>{t('comfyuiImport.metadata.description')}</Label>
            <Input value={description} onChange={(event) => setDescription(event.currentTarget.value)} />
          </div>
          <div className="space-y-1 md:col-span-2">
            <div className="font-mono text-[11px] text-muted-foreground">{workflowFileName}</div>
            <div className="font-mono text-[11px] text-muted-foreground">{manifestFileName}</div>
          </div>
          {mode === 'import' ? <label className="flex items-center gap-2 text-xs md:col-span-2">
            <input type="checkbox" checked={overwrite} onChange={(event) => setOverwrite(event.currentTarget.checked)} />
            {t('comfyuiImport.metadata.overwrite')}
          </label> : null}
        </div>
      );
    }
    if (step === 2) {
      const roleCandidateCounts = Object.entries(candidates).map(([semanticKey, values]) => `${semanticKey}: ${values?.length ?? 0}`);
      return (
        <div className="space-y-3 text-xs">
          <div className="grid gap-2 md:grid-cols-3">
            <div className="rounded border p-2"><div className="text-muted-foreground">{t('comfyuiImport.summary.nodes')}</div><div className="text-sm font-medium">{analysisResponse?.analysis?.nodes.length ?? 0}</div></div>
            <div className="rounded border p-2"><div className="text-muted-foreground">{t('comfyuiImport.summary.classTypes')}</div><div className="text-sm font-medium">{analysisResponse?.analysis?.classTypes.length ?? 0}</div></div>
            <div className="rounded border p-2"><div className="text-muted-foreground">{t('comfyuiImport.summary.candidates')}</div><div className="text-sm font-medium">{roleCandidateCounts.length}</div></div>
          </div>
          <div>
            <Label>{t('comfyuiImport.summary.classTypes')}</Label>
            <div className="mt-1 flex flex-wrap gap-1">{analysisResponse?.analysis?.classTypes.map((classType) => <Badge key={classType} variant="outline">{classType}</Badge>)}</div>
          </div>
          <div>
            <Label>{t('comfyuiImport.summary.candidateCounts')}</Label>
            <div className="mt-1 text-muted-foreground">{roleCandidateCounts.join(', ') || t('comfyuiImport.summary.noCandidates')}</div>
          </div>
          <DiagnosticRows diagnostics={analysisResponse?.diagnostics ?? []} emptyMessage={t('comfyuiImport.diagnostics.empty')} />
        </div>
      );
    }
    if (step === 3) {
      return (
        <div className="space-y-3">
          {inputEntries(role).map(([semanticKey, input]) => {
            const options = candidates[semanticKey] ?? [];
            const selected = selectedInputs[semanticKey];
            return (
              <div key={semanticKey} className="space-y-1 rounded border p-2">
                <div className="flex items-center gap-2">
                  <Label>{semanticKey}</Label>
                  <Badge variant={input.required ? 'destructive' : 'outline'}>{input.required ? t('comfyuiImport.inputs.required') : t('comfyuiImport.inputs.optional')}</Badge>
                  <span className="text-xs text-muted-foreground">{input.type}</span>
                </div>
                <Select value={inputSelections[semanticKey] ?? unmappedValue} onValueChange={(value) => setInputSelections((current) => ({ ...current, [semanticKey]: value === unmappedValue ? undefined : String(value) }))}>
                  <SelectTrigger className="w-full"><SelectValue>{selected ? candidateLabel(selected) : t('comfyuiImport.inputs.unmapped')}</SelectValue></SelectTrigger>
                  <SelectContent align="start" className="max-h-80">
                    {!input.required ? <SelectItem value={unmappedValue}>{t('comfyuiImport.inputs.unmapped')}</SelectItem> : null}
                    {options.map((candidate) => (
                      <SelectItem key={candidateKey(candidate)} value={candidateKey(candidate)}>
                        {candidateLabel(candidate)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selected ? (
                  <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                    <Badge variant={confidenceVariant(selected.confidence)}>{selected.confidence}</Badge>
                    <span>{t('comfyuiImport.candidates.score', { score: selected.score })}</span>
                    <span>{selected.reasons.join(', ')}</span>
                    {readableValue(selected.currentValue) !== null ? <span>{t('comfyuiImport.candidates.current', { value: readableValue(selected.currentValue) })}</span> : null}
                  </div>
                ) : null}
              </div>
            );
          })}
          {requiredInputsMissing ? <div className="text-xs text-destructive">{t('comfyuiImport.inputs.requiredMissing')}</div> : null}
        </div>
      );
    }
    if (step === 4) {
      const outputs = candidates.images ?? [];
      return (
        <div className="space-y-3">
          {outputs.map((candidate) => {
            const key = candidateKey(candidate);
            return (
              <label key={key} className="flex items-start gap-2 rounded border p-2 text-xs">
                <input
                  type="checkbox"
                  checked={outputSelections.includes(key)}
                  onChange={(event) => setOutputSelections((current) => {
                    if (!event.currentTarget.checked) return current.filter((value) => value !== key);
                    if (outputCardinality.maxBindings === 1) return [key];
                    return current.includes(key) ? current : [...current, key].slice(0, outputCardinality.maxBindings);
                  })}
                />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{candidateLabel(candidate)}</span>
                  <span className="mt-1 flex flex-wrap gap-1 text-muted-foreground">
                    <Badge variant={confidenceVariant(candidate.confidence)}>{candidate.confidence}</Badge>
                    <span>{t('comfyuiImport.candidates.score', { score: candidate.score })}</span>
                    <span>{candidate.reasons.join(', ')}</span>
                  </span>
                </span>
              </label>
            );
          })}
          {outputs.length === 0 ? <div className="text-xs text-muted-foreground">{t('comfyuiImport.outputs.empty')}</div> : null}
          {requiredOutputsMissing ? <div className="text-xs text-destructive">{t('comfyuiImport.outputs.requiredMissing')}</div> : null}
          {tooManyOutputsSelected ? <div className="text-xs text-destructive">{t('comfyuiImport.outputs.tooMany', { count: outputCardinality.maxBindings })}</div> : null}
        </div>
      );
    }
    if (step === 5) {
      const editable = inputEntries(role).filter(([semanticKey, input]) => !input.required && selectedInputs[semanticKey]);
      return (
        <div className="grid gap-3 md:grid-cols-2">
          {editable.map(([semanticKey, input]) => (
            <div key={semanticKey} className="space-y-1">
              <Label>{semanticKey}</Label>
              <Input
                type={input.type === 'string' || input.type === 'image' ? 'text' : 'number'}
                value={defaultsDraft[semanticKey] ?? ''}
                onChange={(event) => setDefaultsDraft((current) => ({ ...current, [semanticKey]: event.currentTarget.value }))}
              />
            </div>
          ))}
          {editable.length === 0 ? <div className="text-xs text-muted-foreground md:col-span-2">{t('comfyuiImport.defaults.empty')}</div> : null}
        </div>
      );
    }
    return (
      <div className="space-y-3">
        <div className="rounded border p-2 text-xs">
          <div><span className="text-muted-foreground">{t('comfyuiImport.review.workflow')}:</span> {workflowFileName}</div>
          <div><span className="text-muted-foreground">{t('comfyuiImport.review.manifest')}:</span> {mode === 'repair' ? repairEntry?.manifestFile : manifestFileName}</div>
        </div>
        <DiagnosticRows diagnostics={[...(analysisResponse?.diagnostics ?? []), ...saveDiagnostics]} emptyMessage={t('comfyuiImport.diagnostics.empty')} />
        <pre className="max-h-80 overflow-auto rounded border bg-muted/30 p-2 text-[11px]">{manifest ? JSON.stringify(manifest, null, 2) : t('comfyuiImport.review.manifestNotReady')}</pre>
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{mode === 'repair' ? t('comfyuiImport.title.repair') : t('comfyuiImport.title.import')}</DialogTitle>
          <DialogDescription>{mode === 'repair' ? t('comfyuiImport.description.repair') : t('comfyuiImport.description.import')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-1">
          {stepLabelKeys.map((stepLabelKey, index) => (
            <Badge key={stepLabelKey} variant={index === step ? 'default' : 'outline'}>{index + 1}. {t(`comfyuiImport.steps.${stepLabelKey}`)}</Badge>
          ))}
        </div>
        {error ? <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{error}</div> : null}
        <div className="min-h-0 overflow-auto pr-1">{renderStep()}</div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={step === 0 || (mode === 'repair' && step === 1) || saving} onClick={() => setStep((current) => Math.max(mode === 'repair' ? 1 : 0, current - 1) as Step)}>{t('comfyuiImport.interactions.back')}</Button>
          {step < 6 ? (
            <Button type="button" disabled={!canContinue || (step === 3 && requiredInputsMissing) || (step === 4 && (requiredOutputsMissing || tooManyOutputsSelected))} onClick={nextStep}>{t('comfyuiImport.interactions.next')}</Button>
          ) : (
            <Button type="button" disabled={!manifest || requiredInputsMissing || requiredOutputsMissing || tooManyOutputsSelected || saving} onClick={() => void saveImport()}>{saving ? t('comfyuiImport.interactions.saving') : mode === 'repair' ? t('comfyuiImport.interactions.saveRepair') : t('comfyuiImport.interactions.saveImport')}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
