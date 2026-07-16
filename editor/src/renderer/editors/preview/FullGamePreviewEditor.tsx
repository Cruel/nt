import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel as ResizePanel } from 'react-resizable-panels';
import {
  AlertTriangle,
  Binary,
  Braces,
  Bug,
  ChevronDown,
  Clipboard,
  Database,
  FastForward,
  FilePlus2,
  FolderOpen,
  Hash,
  List,
  MousePointer2,
  PackagePlus,
  RefreshCw,
  RotateCcw,
  Save,
  StepForward,
  Text,
  ToggleLeft,
  X,
} from 'lucide-react';
import { EnginePreview, sanitizePreviewFpsCap, type EnginePreviewControlsContext } from '@/components/engine-preview';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { PanelResizeSeparator } from '@/components/resize-separator';
import { useProjectStore } from '@/project/project-store';
import { usePreviewManagerStore } from '@/preview/preview-manager-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useCommandStore } from '@/commands/command-store';
import { buildDefaultRecordTab, buildTestDetailTabForRecord } from '@/workbench/editor-registry';
import { navigateToWorkbenchTarget } from '@/workbench/workbench-navigation';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { visualForCollection } from '@/workspace/collection-visuals';
import { SearchSelectorDialog } from '@/workspace/SearchSelectorDialog';
import { buildCommandPaletteItems, filterSelectorItems } from '@/workspace/command-palette-search';
import { authoringCollectionMetadata, isAuthoringCollectionKey } from '../../../shared/project-schema/authoring-collections';
import { selectedExportProfile } from '../../../shared/project-schema/authoring-export';
import { isAuthoringProject, type AuthoringProject, type AuthoringRecordBase } from '../../../shared/project-schema/authoring-project';
import { buildCompiledRuntimeExport } from '../../../shared/project-schema/compiled-runtime-export';
import { parseTestData } from '../../../shared/project-schema/authoring-tests';
import { parseVariableData, parseVariableDefaultText, variableDefaultValueToText } from '../../../shared/project-schema/authoring-variables';
import { recordedTestDraftToTestData, type RecordedRuntimeInputKind } from '../../../shared/project-schema/recorded-test-draft';
import type { PreviewInteractionSubject, RuntimeDebugEntityRef, RuntimeDebugSnapshot, PreviewToEditorMessage, RuntimeFastForwardResult } from '../../../shared/preview-protocol';

type FullGamePreviewMode = 'debug' | 'recording';
type CompiledProjectFreshness = 'not-loaded' | 'fresh' | 'stale';
type RuntimeCommandFactory = () => Promise<void | RuntimeFastForwardResult>;

interface RecordedRuntimeAction {
  id: string;
  kind: RecordedRuntimeInputKind;
  label: string;
  recordedAt: string;
  input: {
    type: RecordedRuntimeInputKind;
    optionIndex?: number;
    direction?: number;
    subjects?: PreviewInteractionSubject[];
    verbId?: string;
    operands?: PreviewInteractionSubject[];
    documentId?: string;
    target?: string;
    selector?: string;
  };
}

interface RecorderTraceEvent {
  id: string;
  label: string;
  detail?: string;
  severity: RuntimeLogEntry['severity'];
  capturedAt: string;
}

interface RecordedTestDraft {
  mode: 'idle' | 'recording' | 'replaying' | 'failed';
  actions: RecordedRuntimeAction[];
  traceEvents: RecorderTraceEvent[];
  replayError?: string;
  savedTestId?: string;
  saveError?: string;
}

interface RuntimeCommandOptions {
  recordedAction?: RecordedRuntimeAction;
}

interface RuntimeLogEntry {
  id: string;
  label: string;
  detail?: string;
  severity: 'info' | 'warning' | 'error';
}

interface FullGamePreviewState {
  snapshot: RuntimeDebugSnapshot | null;
  eventLog: RuntimeLogEntry[];
}

interface FullGamePreviewCompiledProjectState {
  loadedCompiledProjectRevision: string | null;
  currentCompiledProjectRevision: string | null;
  freshness: CompiledProjectFreshness;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function compiledProjectRevision(compiledProject: unknown): string {
  return hashString(stableStringify(compiledProject));
}

function fallbackLabel(id: string | undefined, label: string | undefined) {
  return label || id || '—';
}

function recordFor(project: AuthoringProject | null, collection: keyof Pick<AuthoringProject, 'variables' | 'rooms' | 'interactables' | 'verbs' | 'interactions' | 'maps' | 'dialogues' | 'scenes'>, id: string | undefined): AuthoringRecordBase | null {
  if (!project || !id) return null;
  return project[collection][id] ?? null;
}

function entityCollection(ref: RuntimeDebugEntityRef | undefined): keyof Pick<AuthoringProject, 'variables' | 'rooms' | 'interactables' | 'verbs' | 'interactions' | 'maps' | 'dialogues' | 'scenes'> | null {
  if (!ref) return null;
  if (ref.collection === 'variables' || ref.collection === 'rooms' || ref.collection === 'verbs' || ref.collection === 'maps' || ref.collection === 'dialogues' || ref.collection === 'scenes') return ref.collection;
  if (ref.collection === 'objects') return 'interactables';
  if (ref.collection === 'actions') return 'interactions';
  if (ref.type === 'variable') return 'variables';
  if (ref.type === 'room') return 'rooms';
  if (ref.type === 'object') return 'interactables';
  if (ref.type === 'verb') return 'verbs';
  if (ref.type === 'action') return 'interactions';
  if (ref.type === 'map') return 'maps';
  if (ref.type === 'dialogue') return 'dialogues';
  if (ref.type === 'scene') return 'scenes';
  return null;
}

function labelEntity(project: AuthoringProject | null, ref: RuntimeDebugEntityRef | undefined) {
  const collection = entityCollection(ref);
  const record = collection ? recordFor(project, collection, ref?.id) : null;
  return fallbackLabel(ref?.id, record?.label ?? ref?.label);
}

function labelById(project: AuthoringProject | null, collection: keyof Pick<AuthoringProject, 'variables' | 'rooms' | 'interactables' | 'verbs' | 'interactions'>, id: string) {
  return fallbackLabel(id, recordFor(project, collection, id)?.label);
}

function stringifyValue(value: unknown) {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function addLogEntry(entries: RuntimeLogEntry[], entry: Omit<RuntimeLogEntry, 'id'>): RuntimeLogEntry[] {
  return [{ ...entry, id: `${Date.now()}-${entries.length}` }, ...entries].slice(0, 80);
}

function addTraceEvent(events: RecorderTraceEvent[], entry: Omit<RecorderTraceEvent, 'id' | 'capturedAt'>): RecorderTraceEvent[] {
  return [{ ...entry, id: crypto.randomUUID(), capturedAt: new Date().toISOString() }, ...events].slice(0, 120);
}

function fastForwardDetail(result: RuntimeFastForwardResult) {
  const parts = [
    `reason=${result.reason}`,
    `continues=${result.stepsApplied}`,
    `ticks=${result.ticksApplied}`,
  ];
  if (result.lastInput) parts.push(`last=${result.lastInput}`);
  if (result.diagnostic) parts.push(result.diagnostic);
  return parts.join(' · ');
}

function fastForwardSeverity(result: RuntimeFastForwardResult): RuntimeLogEntry['severity'] {
  if (result.reason === 'error') return 'error';
  if (result.reason === 'budget-exhausted' || result.reason === 'stabilization-limit') return 'warning';
  return 'info';
}

function previewMessageLabel(message: PreviewToEditorMessage): Omit<RuntimeLogEntry, 'id'> | null {
  if (message.type === 'runtime-debug-snapshot') {
    return { label: 'Runtime snapshot refreshed', detail: message.snapshot.waiting.reason ?? message.snapshot.waiting.kind, severity: 'info' };
  }
  if (message.type === 'runtime-fast-forward-result') {
    return { label: 'Fast-forward stopped', detail: fastForwardDetail(message.result), severity: fastForwardSeverity(message.result) };
  }
  if (message.type === 'runtime-debug-event') {
    const detail = [message.event.kind, message.event.target?.id, `old=${stringifyValue(message.event.oldValue)}`, `new=${stringifyValue(message.event.newValue)}`]
      .filter(Boolean)
      .join(' · ');
    return { label: `Debug-only mutation: ${message.event.label}`, detail, severity: message.event.rejected ? 'warning' : 'info' };
  }
  if (message.type === 'preview-diagnostic') {
    return { label: message.diagnostic.message, detail: message.diagnostic.path, severity: message.diagnostic.severity };
  }
  if (message.type === 'runtime-error') return { label: message.message, severity: 'error' };
  if (message.type === 'object-clicked') return { label: 'Object clicked', detail: message.objectId, severity: 'info' };
  if (message.type === 'preview-object-selected') return { label: 'Preview object selected', detail: message.objectId, severity: 'info' };
  if (message.type === 'preview-interacted') return { label: 'Preview interaction', detail: message.interaction, severity: 'info' };
  if (message.type === 'fps-counter') return null;
  if (message.type === 'command-result') return null;
  return null;
}

function recordedActionLabel(action: RecordedRuntimeAction) {
  switch (action.kind) {
    case 'continue':
      return 'Continue';
    case 'dialogue-option':
      return `Choice ${action.input.optionIndex ?? '—'}`;
    case 'navigate':
      return `Navigate ${action.input.direction ?? '—'}`;
    case 'select-subjects':
      return `Select ${action.input.subjects?.map((subject) => `${subject.kind}:${subject.id}`).join(', ') || 'subjects'}`;
    case 'clear-subject-selection':
      return 'Clear subject selection';
    case 'run-interaction':
      return `Run ${action.input.verbId ?? 'interaction'}`;
    case 'ui-click':
      return `Click ${action.input.selector ?? action.input.target ?? 'UI target'}`;
    default:
      return action.label;
  }
}

function createRecordedAction(kind: RecordedRuntimeInputKind, label: string, input: RecordedRuntimeAction['input']): RecordedRuntimeAction {
  return { id: crypto.randomUUID(), kind, label, input, recordedAt: new Date().toISOString() };
}

function uiClickTarget(value: unknown): { documentId: string; target: string; selector: string; label: string } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const documentId = typeof record.documentId === 'string' ? record.documentId : '';
  const target = typeof record.target === 'string' ? record.target : '';
  const selector = typeof record.selector === 'string' ? record.selector : target;
  if (!documentId || !selector) return null;
  return { documentId, target: target || selector, selector, label: typeof record.label === 'string' ? record.label : selector };
}

function normalizeTestId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function nextRecordedTestId(project: AuthoringProject | null) {
  const base = 'recorded-test';
  if (!project?.tests[base]) return base;
  let index = 2;
  while (project.tests[`${base}-${index}`]) index += 1;
  return `${base}-${index}`;
}

function compiledProjectDiagnosticEntries(project: AuthoringProject | null): { compiledProject: unknown | null; shaderMaterialMetadata: unknown | null; previewAssets: Array<{ sourcePath: string; runtimePath: string }>; revision: string | null; entries: Omit<RuntimeLogEntry, 'id'>[]; ok: boolean } {
  if (!project) {
    return {
      ok: false,
      compiledProject: null,
      shaderMaterialMetadata: null,
      previewAssets: [],
      revision: null,
      entries: [{ label: 'No authoring project is open', detail: 'Open or create a project before using the Play tab.', severity: 'warning' }],
    };
  }
  const exported = buildCompiledRuntimeExport(project, { projectRoot: null, profile: selectedExportProfile(project) });
  const entries = exported.diagnostics.slice(0, 6).map((diagnostic) => ({
    label: diagnostic.message,
    detail: diagnostic.path,
    severity: diagnostic.severity,
  }));
  return {
    ok: exported.ok,
    compiledProject: exported.compiledProject ?? null,
    shaderMaterialMetadata: exported.shaderMaterialMetadata ?? null,
    previewAssets: exported.fileEntries.map((entry) => ({ sourcePath: entry.source, runtimePath: entry.packagePath })),
    revision: exported.compiledProject ? compiledProjectRevision(exported.compiledProject) : null,
    entries,
  };
}

function executeRecordedAction(action: RecordedRuntimeAction, context: EnginePreviewControlsContext) {
  switch (action.input.type) {
    case 'continue':
      return context.controller.continueRuntime();
    case 'dialogue-option':
      return context.controller.selectDialogueOption(action.input.optionIndex ?? 0);
    case 'navigate':
      return context.controller.navigateRuntime(action.input.direction ?? 0);
    case 'select-subjects':
      return context.controller.selectRuntimeSubjects(action.input.subjects ?? []);
    case 'clear-subject-selection':
      return context.controller.clearRuntimeSubjectSelection();
    case 'run-interaction':
      return context.controller.runRuntimeInteraction(action.input.verbId ?? '', action.input.operands ?? []);
  }
}

function InfoRow({ label, value }: { label: string; value: string | number | boolean | undefined | null }) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="max-w-40 truncate text-right font-medium">{value === undefined || value === null || value === '' ? '—' : String(value)}</span>
    </div>
  );
}

function Panel({
  title,
  icon,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  summary?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b">
      <button
        type="button"
        className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-muted/40"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{title}</span>
        {summary ? <span className="truncate text-[11px] text-muted-foreground">{summary}</span> : null}
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open ? <div className="space-y-2 px-3 pb-3">{children}</div> : null}
    </section>
  );
}

function RuntimeSummaryPanel({ snapshot }: { snapshot: RuntimeDebugSnapshot | null }) {
  return (
    <Panel
      title="Runtime"
      icon={<Bug className="h-3.5 w-3.5" />}
      summary={snapshot ? `${snapshot.running ? 'Running' : 'Stopped'} · ${snapshot.waiting.kind}` : 'No snapshot'}
      defaultOpen
    >
      <div className="flex flex-wrap gap-1">
        <Badge variant={snapshot?.loaded ? 'default' : 'secondary'}>{snapshot?.loaded ? 'Loaded' : 'Unloaded'}</Badge>
        <Badge variant={snapshot?.running ? 'default' : 'secondary'}>{snapshot?.running ? 'Running' : 'Stopped'}</Badge>
        <Badge variant={snapshot?.waiting.kind === 'error' ? 'destructive' : 'outline'}>{snapshot?.waiting.kind ?? 'No snapshot'}</Badge>
      </div>
      <div className="space-y-1">
        <InfoRow label="Waiting reason" value={snapshot?.waiting.reason} />
      </div>
    </Panel>
  );
}

function RuntimeEntityButton({ entity, project, label }: { entity: RuntimeDebugEntityRef | null | undefined; project: AuthoringProject | null; label: string }) {
  if (!entity || !isAuthoringCollectionKey(entity.collection)) return null;
  const metadata = authoringCollectionMetadata[entity.collection];
  const visual = visualForCollection(entity.collection);
  const Icon = visual.icon;
  const title = labelEntity(project, entity);
  const tab = buildDefaultRecordTab({
    id: `${entity.collection}:${entity.id}`,
    label: title,
    type: metadata.nodeType,
    collection: entity.collection,
    entityId: entity.id,
  });
  if (!tab) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-7 max-w-44 gap-1.5 px-2"
      onClick={() => navigateToWorkbenchTarget({ tab })}
      title={`${label}: ${title}`}
    >
      <Icon className={`h-3.5 w-3.5 shrink-0 ${visual.colorClassName}`} />
      <span className="truncate">{title}</span>
    </Button>
  );
}

function InputAvailabilityPanel({ snapshot, project, controlsContext, onCommand }: { snapshot: RuntimeDebugSnapshot | null; project: AuthoringProject | null; controlsContext: EnginePreviewControlsContext | null; onCommand: (command: RuntimeCommandFactory, label: string, options?: RuntimeCommandOptions) => void }) {
  const controller = controlsContext?.controller ?? null;
  const inputs = snapshot?.availableInputs;
  return (
    <Panel
      title="Player input"
      icon={<StepForward className="h-3.5 w-3.5" />}
      summary={inputs ? `${inputs.dialogueOptions.length + inputs.navigation.length + inputs.actions.length + (inputs.continue ? 1 : 0)} available` : 'None'}
      defaultOpen
    >
      {inputs?.dialogueOptions.map((option) => (
        <Button key={option.index} size="sm" variant="outline" className="w-full justify-start" disabled={!option.enabled || !controller} onClick={() => controller && onCommand(
          () => controller.selectDialogueOption(option.index),
          `Dialogue option ${option.index} sent`,
          { recordedAction: createRecordedAction('dialogue-option', option.label, { type: 'dialogue-option', optionIndex: option.index }) },
        )}>
          Choice {option.index}: {option.label}
        </Button>
      ))}
      {inputs?.navigation.map((direction) => (
        <Button key={direction.index} size="sm" variant="outline" className="w-full justify-start" disabled={!direction.enabled || !controller} onClick={() => controller && onCommand(
          () => controller.navigateRuntime(direction.index),
          `Navigate ${direction.index} sent`,
          { recordedAction: createRecordedAction('navigate', direction.label, { type: 'navigate', direction: direction.index }) },
        )}>
          Navigate {direction.index}: {direction.label}
        </Button>
      ))}
      {inputs?.actions.map((action) => (
        <Button key={action.verbId} size="sm" variant="outline" className="w-full justify-start" disabled={!action.enabled || !controller} onClick={() => controller && onCommand(
          () => controller.runRuntimeInteraction(action.verbId, inputs.selectedSubjects),
          `Interaction ${action.verbId} sent`,
          { recordedAction: createRecordedAction('run-interaction', action.label || action.verbId, { type: 'run-interaction', verbId: action.verbId, operands: inputs.selectedSubjects }) },
        )}>
          {labelById(project, 'verbs', action.verbId)} ({action.selectedCount}/{action.objectCount})
        </Button>
      ))}
      {(inputs?.clickableTargets ?? []).map(uiClickTarget).filter((target): target is NonNullable<typeof target> => target !== null).map((target) => (
        <Button key={`${target.documentId}:${target.selector}`} size="sm" variant="outline" className="w-full justify-start" disabled={!controller} onClick={() => controller && onCommand(
          () => Promise.resolve(),
          `Recorded UI click ${target.selector}`,
          { recordedAction: createRecordedAction('ui-click', target.label, { type: 'ui-click', documentId: target.documentId, target: target.target, selector: target.selector }) },
        )}>
          Record UI click: {target.label}
        </Button>
      ))}
    </Panel>
  );
}

function parseDebugVariableDraft(type: string | undefined, text: string, enumValues?: readonly string[]) {
  if (type === 'boolean' || type === 'integer' || type === 'number' || type === 'string' || type === 'enum') {
    return parseVariableDefaultText(type, text, enumValues);
  }
  try {
    return { ok: true as const, value: JSON.parse(text) };
  } catch {
    return { ok: true as const, value: text };
  }
}

function variableTypeIcon(type: string | undefined) {
  switch (type) {
    case 'boolean':
      return ToggleLeft;
    case 'integer':
    case 'number':
      return Hash;
    case 'string':
      return Text;
    case 'enum':
      return List;
    case 'binary':
      return Binary;
    default:
      return Braces;
  }
}

function VariableDebugRow({
  variable,
  project,
  controlsContext,
  mutationDisabled,
  onCommand,
}: {
  variable: RuntimeDebugSnapshot['variables'][number];
  project: AuthoringProject | null;
  controlsContext: EnginePreviewControlsContext | null;
  mutationDisabled: boolean;
  onCommand: (command: RuntimeCommandFactory, label: string, options?: RuntimeCommandOptions) => void;
}) {
  const record = recordFor(project, 'variables', variable.id);
  const data = record ? parseVariableData(record.data) : null;
  const [draft, setDraft] = useState(variableDefaultValueToText(variable.value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(variableDefaultValueToText(variable.value));
  }, [editing, variable.value]);
  const parsed = parseDebugVariableDraft(data?.type ?? variable.type, draft, data?.enumValues);
  const controller = controlsContext?.controller ?? null;
  const disabled = mutationDisabled || !controller;
  const type = data?.type ?? variable.type;
  const TypeIcon = variableTypeIcon(type);
  const label = fallbackLabel(variable.id, record?.label ?? variable.label);
  const defaultValue = data?.defaultValue ?? variable.defaultValue;
  const commit = () => {
    if (!controller || !parsed.ok || disabled) return;
    onCommand(() => controller.setRuntimeVariable(variable.id, parsed.value), `Debug set ${variable.id}`);
    setEditing(false);
  };
  const cancel = () => {
    setDraft(variableDefaultValueToText(variable.value));
    setEditing(false);
  };
  const setValue = (value: unknown) => {
    if (!controller || disabled) return;
    onCommand(() => controller.setRuntimeVariable(variable.id, value), `Debug set ${variable.id}`);
    setEditing(false);
  };
  const editor = (() => {
    if (!editing) return null;
    if (type === 'enum') {
      return (
        <div className="flex min-w-0 flex-[1.25] items-center gap-1">
          <select
            autoFocus
            className="h-7 min-w-0 flex-1 rounded border bg-background px-2 text-xs outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
            value={draft}
            onBlur={cancel}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDraft(value);
              setValue(value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') cancel();
            }}
            aria-label={`Debug variable ${variable.id} value`}
          >
            {(data?.enumValues ?? []).map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <Button type="button" size="icon-sm" variant="ghost" className="shrink-0" onClick={cancel} aria-label={`Cancel editing ${label}`}>
            <X className="size-4" />
          </Button>
        </div>
      );
    }
    return (
      <div className="flex min-w-0 flex-[1.25] items-center gap-1">
        <input
          autoFocus
          type={type === 'integer' || type === 'number' ? 'number' : 'text'}
          step={type === 'integer' ? '1' : type === 'number' ? 'any' : undefined}
          className={`h-7 min-w-0 flex-1 rounded border bg-background px-2 font-mono text-xs outline-none focus:border-ring focus:ring-2 focus:ring-ring/30 ${!parsed.ok ? 'border-destructive' : ''}`}
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={cancel}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit();
            if (event.key === 'Escape') cancel();
          }}
          aria-label={`Debug variable ${variable.id} value`}
          aria-invalid={!parsed.ok}
          title={!parsed.ok ? parsed.message : undefined}
        />
        <Button type="button" size="icon-sm" variant="ghost" className="shrink-0" onClick={cancel} aria-label={`Cancel editing ${label}`}>
          <X className="size-4" />
        </Button>
      </div>
    );
  })();
  return (
    <div
      className={`group flex h-8 items-center gap-2 border-b px-1 text-xs last:border-b-0 ${!editing && type !== 'boolean' && !disabled ? 'cursor-pointer hover:bg-muted/30' : ''}`}
      onClick={() => {
        if (!editing && type !== 'boolean' && !disabled) setEditing(true);
      }}
    >
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger render={<span className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground" />}>
            <TypeIcon className="h-3.5 w-3.5" />
          </TooltipTrigger>
          <TooltipContent side="left" align="center" sideOffset={8} className="block max-w-72 space-y-1">
            <div><span className="font-medium">Type:</span> {type ?? 'unknown'}</div>
            <div><span className="font-medium">Default:</span> <span className="font-mono">{stringifyValue(defaultValue)}</span></div>
            <div><span className="font-medium">ID:</span> <span className="font-mono">{variable.id}</span></div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <span className="min-w-0 flex-1 truncate font-medium" title={`${label} (${variable.id})`}>{label}</span>
      {variable.dirty || variable.overridden ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" title="Changed from default" /> : null}
      {editing ? (
        editor
      ) : (
        <>
          {type === 'boolean' ? (
            <Switch
              checked={Boolean(variable.value)}
              disabled={disabled}
              onCheckedChange={(checked) => setValue(Boolean(checked))}
              aria-label={`Set ${label}`}
            />
          ) : (
            <span className="min-w-0 max-w-[45%] truncate font-mono text-muted-foreground" title={variableDefaultValueToText(variable.value)}>
              {variableDefaultValueToText(variable.value)}
            </span>
          )}
          <div className="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation();
                if (controller) onCommand(() => controller.resetRuntimeVariable(variable.id), `Debug reset ${variable.id}`);
              }}
              aria-label={`Reset ${label}`}
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function VariablesPanel({ snapshot, project, controlsContext, mutationDisabled, onCommand }: { snapshot: RuntimeDebugSnapshot | null; project: AuthoringProject | null; controlsContext: EnginePreviewControlsContext | null; mutationDisabled: boolean; onCommand: (command: RuntimeCommandFactory, label: string, options?: RuntimeCommandOptions) => void }) {
  const variables = useMemo(() => snapshot?.variables ?? [], [snapshot?.variables]);
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const filteredVariables = useMemo(() => {
    if (!normalizedQuery) return variables;
    return variables.filter((variable) => {
      const record = recordFor(project, 'variables', variable.id);
      const label = fallbackLabel(variable.id, record?.label ?? variable.label);
      return [
        variable.id,
        label,
        variable.type,
        variableDefaultValueToText(variable.value),
      ].some((value) => String(value).toLowerCase().includes(normalizedQuery));
    });
  }, [normalizedQuery, project, variables]);
  return (
    <Panel title="Variables" icon={<Database className="h-3.5 w-3.5" />} summary={`${variables.length}`}>
      {variables.length === 0 ? <div className="text-xs text-muted-foreground">No runtime variables in the latest snapshot.</div> : null}
      {variables.length > 0 ? (
        <div className="space-y-2">
          {variables.length > 3 ? (
            <SearchInput
              inputClassName="h-7"
              value={query}
              onValueChange={setQuery}
              placeholder="Search variables"
              aria-label="Search variables"
              clearAriaLabel="Clear variable search"
            />
          ) : null}
          <div className="max-h-[350px] overflow-y-auto">
            {filteredVariables.map((variable) => <VariableDebugRow key={variable.id} variable={variable} project={project} controlsContext={controlsContext} mutationDisabled={mutationDisabled} onCommand={onCommand} />)}
            {filteredVariables.length === 0 ? <div className="px-2 py-3 text-center text-xs text-muted-foreground">No matching variables.</div> : null}
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

function InventoryPanel({ snapshot, project, controlsContext, mutationDisabled, onCommand }: { snapshot: RuntimeDebugSnapshot | null; project: AuthoringProject | null; controlsContext: EnginePreviewControlsContext | null; mutationDisabled: boolean; onCommand: (command: RuntimeCommandFactory, label: string, options?: RuntimeCommandOptions) => void }) {
  const inventory = snapshot?.inventory ?? [];
  const objectIds = useMemo(() => project ? Object.keys(project.interactables) : [], [project]);
  const [selectedObjectId, setSelectedObjectId] = useState('');
  useEffect(() => {
    if (!selectedObjectId && objectIds[0]) setSelectedObjectId(objectIds[0]);
    else if (selectedObjectId && !objectIds.includes(selectedObjectId)) setSelectedObjectId(objectIds[0] ?? '');
  }, [objectIds, selectedObjectId]);
  const controller = controlsContext?.controller ?? null;
  const disabled = mutationDisabled || !controller;
  return (
    <Panel title="Inventory" icon={<PackagePlus className="h-3.5 w-3.5" />} summary={`${inventory.length}`}>
      <div className="flex gap-2">
        <select className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs" value={selectedObjectId} onChange={(event) => setSelectedObjectId(event.target.value)} aria-label="Debug object to give">
          {objectIds.map((id) => <option key={id} value={id}>{labelById(project, 'interactables', id)} ({id})</option>)}
        </select>
        <Button className="!h-7 shrink-0" size="sm" variant="secondary" disabled={disabled || !selectedObjectId} onClick={() => controller && onCommand(() => controller.giveRuntimeObject(selectedObjectId), `Debug give ${selectedObjectId}`)}>Debug give</Button>
      </div>
      {inventory.length === 0 ? <div className="text-xs text-muted-foreground">Inventory is empty in the latest snapshot.</div> : null}
      {inventory.map((item) => (
        <div key={item.id} className="rounded-md border p-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{labelById(project, 'interactables', item.id)}</span>
            {item.selected ? <Badge>selected</Badge> : null}
          </div>
          <div className="mt-1 font-mono text-[11px] text-muted-foreground">{item.id}</div>
          <InfoRow label="Location" value={labelEntity(project, item.location)} />
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="outline" disabled={disabled} onClick={() => controller && onCommand(() => controller.removeRuntimeInventoryObject(item.id), `Debug remove ${item.id}`)}>Debug remove</Button>
            <Button size="sm" variant="ghost" disabled={!controller} onClick={() => controller && onCommand(
              () => controller.selectRuntimeSubjects([{ kind: 'interactable', id: item.id }]),
              `Selected ${item.id}`,
              { recordedAction: createRecordedAction('select-subjects', `Select ${item.id}`, { type: 'select-subjects', subjects: [{ kind: 'interactable', id: item.id }] }) },
            )}>Select</Button>
          </div>
        </div>
      ))}
    </Panel>
  );
}

function RoomObjectToolsPanel({ snapshot, project, controlsContext, mutationDisabled, onCommand }: { snapshot: RuntimeDebugSnapshot | null; project: AuthoringProject | null; controlsContext: EnginePreviewControlsContext | null; mutationDisabled: boolean; onCommand: (command: RuntimeCommandFactory, label: string, options?: RuntimeCommandOptions) => void }) {
  const objects = project ? Object.entries(project.interactables).slice(0, 6) : [];
  const roomItems = useMemo(() => filterSelectorItems(buildCommandPaletteItems(project), { collections: ['rooms'], includeActions: false }), [project]);
  const [roomSelectorOpen, setRoomSelectorOpen] = useState(false);
  const controller = controlsContext?.controller ?? null;
  const debugDisabled = mutationDisabled || !controller;
  return (
    <>
      <Panel
        title="World tools"
        icon={<MousePointer2 className="h-3.5 w-3.5" />}
        summary={snapshot?.currentRoomId ? labelById(project, 'rooms', snapshot.currentRoomId) : 'No room'}
      >
        <Button size="sm" variant="secondary" disabled={debugDisabled || roomItems.length === 0} onClick={() => setRoomSelectorOpen(true)}>
          Teleport to Room
        </Button>
        <div className="text-xs font-medium">Object helpers</div>
        <div className="grid grid-cols-2 gap-1">
          {objects.map(([id, object]) => <Button key={id} size="sm" variant="outline" disabled={debugDisabled} onClick={() => controller && onCommand(() => controller.giveRuntimeObject(id), `Debug give ${id}`)}>{object.label || id}</Button>)}
        </div>
        <Button size="sm" variant="ghost" disabled={!controller} onClick={() => controller && onCommand(
          () => controller.clearRuntimeSubjectSelection(),
          'Subject selection cleared',
          { recordedAction: createRecordedAction('clear-subject-selection', 'Clear subject selection', { type: 'clear-subject-selection' }) },
        )}>Clear subject selection</Button>
      </Panel>
      <SearchSelectorDialog
        open={roomSelectorOpen}
        title="Teleport to Room"
        placeholder="Search rooms..."
        emptyMessage="No rooms found."
        items={roomItems}
        selectedId={snapshot?.currentRoomId ? `record:rooms:${snapshot.currentRoomId}` : null}
        onSelect={(item) => {
          if (!controller || !item.entityId) return;
          onCommand(() => controller.teleportRuntimeRoom(item.entityId!), `Debug teleport ${item.entityId}`);
        }}
        onOpenChange={setRoomSelectorOpen}
      />
    </>
  );
}

function SaveSnapshotPanel({ snapshot }: { snapshot: RuntimeDebugSnapshot | null }) {
  const json = snapshot ? stringifyValue(snapshot.saveSnapshot) : '{}';
  return (
    <Panel title="Save data" icon={<Save className="h-3.5 w-3.5" />} summary={snapshot ? 'Available' : 'Unavailable'}>
      <Button size="sm" variant="outline" disabled={!snapshot} onClick={() => void navigator.clipboard?.writeText(json)}>
        <Clipboard className="h-3.5 w-3.5" />
        Copy JSON
      </Button>
      <pre className="max-h-56 overflow-auto rounded-md bg-muted p-2 text-[11px] leading-relaxed">{json}</pre>
    </Panel>
  );
}

function EventLogPanel({ entries, diagnostics }: { entries: RuntimeLogEntry[]; diagnostics: RuntimeDebugSnapshot['diagnostics'] }) {
  return (
    <Panel title="Events & diagnostics" summary={`${diagnostics.length + entries.length}`}>
      {diagnostics.slice(0, 8).map((diagnostic, index) => (
        <div key={`${diagnostic.message}-${index}`} className="rounded-md border p-2 text-xs">
          <Badge variant={diagnostic.severity === 'error' ? 'destructive' : diagnostic.severity === 'warning' ? 'secondary' : 'outline'}>{diagnostic.severity}</Badge>
          <div className="mt-1">{diagnostic.message}</div>
          {diagnostic.path ? <div className="font-mono text-[11px] text-muted-foreground">{diagnostic.path}</div> : null}
        </div>
      ))}
      {entries.length === 0 ? <div className="text-xs text-muted-foreground">No runtime events captured yet.</div> : null}
      {entries.map((entry) => (
        <div key={entry.id} className="rounded-md border p-2 text-xs">
          <div className="flex items-center gap-2">
            <Badge variant={entry.severity === 'error' ? 'destructive' : entry.severity === 'warning' ? 'secondary' : 'outline'}>{entry.severity}</Badge>
            <span>{entry.label}</span>
          </div>
          {entry.detail ? <div className="mt-1 font-mono text-[11px] text-muted-foreground">{entry.detail}</div> : null}
        </div>
      ))}
    </Panel>
  );
}

function RecorderPanel({
  draft,
  targetTestId,
  compiledProjectFreshness,
  onTargetTestIdChange,
  onStart,
  onStop,
  onClear,
  onUndoLast,
  onReplay,
  onSaveNew,
  onApplyExisting,
  onOpenSavedTest,
}: {
  draft: RecordedTestDraft;
  targetTestId: string;
  compiledProjectFreshness: CompiledProjectFreshness;
  onTargetTestIdChange: (value: string) => void;
  onStart: () => void;
  onStop: () => void;
  onClear: () => void;
  onUndoLast: () => void;
  onReplay: () => void;
  onSaveNew: () => void;
  onApplyExisting: () => void;
  onOpenSavedTest: () => void;
}) {
  const isRecording = draft.mode === 'recording';
  const isReplaying = draft.mode === 'replaying';
  const canSave = !isRecording && !isReplaying && draft.actions.length > 0;
  const recordingStale = isRecording && compiledProjectFreshness === 'stale';
  return (
    <Panel
      title="Recorder"
      icon={<FilePlus2 className="h-3.5 w-3.5" />}
      summary={`${draft.actions.length} actions · ${draft.mode}`}
      defaultOpen
    >
      <div className="flex flex-wrap gap-1">
        <Badge variant={isRecording ? 'default' : draft.mode === 'failed' ? 'destructive' : 'secondary'}>{draft.mode}</Badge>
        <Badge variant="outline">{draft.actions.length} action{draft.actions.length === 1 ? '' : 's'}</Badge>
        <Badge variant="outline">{draft.traceEvents.length} trace</Badge>
      </div>
      <div className="grid grid-cols-2 gap-1">
        <Button size="sm" variant="secondary" disabled={isRecording || isReplaying} onClick={onStart}>Start Recording</Button>
        <Button size="sm" variant="outline" disabled={!isRecording} onClick={onStop}>Stop</Button>
        <Button size="sm" variant="ghost" disabled={isReplaying || (draft.actions.length === 0 && draft.traceEvents.length === 0)} onClick={onClear}>Clear</Button>
        <Button size="sm" variant="ghost" disabled={isReplaying || draft.actions.length === 0} onClick={onUndoLast}>Undo Last</Button>
        <Button size="sm" variant="outline" disabled={isRecording || isReplaying || draft.actions.length === 0} onClick={onReplay}>Replay</Button>
        <Button size="sm" variant="outline" disabled={!canSave} onClick={onSaveNew}>Save as New Test</Button>
        <Button size="sm" variant="outline" disabled={!canSave || !targetTestId.trim()} onClick={onApplyExisting}>Apply to Existing Test</Button>
      </div>
      <div className="flex gap-1">
        <Input className="h-8 text-xs" value={targetTestId} onChange={(event) => onTargetTestIdChange(event.target.value)} placeholder="Existing test id" />
        <Button size="sm" variant="ghost" disabled={!draft.savedTestId} onClick={onOpenSavedTest} title="Open saved test">
          <FolderOpen className="h-4 w-4" />
        </Button>
      </div>
      <div className="rounded-md border bg-muted/40 p-2 text-[11px] text-muted-foreground">
        Recording captures runtime semantic inputs and advertised UI-click targets from this preview tab. Debug-only mutation controls are not recorded.
      </div>
      {recordingStale ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          Recording is using an older runtime snapshot. Restart with the latest project before recording if the new project edits should be included.
        </div>
      ) : null}
      {draft.replayError ? <div className="rounded-md border border-destructive/40 p-2 text-xs text-destructive">{draft.replayError}</div> : null}
      {draft.saveError ? <div className="rounded-md border border-destructive/40 p-2 text-xs text-destructive">{draft.saveError}</div> : null}
      {draft.savedTestId ? <div className="rounded-md border p-2 text-xs text-muted-foreground">Saved test: <span className="font-mono">{draft.savedTestId}</span></div> : null}
      <div className="space-y-1">
        <div className="text-xs font-medium">Actions</div>
        {draft.actions.length === 0 ? <div className="text-xs text-muted-foreground">No recorded player actions yet.</div> : null}
        {draft.actions.map((action, index) => (
          <div key={action.id} className="rounded-md border p-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span>{index + 1}. {recordedActionLabel(action)}</span>
              <Badge variant="outline">runtime-input</Badge>
            </div>
            <div className="mt-1 font-mono text-[11px] text-muted-foreground">{stringifyValue(action.input)}</div>
          </div>
        ))}
      </div>
      <div className="space-y-1">
        <div className="text-xs font-medium">Trace events</div>
        {draft.traceEvents.slice(0, 6).map((event) => (
          <div key={event.id} className="rounded-md border p-2 text-xs">
            <div className="flex items-center gap-2">
              <Badge variant={event.severity === 'error' ? 'destructive' : event.severity === 'warning' ? 'secondary' : 'outline'}>{event.severity}</Badge>
              <span>{event.label}</span>
            </div>
            {event.detail ? <div className="mt-1 font-mono text-[11px] text-muted-foreground">{event.detail}</div> : null}
          </div>
        ))}
      </div>
    </Panel>
  );
}

function CompiledProjectStaleWarning({ onReloadLatest, disabled }: { onReloadLatest: () => void; disabled: boolean }) {
  return (
    <div className="border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">Project changed since this Play session was loaded.</div>
          <div className="mt-0.5 text-[11px]">The running game is using an older runtime snapshot.</div>
        </div>
        <Button size="sm" variant="outline" className="h-7 shrink-0 bg-background/80" disabled={disabled} onClick={onReloadLatest}>
          Restart with Latest Project
        </Button>
      </div>
    </div>
  );
}

function RuntimeInspector({ state, project, controlsContext, compiledProjectState, canReloadLatestProject, mode, recorderDraft, targetTestId, onTargetTestIdChange, onModeChange, onCommand, onReloadLatestProject, onRecorderStart, onRecorderStop, onRecorderClear, onRecorderUndoLast, onRecorderReplay, onRecorderSaveNew, onRecorderApplyExisting, onOpenSavedTest }: { state: FullGamePreviewState; project: AuthoringProject | null; controlsContext: EnginePreviewControlsContext | null; compiledProjectState: FullGamePreviewCompiledProjectState; canReloadLatestProject: boolean; mode: FullGamePreviewMode; recorderDraft: RecordedTestDraft; targetTestId: string; onTargetTestIdChange: (value: string) => void; onModeChange: (mode: FullGamePreviewMode) => void; onCommand: (command: RuntimeCommandFactory, label: string, options?: RuntimeCommandOptions) => void; onReloadLatestProject: () => void; onRecorderStart: () => void; onRecorderStop: () => void; onRecorderClear: () => void; onRecorderUndoLast: () => void; onRecorderReplay: () => void; onRecorderSaveNew: () => void; onRecorderApplyExisting: () => void; onOpenSavedTest: () => void }) {
  const mutationDisabled = mode === 'recording';
  const runtimeDisabled = controlsContext?.connectionState !== 'ready';
  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-background">
      <div className="shrink-0 border-b bg-background px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold">Play Inspector</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {state.snapshot?.currentRoomId ? `In ${labelById(project, 'rooms', state.snapshot.currentRoomId)}` : 'Runtime tools and live state'}
            </div>
          </div>
          <div className="flex rounded-md border bg-muted/60 p-0.5" role="group" aria-label="Play inspector mode">
            <Button
              className={`h-7 px-2.5 ${mode === 'debug' ? 'bg-background text-foreground shadow-sm hover:bg-background' : 'text-muted-foreground'}`}
              size="sm"
              variant="ghost"
              aria-pressed={mode === 'debug'}
              onClick={() => onModeChange('debug')}
            >
              Debug
            </Button>
            <Button
              className={`h-7 px-2.5 ${mode === 'recording' ? 'bg-background text-foreground shadow-sm hover:bg-background' : 'text-muted-foreground'}`}
              size="sm"
              variant="ghost"
              aria-pressed={mode === 'recording'}
              onClick={() => onModeChange('recording')}
            >
              Recording
            </Button>
          </div>
        </div>
      </div>
      {compiledProjectState.freshness === 'stale' ? <CompiledProjectStaleWarning onReloadLatest={onReloadLatestProject} disabled={runtimeDisabled || !canReloadLatestProject} /> : null}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {mode === 'recording' ? (
          <RecorderPanel draft={recorderDraft} targetTestId={targetTestId} compiledProjectFreshness={compiledProjectState.freshness} onTargetTestIdChange={onTargetTestIdChange} onStart={onRecorderStart} onStop={onRecorderStop} onClear={onRecorderClear} onUndoLast={onRecorderUndoLast} onReplay={onRecorderReplay} onSaveNew={onRecorderSaveNew} onApplyExisting={onRecorderApplyExisting} onOpenSavedTest={onOpenSavedTest} />
        ) : null}
        <RuntimeSummaryPanel snapshot={state.snapshot} />
        <InputAvailabilityPanel snapshot={state.snapshot} project={project} controlsContext={controlsContext} onCommand={onCommand} />
        {mode === 'debug' ? (
          <>
            <VariablesPanel snapshot={state.snapshot} project={project} controlsContext={controlsContext} mutationDisabled={mutationDisabled} onCommand={onCommand} />
            <InventoryPanel snapshot={state.snapshot} project={project} controlsContext={controlsContext} mutationDisabled={mutationDisabled} onCommand={onCommand} />
            <RoomObjectToolsPanel snapshot={state.snapshot} project={project} controlsContext={controlsContext} mutationDisabled={mutationDisabled} onCommand={onCommand} />
            <SaveSnapshotPanel snapshot={state.snapshot} />
          </>
        ) : null}
        <EventLogPanel entries={state.eventLog} diagnostics={state.snapshot?.diagnostics ?? []} />
      </div>
    </aside>
  );
}

function FullGamePreviewTransportBar({ context, compiledProjectState, canReloadLatestProject, project, snapshot, onReloadLatestProject, onRuntimeCommand }: { context: EnginePreviewControlsContext; compiledProjectState: FullGamePreviewCompiledProjectState; canReloadLatestProject: boolean; project: AuthoringProject | null; snapshot: RuntimeDebugSnapshot | null; onReloadLatestProject: () => void; onRuntimeCommand: (command: RuntimeCommandFactory, label: string, options?: RuntimeCommandOptions) => void }) {
  const runtimeDisabled = context.connectionState !== 'ready';
  const currentRoom = snapshot?.currentRoomId
    ? { type: 'room', id: snapshot.currentRoomId, collection: 'rooms', label: project?.rooms[snapshot.currentRoomId]?.label } as RuntimeDebugEntityRef
    : null;
  const currentEntityIsCurrentRoom = snapshot?.currentEntity?.collection === 'rooms'
    && snapshot.currentEntity.id === snapshot.currentRoomId;

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
      <Button size="sm" variant="ghost" onClick={context.reload} aria-label="Reload engine preview">
        <RefreshCw className="h-4 w-4" />
      </Button>
      <Button size="sm" variant={compiledProjectState.freshness === 'stale' ? 'secondary' : 'ghost'} onClick={onReloadLatestProject} disabled={runtimeDisabled || !canReloadLatestProject} aria-label="Restart with latest project">
        <PackagePlus className="h-4 w-4" />
      </Button>
      <Button size="sm" variant="ghost" onClick={() => onRuntimeCommand(() => context.controller.runtimeReset(), 'Runtime reset')} disabled={runtimeDisabled} aria-label="Reset runtime">
        <RotateCcw className="h-4 w-4" />
      </Button>
      <Button size="sm" variant="outline" onClick={() => onRuntimeCommand(() => context.controller.fastForwardRuntimeToInput(), 'Fast-forward requested')} disabled={runtimeDisabled}>
        <FastForward className="h-4 w-4" />
        Fast-forward
      </Button>
      <div className="ml-auto flex min-w-0 items-center gap-1">
        <RuntimeEntityButton entity={snapshot?.currentEntity} project={project} label="Current entity" />
        {!currentEntityIsCurrentRoom ? <RuntimeEntityButton entity={currentRoom} project={project} label="Current room" /> : null}
      </div>
      <label className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
        Cap
        <Input className="h-7 w-16" type="number" min="0" max="1000" step="1" value={context.fpsCap} onChange={(event) => context.setFpsCap(sanitizePreviewFpsCap(Number(event.target.value)))} />
      </label>
    </div>
  );
}

export function FullGamePreviewEditor() {
  const projectDocument = useProjectStore((state) => state.document);
  const project = useMemo(() => isAuthoringProject(projectDocument) ? projectDocument : null, [projectDocument]);
  const executeCommand = useCommandStore((store) => store.executeCommand);
  const openTab = useWorkbenchStore((store) => store.openTab);
  const setPrimaryRuntimeReplay = usePreviewManagerStore((s) => s.setPrimaryRuntimeReplay);
  const [state, setState] = useState<FullGamePreviewState>({ snapshot: null, eventLog: [] });
  const [compiledProjectState, setCompiledProjectState] = useState<FullGamePreviewCompiledProjectState>({
    loadedCompiledProjectRevision: null,
    currentCompiledProjectRevision: null,
    freshness: 'not-loaded',
  });
  const [mode, setMode] = useState<FullGamePreviewMode>('debug');
  const [recorderDraft, setRecorderDraft] = useState<RecordedTestDraft>({ mode: 'idle', actions: [], traceEvents: [] });
  const [targetTestId, setTargetTestId] = useState('');
  const controlsRef = useRef<EnginePreviewControlsContext | null>(null);
  const staleWarningRevisionRef = useRef<string | null>(null);
  const exportedCompiledProject = useMemo(() => compiledProjectDiagnosticEntries(project), [project]);
  const canReloadLatestProject = exportedCompiledProject.ok && !!exportedCompiledProject.compiledProject;

  useEffect(() => {
    if (!targetTestId.trim() && recorderDraft.savedTestId) setTargetTestId(recorderDraft.savedTestId);
  }, [recorderDraft.savedTestId, targetTestId]);

  const requestDebugSnapshot = useCallback((context: EnginePreviewControlsContext | null) => {
    if (!context) return;
    void context.controller.requestRuntimeDebugSnapshot().catch((error: Error) => {
      setState((current) => ({
        ...current,
        eventLog: addLogEntry(current.eventLog, { label: error.message, severity: 'error' }),
      }));
    });
  }, []);

  const loadCompiledProjectIntoPreview = useCallback(async (context: EnginePreviewControlsContext | null = controlsRef.current) => {
    if (!context) return false;
    const exported = exportedCompiledProject;
    if (!exported.ok || !exported.compiledProject) {
      setState((current) => ({
        ...current,
        snapshot: null,
        eventLog: exported.entries.reduce(
          (entries, entry) => addLogEntry(entries, entry),
          addLogEntry(current.eventLog, { label: 'Runtime project not loaded', severity: 'warning' }),
        ),
      }));
      return false;
    }
    await context.controller.loadCompiledProject(
      exported.compiledProject,
      exported.previewAssets,
      exported.shaderMaterialMetadata,
    );
    setCompiledProjectState({
      loadedCompiledProjectRevision: exported.revision,
      currentCompiledProjectRevision: exported.revision,
      freshness: exported.revision ? 'fresh' : 'not-loaded',
    });
    staleWarningRevisionRef.current = null;
    setState((current) => ({
      ...current,
      eventLog: exported.entries.reduce(
        (entries, entry) => addLogEntry(entries, entry),
        addLogEntry(current.eventLog, { label: 'Runtime project loaded for Play tab', detail: project?.project.name, severity: exported.entries.length > 0 ? 'warning' : 'info' }),
      ),
    }));
    return true;
  }, [exportedCompiledProject, project?.project.name]);

  const replayActions = useCallback((actions: RecordedRuntimeAction[], successMode: RecordedTestDraft['mode'] = 'idle') => {
    const context = controlsRef.current;
    if (!context) {
      setRecorderDraft((current) => ({ ...current, mode: 'failed', replayError: 'Engine preview is not connected.' }));
      return;
    }

    const replay = async () => {
      await context.controller.runtimeReset();
      for (const action of actions) {
        await executeRecordedAction(action, context);
      }
      await context.controller.requestRuntimeDebugSnapshot();
    };

    setRecorderDraft((current) => ({ ...current, mode: 'replaying', replayError: undefined }));
    setState((current) => ({ ...current, eventLog: addLogEntry(current.eventLog, { label: `Replaying ${actions.length} recorded action${actions.length === 1 ? '' : 's'}`, severity: 'info' }) }));
    context.sendRuntimeCommand(
      replay()
        .then(() => {
          setRecorderDraft((current) => ({ ...current, mode: successMode, replayError: undefined }));
        })
        .catch((error: Error) => {
          setRecorderDraft((current) => ({
            ...current,
            mode: 'failed',
            replayError: error.message,
            traceEvents: addTraceEvent(current.traceEvents, { label: 'Replay failed', detail: error.message, severity: 'error' }),
          }));
          throw error;
        }),
      'Replay recorded actions',
    );
  }, []);

  const handleRuntimeCommand = useCallback((command: RuntimeCommandFactory, label: string, options: RuntimeCommandOptions = {}) => {
    setPrimaryRuntimeReplay({ position: useWorkspaceStore.getState().previewPosition });
    setState((current) => ({ ...current, eventLog: addLogEntry(current.eventLog, { label, severity: 'info' }) }));
    const recordedAction = options.recordedAction;
    if (recordedAction) {
      setRecorderDraft((current) => {
        if (current.mode !== 'recording') return current;
        return {
          ...current,
          actions: [...current.actions, recordedAction],
          replayError: undefined,
          traceEvents: addTraceEvent(current.traceEvents, { label: `Recorded ${recordedActionLabel(recordedAction)}`, detail: stringifyValue(recordedAction.input), severity: 'info' }),
        };
      });
    }
    controlsRef.current?.sendRuntimeCommand(
      command().then(() => requestDebugSnapshot(controlsRef.current)),
      label,
    );
  }, [requestDebugSnapshot, setPrimaryRuntimeReplay]);

  const handlePreviewMessage = useCallback((message: PreviewToEditorMessage) => {
    const logEntry = previewMessageLabel(message);
    setState((current) => ({
      snapshot: message.type === 'runtime-debug-snapshot' ? message.snapshot : message.type === 'runtime-fast-forward-result' ? message.result.finalSnapshot : current.snapshot,
      eventLog: logEntry ? addLogEntry(current.eventLog, logEntry) : current.eventLog,
    }));
    if (logEntry) {
      setRecorderDraft((current) => {
        if (current.mode === 'idle' && current.actions.length === 0) return current;
        return { ...current, traceEvents: addTraceEvent(current.traceEvents, logEntry) };
      });
    }
    if (message.type === 'ready') {
      void loadCompiledProjectIntoPreview(controlsRef.current).then(() => {
        requestDebugSnapshot(controlsRef.current);
      }).catch((error: Error) => {
        setState((current) => ({ ...current, eventLog: addLogEntry(current.eventLog, { label: error.message, severity: 'error' }) }));
      });
    } else if (message.type === 'preview-interacted' || message.type === 'object-clicked' || message.type === 'preview-object-selected') {
      requestDebugSnapshot(controlsRef.current);
    }
  }, [loadCompiledProjectIntoPreview, requestDebugSnapshot]);

  useEffect(() => {
    setCompiledProjectState((current) => {
      const freshness = current.loadedCompiledProjectRevision === null
        ? 'not-loaded'
        : exportedCompiledProject.revision === current.loadedCompiledProjectRevision
          ? 'fresh'
          : 'stale';
      return {
        ...current,
        currentCompiledProjectRevision: exportedCompiledProject.revision,
        freshness,
      };
    });
  }, [exportedCompiledProject.revision]);

  useEffect(() => {
    if (compiledProjectState.freshness !== 'stale') return;
    if (!compiledProjectState.currentCompiledProjectRevision) return;
    if (staleWarningRevisionRef.current === compiledProjectState.currentCompiledProjectRevision) return;
    staleWarningRevisionRef.current = compiledProjectState.currentCompiledProjectRevision;
    setState((current) => ({
      ...current,
      eventLog: addLogEntry(current.eventLog, {
        label: 'Project changed since this Play session was loaded',
        detail: 'The running game is using an older runtime snapshot.',
        severity: 'warning',
      }),
    }));
  }, [compiledProjectState.currentCompiledProjectRevision, compiledProjectState.freshness]);

  const reloadLatestCompiledProject = useCallback(() => {
    const context = controlsRef.current;
    if (!context || context.connectionState !== 'ready' || !canReloadLatestProject) return;
    void loadCompiledProjectIntoPreview(context).then((loaded) => {
      if (loaded) requestDebugSnapshot(context);
    }).catch((error: Error) => {
      setState((current) => ({ ...current, eventLog: addLogEntry(current.eventLog, { label: error.message, severity: 'error' }) }));
    });
  }, [canReloadLatestProject, loadCompiledProjectIntoPreview, requestDebugSnapshot]);

  const startRecording = useCallback(() => {
    setMode('recording');
    setRecorderDraft((current) => ({
      mode: 'recording',
      actions: current.mode === 'idle' ? [] : current.actions,
      traceEvents: addTraceEvent(current.traceEvents, { label: 'Recording started', severity: 'info' }),
      replayError: undefined,
    }));
    requestDebugSnapshot(controlsRef.current);
  }, [requestDebugSnapshot]);

  const stopRecording = useCallback(() => {
    setRecorderDraft((current) => ({ ...current, mode: 'idle', traceEvents: addTraceEvent(current.traceEvents, { label: 'Recording stopped', severity: 'info' }) }));
  }, []);

  const clearRecording = useCallback(() => {
    setRecorderDraft({ mode: 'idle', actions: [], traceEvents: [] });
  }, []);

  const undoLastRecordedAction = useCallback(() => {
    const actions = recorderDraft.actions.slice(0, -1);
    setRecorderDraft((current) => {
      return {
        ...current,
        actions,
        traceEvents: addTraceEvent(current.traceEvents, { label: 'Undo last recorded action', detail: `${actions.length} action${actions.length === 1 ? '' : 's'} remain`, severity: 'info' }),
        replayError: undefined,
      };
    });
    replayActions(actions, recorderDraft.mode === 'recording' ? 'recording' : 'idle');
  }, [recorderDraft.actions, recorderDraft.mode, replayActions]);

  const replayRecording = useCallback(() => {
    replayActions(recorderDraft.actions, 'idle');
  }, [recorderDraft.actions, replayActions]);

  const saveRecordingAsNewTest = useCallback(() => {
    const testId = nextRecordedTestId(project);
    const label = `Recorded Test ${new Date().toLocaleString()}`;
    const conversion = recordedTestDraftToTestData(recorderDraft, { label });
    if (!conversion.ok) {
      const message = conversion.diagnostics[0] ?? 'Recording has no saveable runtime semantic actions.';
      setRecorderDraft((current) => ({ ...current, saveError: message }));
      return;
    }
    const result = executeCommand({
      type: 'entity.createRecord',
      label: `Create recorded test ${testId}`,
      payload: { collection: 'tests', entityId: testId, label, data: conversion.data },
    });
    const failure = result.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    if (failure) {
      setRecorderDraft((current) => ({ ...current, saveError: failure.message }));
      return;
    }
    setTargetTestId(testId);
    setRecorderDraft((current) => ({
      ...current,
      savedTestId: testId,
      saveError: undefined,
      traceEvents: addTraceEvent(current.traceEvents, {
        label: `Saved recording as ${testId}`,
        detail: conversion.diagnostics.join('\n') || undefined,
        severity: conversion.skippedActionCount > 0 ? 'warning' : 'info',
      }),
    }));
    openTab(buildTestDetailTabForRecord(testId, label));
  }, [executeCommand, openTab, project, recorderDraft]);

  const applyRecordingToExistingTest = useCallback(() => {
    const testId = normalizeTestId(targetTestId);
    if (!testId) {
      setRecorderDraft((current) => ({ ...current, saveError: 'Enter an existing test id first.' }));
      return;
    }
    const record = project?.tests[testId];
    if (!record) {
      setRecorderDraft((current) => ({ ...current, saveError: `Test '${testId}' does not exist.` }));
      return;
    }
    const label = record.label || testId;
    const conversion = recordedTestDraftToTestData(recorderDraft, { label, base: parseTestData(record.data) ?? undefined });
    if (!conversion.ok) {
      const message = conversion.diagnostics[0] ?? 'Recording has no saveable runtime semantic actions.';
      setRecorderDraft((current) => ({ ...current, saveError: message }));
      return;
    }
    const result = executeCommand({
      type: 'test.replaceData',
      label: `Apply recording to ${testId}`,
      payload: { testId, data: conversion.data },
    });
    const failure = result.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    if (failure) {
      setRecorderDraft((current) => ({ ...current, saveError: failure.message }));
      return;
    }
    setTargetTestId(testId);
    setRecorderDraft((current) => ({
      ...current,
      savedTestId: testId,
      saveError: undefined,
      traceEvents: addTraceEvent(current.traceEvents, {
        label: `Applied recording to ${testId}`,
        detail: conversion.diagnostics.join('\n') || undefined,
        severity: conversion.skippedActionCount > 0 ? 'warning' : 'info',
      }),
    }));
    openTab(buildTestDetailTabForRecord(testId, label));
  }, [executeCommand, openTab, project, recorderDraft, targetTestId]);

  const openSavedTest = useCallback(() => {
    const testId = recorderDraft.savedTestId;
    if (!testId) return;
    const record = project?.tests[testId];
    openTab(buildTestDetailTabForRecord(testId, record?.label || testId));
  }, [openTab, project, recorderDraft.savedTestId]);

  return (
    <Group orientation="horizontal" className="h-full min-h-0 bg-background">
      <ResizePanel id="full-game-preview-canvas" minSize="420px">
        <div className="h-full min-w-0">
        <EnginePreview
          onPreviewMessage={handlePreviewMessage}
          renderControls={(context) => {
            controlsRef.current = context;
            return <FullGamePreviewTransportBar context={context} compiledProjectState={compiledProjectState} canReloadLatestProject={canReloadLatestProject} project={project} snapshot={state.snapshot} onReloadLatestProject={reloadLatestCompiledProject} onRuntimeCommand={handleRuntimeCommand} />;
          }}
        />
        </div>
      </ResizePanel>
      <PanelResizeSeparator orientation="horizontal" aria-label="Resize Play Inspector" />
      <ResizePanel id="full-game-preview-inspector" defaultSize="300px" minSize="260px" maxSize="55%">
        <RuntimeInspector
          state={state}
          project={project}
          controlsContext={controlsRef.current}
          compiledProjectState={compiledProjectState}
          canReloadLatestProject={canReloadLatestProject}
          mode={mode}
          recorderDraft={recorderDraft}
          targetTestId={targetTestId}
          onTargetTestIdChange={setTargetTestId}
          onModeChange={setMode}
          onCommand={handleRuntimeCommand}
          onReloadLatestProject={reloadLatestCompiledProject}
          onRecorderStart={startRecording}
          onRecorderStop={stopRecording}
          onRecorderClear={clearRecording}
          onRecorderUndoLast={undoLastRecordedAction}
          onRecorderReplay={replayRecording}
          onRecorderSaveNew={saveRecordingAsNewTest}
          onRecorderApplyExisting={applyRecordingToExistingTest}
          onOpenSavedTest={openSavedTest}
        />
      </ResizePanel>
    </Group>
  );
}
