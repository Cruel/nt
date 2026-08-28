import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel as ResizePanel } from 'react-resizable-panels';
import {
  AlertCircle,
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
import {
  EnginePreview,
  sanitizePreviewFpsCap,
  type EnginePreviewControlsContext,
} from '@/components/engine-preview';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { PanelResizeSeparator } from '@/components/resize-separator';
import { useProjectStore } from '@/project/project-store';
import { useCommandStore } from '@/commands/command-store';
import { resolveProjectDiagnosticTarget } from '@/diagnostics/diagnostic-navigation';
import { MUTATION_SURFACE_ATTRIBUTIONS } from '@/project/save-unit-registry';
import { buildDefaultRecordTab, buildTestDetailTabForRecord } from '@/workbench/editor-registry';
import { navigateToWorkbenchTarget } from '@/workbench/workbench-navigation';
import { useAssetProfilerPolling } from '@/asset-profiler/use-asset-profiler-polling';
import { usePendingInputStore } from '@/workbench/pending-input-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { visualForCollection } from '@/workspace/collection-visuals';
import { SearchSelectorDialog } from '@/workspace/SearchSelectorDialog';
import { buildCommandPaletteItems, filterSelectorItems } from '@/workspace/command-palette-search';
import {
  authoringCollectionMetadata,
  isAuthoringCollectionKey,
} from '../../../shared/project-schema/authoring-collections';
import { selectedExportProfile } from '../../../shared/project-schema/authoring-export';
import {
  isAuthoringProject,
  type AuthoringProject,
  type AuthoringRecordBase,
} from '../../../shared/project-schema/authoring-project';
import { prepareRuntimeArtifact } from '../../../shared/runtime-artifact-preparation';
import { rendererRuntimeArtifactPaths } from '../../export/runtime-artifact-adapters';
import {
  collectProjectValidationDiagnostics,
  type ProjectValidationDiagnostic,
} from '../../../shared/project-schema/project-validation';
import { parseTestData } from '../../../shared/project-schema/authoring-tests';
import {
  parseVariableData,
  parseVariableValueText,
  variableValueToText,
} from '../../../shared/project-schema/authoring-variables';
import {
  recordedTestDraftToTestData,
  type RecordedRuntimeInputKind,
} from '../../../shared/project-schema/recorded-test-draft';
import type {
  PreviewInteractionSubject,
  RuntimeDebugEntityRef,
  RuntimeDebugSnapshot,
  PreviewToEditorMessage,
  RuntimeFastForwardResult,
} from '../../../shared/preview-protocol';
import {
  analyzeConcreteInteractionResolution,
  analyzeSubjectOffers,
  type ResolverSubjectSnapshot,
} from '../../../shared/interaction-resolver-analysis';

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
    edgeId?: string;
    optionId?: string;
    exitId?: string;
    subjects?: PreviewInteractionSubject[];
    subject?: PreviewInteractionSubject;
    verbId?: string;
    bindings?: Array<{ slotId: string; subject: PreviewInteractionSubject }>;
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
  loadedSourceFingerprint: string | null;
  currentSourceFingerprint: string | null;
  freshness: CompiledProjectFreshness;
}

function fallbackLabel(id: string | undefined, label: string | undefined) {
  return label || id || '—';
}

function recordFor(
  project: AuthoringProject | null,
  collection: keyof Pick<
    AuthoringProject,
    | 'variables'
    | 'rooms'
    | 'interactables'
    | 'verbs'
    | 'interactions'
    | 'maps'
    | 'dialogues'
    | 'scenes'
  >,
  id: string | undefined,
): AuthoringRecordBase | null {
  if (!project || !id) return null;
  return project[collection][id] ?? null;
}

function entityCollection(
  ref: RuntimeDebugEntityRef | undefined,
):
  | keyof Pick<
      AuthoringProject,
      | 'variables'
      | 'rooms'
      | 'interactables'
      | 'verbs'
      | 'interactions'
      | 'maps'
      | 'dialogues'
      | 'scenes'
    >
  | null {
  if (!ref) return null;
  if (
    ref.collection === 'variables' ||
    ref.collection === 'rooms' ||
    ref.collection === 'verbs' ||
    ref.collection === 'maps' ||
    ref.collection === 'dialogues' ||
    ref.collection === 'scenes'
  )
    return ref.collection;
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

function labelById(
  project: AuthoringProject | null,
  collection: keyof Pick<
    AuthoringProject,
    'variables' | 'rooms' | 'interactables' | 'verbs' | 'interactions'
  >,
  id: string,
) {
  return fallbackLabel(id, recordFor(project, collection, id)?.label);
}

function stringifyValue(value: unknown) {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return 'Unserializable value';
  }
}

function addLogEntry(
  entries: RuntimeLogEntry[],
  entry: Omit<RuntimeLogEntry, 'id'>,
): RuntimeLogEntry[] {
  return [{ ...entry, id: `${Date.now()}-${entries.length}` }, ...entries].slice(0, 80);
}

function addTraceEvent(
  events: RecorderTraceEvent[],
  entry: Omit<RecorderTraceEvent, 'id' | 'capturedAt'>,
): RecorderTraceEvent[] {
  return [
    { ...entry, id: crypto.randomUUID(), capturedAt: new Date().toISOString() },
    ...events,
  ].slice(0, 120);
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
  if (result.reason === 'budget-exhausted' || result.reason === 'stabilization-limit')
    return 'warning';
  return 'info';
}

function previewMessageLabel(message: PreviewToEditorMessage): Omit<RuntimeLogEntry, 'id'> | null {
  if (message.type === 'runtime-debug-snapshot') {
    return {
      label: 'Runtime snapshot refreshed',
      detail: message.snapshot.waiting.reason ?? message.snapshot.waiting.kind,
      severity: 'info',
    };
  }
  if (message.type === 'runtime-fast-forward-result') {
    return {
      label: 'Fast-forward stopped',
      detail: fastForwardDetail(message.result),
      severity: fastForwardSeverity(message.result),
    };
  }
  if (message.type === 'runtime-debug-event') {
    const detail = [
      message.event.kind,
      message.event.target?.id,
      `old=${stringifyValue(message.event.oldValue)}`,
      `new=${stringifyValue(message.event.newValue)}`,
    ]
      .filter(Boolean)
      .join(' · ');
    return {
      label: `Debug-only mutation: ${message.event.label}`,
      detail,
      severity: message.event.rejected ? 'warning' : 'info',
    };
  }
  if (message.type === 'preview-diagnostic') {
    return {
      label: message.diagnostic.message,
      detail: message.diagnostic.path,
      severity: message.diagnostic.severity,
    };
  }
  if (message.type === 'runtime-error') return { label: message.message, severity: 'error' };
  if (message.type === 'object-clicked')
    return { label: 'Object clicked', detail: message.objectId, severity: 'info' };
  if (message.type === 'preview-object-selected')
    return { label: 'Preview object selected', detail: message.objectId, severity: 'info' };
  if (message.type === 'preview-interacted')
    return { label: 'Preview interaction', detail: message.interaction, severity: 'info' };
  if (message.type === 'fps-counter') return null;
  if (message.type === 'command-result') return null;
  return null;
}

function subjectText(subject: PreviewInteractionSubject) {
  return subject.kind === 'feature'
    ? `feature:${subject.ownerKind}:${subject.ownerId}:${subject.featureId}`
    : `${subject.kind}:${subject.id}`;
}

function resolverSubject(subject: PreviewInteractionSubject): ResolverSubjectSnapshot {
  if (subject.kind === 'feature')
    return {
      kind: 'feature',
      identity: `${subject.ownerKind}:${subject.ownerId}#${subject.featureId}`,
    };
  return { kind: subject.kind, identity: subject.id };
}

function recordedActionLabel(action: RecordedRuntimeAction) {
  switch (action.kind) {
    case 'continue':
      return 'Continue';
    case 'dialogue-choice':
      return `Dialogue choice ${action.input.edgeId ?? '—'}`;
    case 'scene-choice':
      return `Scene choice ${action.input.optionId ?? '—'}`;
    case 'navigate':
      return `Navigate ${action.input.exitId ?? '—'}`;
    case 'select-subjects':
      return `Select ${action.input.subjects?.map(subjectText).join(', ') || 'subjects'}`;
    case 'primary-activate':
      return `Primary Activate ${action.input.subject ? subjectText(action.input.subject) : 'subject'}`;
    case 'open-verb-menu':
      return `Open Verb Menu ${action.input.subject ? subjectText(action.input.subject) : 'subject'}`;
    case 'clear-subject-selection':
      return 'Clear subject selection';
    case 'run-interaction':
      return `Run ${action.input.verbId ?? 'interaction'}`;
    default:
      return action.label;
  }
}

function createRecordedAction(
  kind: RecordedRuntimeInputKind,
  label: string,
  input: RecordedRuntimeAction['input'],
): RecordedRuntimeAction {
  return { id: crypto.randomUUID(), kind, label, input, recordedAt: new Date().toISOString() };
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

async function compiledProjectDiagnosticEntries(
  project: AuthoringProject | null,
  recoveryFingerprint: unknown,
): Promise<{
  compiledProject: unknown;
  shaderMaterialMetadata: unknown;
  previewAssets: Array<{ sourcePath: string; runtimePath: string }>;
  sourceFingerprint: string | null;
  blockers: ProjectValidationDiagnostic[];
  entries: Omit<RuntimeLogEntry, 'id'>[];
  ok: boolean;
}> {
  if (!project) {
    return {
      ok: false,
      compiledProject: null,
      shaderMaterialMetadata: null,
      previewAssets: [],
      sourceFingerprint: null,
      blockers: [],
      entries: [
        {
          label: 'No project is open',
          detail: 'Open or create a project before using the Play tab.',
          severity: 'warning',
        },
      ],
    };
  }
  const prepared = await prepareRuntimeArtifact({
    project,
    projectRoot: null,
    profile: selectedExportProfile(project),
    intent: 'play',
    recoveryFingerprint,
    paths: rendererRuntimeArtifactPaths,
  });
  if (prepared.status === 'cancelled') {
    return {
      ok: false,
      compiledProject: null,
      shaderMaterialMetadata: null,
      previewAssets: [],
      sourceFingerprint: null,
      blockers: prepared.diagnostics,
      entries: prepared.diagnostics.map((diagnostic) => ({
        label: diagnostic.message,
        detail: diagnostic.path,
        severity: diagnostic.severity,
      })),
    };
  }
  const exported = prepared.assessment;
  const diagnostics = collectProjectValidationDiagnostics(exported.runtimeDiagnostics);
  const entries = diagnostics.slice(0, 6).map((diagnostic) => ({
    label: diagnostic.message,
    detail: diagnostic.path,
    severity: diagnostic.severity,
  }));
  return {
    ok: prepared.status === 'prepared',
    compiledProject: exported.compiledProject ?? null,
    shaderMaterialMetadata: exported.shaderMaterialMetadata ?? null,
    previewAssets: exported.fileEntries.map((entry) => ({
      sourcePath: entry.source,
      runtimePath: entry.packagePath,
    })),
    sourceFingerprint: exported.sourceFingerprint,
    blockers: exported.runtimeBlockers,
    entries,
  };
}

function executeRecordedAction(
  action: RecordedRuntimeAction,
  context: EnginePreviewControlsContext,
) {
  switch (action.input.type) {
    case 'continue':
      return context.controller.continueRuntime();
    case 'dialogue-choice':
      return context.controller.selectDialogueChoice(action.input.edgeId ?? '');
    case 'scene-choice':
      return context.controller.selectSceneChoice(action.input.optionId ?? '');
    case 'navigate':
      return context.controller.navigateRuntime(action.input.exitId ?? '');
    case 'select-subjects':
      return context.controller.selectRuntimeSubjects(action.input.subjects ?? []);
    case 'primary-activate':
      return action.input.subject
        ? context.controller.primaryActivateRuntimeSubject(action.input.subject)
        : Promise.resolve();
    case 'open-verb-menu':
      return action.input.subject
        ? context.controller.openRuntimeVerbMenu(action.input.subject)
        : Promise.resolve();
    case 'clear-subject-selection':
      return context.controller.clearRuntimeSubjectSelection();
    case 'run-interaction':
      return context.controller.runRuntimeInteraction(
        action.input.verbId ?? '',
        action.input.bindings ?? [],
      );
  }
}

function InfoRow({
  label,
  value,
}: {
  label: string;
  value: string | number | boolean | undefined | null;
}) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="max-w-40 truncate text-right font-medium">
        {value === undefined || value === null || value === '' ? '—' : String(value)}
      </span>
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
        {summary ? (
          <span className="truncate text-[11px] text-muted-foreground">{summary}</span>
        ) : null}
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${open ? '' : '-rotate-90'}`}
        />
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
      summary={
        snapshot
          ? `${snapshot.running ? 'Running' : 'Stopped'} · ${snapshot.waiting.kind}`
          : 'No snapshot'
      }
      defaultOpen
    >
      <div className="flex flex-wrap gap-1">
        <Badge variant={snapshot?.loaded ? 'default' : 'secondary'}>
          {snapshot?.loaded ? 'Loaded' : 'Unloaded'}
        </Badge>
        <Badge variant={snapshot?.running ? 'default' : 'secondary'}>
          {snapshot?.running ? 'Running' : 'Stopped'}
        </Badge>
        <Badge variant={snapshot?.waiting.kind === 'error' ? 'destructive' : 'outline'}>
          {snapshot?.waiting.kind ?? 'No snapshot'}
        </Badge>
      </div>
      <div className="space-y-1">
        <InfoRow label="Waiting reason" value={snapshot?.waiting.reason} />
        <InfoRow
          label="Publication"
          value={snapshot ? `${snapshot.publication.revision}` : undefined}
        />
        <InfoRow
          label="Presentation"
          value={snapshot ? `${snapshot.publication.presentationRevision}` : undefined}
        />
        <InfoRow
          label="Desired state"
          value={
            snapshot
              ? `${snapshot.publication.actorCount} actors · ${snapshot.publication.layoutCount} layouts · ${snapshot.publication.desiredAudioCount} audio`
              : undefined
          }
        />
      </div>
    </Panel>
  );
}

function RuntimeEntityButton({
  entity,
  project,
  label,
}: {
  entity: RuntimeDebugEntityRef | null | undefined;
  project: AuthoringProject | null;
  label: string;
}) {
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

function ResolverAnalysisPanel({
  snapshot,
  project,
}: {
  snapshot: RuntimeDebugSnapshot | null;
  project: AuthoringProject | null;
}) {
  const inputs = snapshot?.availableInputs;
  const selected = inputs?.selectedSubjects ?? [];
  const variables = (snapshot?.variables ?? []).map((variable) => ({
    id: variable.id,
    value: variable.value,
  }));
  const subject = selected[0] ? resolverSubject(selected[0]) : null;
  const offers = project && subject ? analyzeSubjectOffers(project, subject, variables) : [];
  const liveOfferEntries = inputs?.verbOffers ?? [];
  const liveOffers = new Set(liveOfferEntries.map((offer) => offer.verbId));
  const livePrimary = liveOfferEntries.filter((offer) => offer.primary);
  const resolutions =
    project && inputs
      ? inputs.actions
          .filter(
            (action) =>
              action.selectedCount === action.bindingOrder.length &&
              action.bindingOrder.length <= inputs.selectedSubjects.length,
          )
          .map((action) => ({
            action,
            analysis: analyzeConcreteInteractionResolution(
              project,
              action.verbId,
              action.bindingOrder.map((slotId, index) => ({
                slotId,
                subject: resolverSubject(inputs.selectedSubjects[index]!),
              })),
              variables,
            ),
          }))
      : [];
  return (
    <Panel
      title="Interaction resolver"
      icon={<Binary className="h-3.5 w-3.5" />}
      summary={subject ? subjectText(selected[0]!) : 'Select a subject'}
      defaultOpen={false}
    >
      {!project || !subject ? (
        <div className="text-xs text-muted-foreground">
          Select or open the Verb menu for a subject to inspect Offer discovery in this live state.
        </div>
      ) : (
        <div className="space-y-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span>
              <span className="font-medium">Subject:</span> {subjectText(selected[0]!)}
            </span>
            <Badge variant={livePrimary.length > 1 ? 'destructive' : 'outline'}>
              {livePrimary.length > 1
                ? `Primary ambiguous (${livePrimary.length})`
                : livePrimary.length === 1 &&
                    livePrimary[0]!.bindingOrder.length === 1 &&
                    livePrimary[0]!.bindingOrder[0] === livePrimary[0]!.slotId
                  ? `Primary executable: ${labelById(project, 'verbs', livePrimary[0]!.verbId)}`
                  : livePrimary.length === 1
                    ? 'Primary requires menu completion'
                    : 'No live primary Offer'}
            </Badge>
          </div>
          {offers
            .filter((entry) => entry.candidates.length > 0 || liveOffers.has(entry.verbId))
            .map((entry) => (
              <div className="rounded border p-2" key={entry.verbId}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{labelById(project, 'verbs', entry.verbId)}</span>
                  <Badge variant={liveOffers.has(entry.verbId) ? 'default' : 'outline'}>
                    {liveOffers.has(entry.verbId) ? 'Live Offer' : 'No live Offer'}
                  </Badge>
                  <Badge variant="secondary">{entry.primaryStatus}</Badge>
                  {entry.availability === 'unknown' && (
                    <Badge variant="secondary">Availability ?</Badge>
                  )}
                </div>
                <div className="mt-1 space-y-1 text-muted-foreground">
                  {entry.candidates.map((candidate) => (
                    <div key={candidate.sourceId}>
                      <code>{candidate.sourceId}</code> · tier {candidate.specificity.tier}
                      {candidate.specificity.detail ? `.${candidate.specificity.detail}` : ''} ·
                      rank {candidate.rank} · condition {candidate.condition}
                      {candidate.sourceId === entry.winner?.sourceId
                        ? entry.winnerStatus === 'yes'
                          ? ' · winner'
                          : entry.winnerStatus === 'unknown'
                            ? ' · conditional winner'
                            : ' · structural winner suppressed by condition/availability'
                        : candidate.shadowedBy
                          ? ` · shadowed by ${candidate.shadowedBy}`
                          : ''}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          {resolutions.map(({ action, analysis }) => (
            <div className="rounded border p-2" key={`resolution:${action.verbId}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">
                  Resolve {labelById(project, 'verbs', action.verbId)}
                </span>
                <Badge variant={analysis.ambiguity.length ? 'destructive' : 'outline'}>
                  {analysis.winner
                    ? `Winner ${analysis.winner}`
                    : analysis.ambiguity.length
                      ? 'Ambiguous'
                      : analysis.fallback === 'conditional'
                        ? 'Conditional'
                        : 'Verb default'}
                </Badge>
                {analysis.uncertainty && <Badge variant="secondary">Runtime-dependent</Badge>}
              </div>
              <div className="mt-1 space-y-1 text-muted-foreground">
                {analysis.candidates.map((candidate) => (
                  <div key={`${candidate.interactionId}:${candidate.ruleId}`}>
                    <code>
                      {candidate.interactionId}:{candidate.ruleId}
                    </code>{' '}
                    · tier {candidate.tier ?? 'shadowed'} · priority {candidate.priority} · match{' '}
                    {candidate.match} · Guard {candidate.guard} · {candidate.status}
                    {candidate.shadowedBy ? ` by ${candidate.shadowedBy}` : ''}
                  </div>
                ))}
                {analysis.ambiguity.length > 0 && (
                  <div>Equal-ranked conflict: {analysis.ambiguity.join(', ')}</div>
                )}
                <div>
                  Fallback: {analysis.fallback}. An unhandled rule falls through to the Verb
                  default, then Project undefined-Interaction behavior when configured.
                </div>
              </div>
            </div>
          ))}
          {offers.every(
            (entry) => entry.candidates.length === 0 && !liveOffers.has(entry.verbId),
          ) &&
            resolutions.length === 0 && (
              <div className="text-muted-foreground">No matching Offers or complete commands.</div>
            )}
          <div className="text-muted-foreground">
            Live Offer and primary-status badges come from the native runtime snapshot. Complete
            command tiers, Guards, ambiguity, and fallback appear once every Verb slot is selected.
            Lua predicates and facts unavailable to static tooling remain conditional rather than
            being guessed.
          </div>
        </div>
      )}
    </Panel>
  );
}

function InputAvailabilityPanel({
  snapshot,
  project,
  controlsContext,
  onCommand,
}: {
  snapshot: RuntimeDebugSnapshot | null;
  project: AuthoringProject | null;
  controlsContext: EnginePreviewControlsContext | null;
  onCommand: (
    command: RuntimeCommandFactory,
    label: string,
    options?: RuntimeCommandOptions,
  ) => void;
}) {
  const controller = controlsContext?.controller ?? null;
  const inputs = snapshot?.availableInputs;
  const semanticTargets = inputs?.clickableTargets ?? [];
  return (
    <Panel
      title="Player input"
      icon={<StepForward className="h-3.5 w-3.5" />}
      summary={
        inputs
          ? `${inputs.choices.length + inputs.navigation.length + inputs.actions.length + semanticTargets.length + (inputs.continue ? 1 : 0)} available`
          : 'None'
      }
      defaultOpen
    >
      {inputs?.choices.map((option) => (
        <Button
          key={`${option.kind}:${option.id}`}
          size="sm"
          variant="outline"
          className="w-full justify-start"
          disabled={!option.enabled || !controller}
          onClick={() =>
            controller &&
            onCommand(
              () =>
                option.kind === 'dialogue'
                  ? controller.selectDialogueChoice(option.id)
                  : controller.selectSceneChoice(option.id),
              `${option.kind === 'dialogue' ? 'Dialogue' : 'Scene'} choice ${option.id} sent`,
              {
                recordedAction:
                  option.kind === 'dialogue'
                    ? createRecordedAction('dialogue-choice', option.label, {
                        type: 'dialogue-choice',
                        edgeId: option.id,
                      })
                    : createRecordedAction('scene-choice', option.label, {
                        type: 'scene-choice',
                        optionId: option.id,
                      }),
              },
            )
          }
        >
          {option.kind === 'dialogue' ? 'Dialogue' : 'Scene'} choice {option.id}: {option.label}
        </Button>
      ))}
      {inputs?.navigation.map((direction) => (
        <Button
          key={direction.exitId}
          size="sm"
          variant="outline"
          className="w-full justify-start"
          disabled={!direction.enabled || !controller}
          onClick={() =>
            controller &&
            onCommand(
              () => controller.navigateRuntime(direction.exitId),
              `Navigate ${direction.label} sent`,
              {
                recordedAction: createRecordedAction('navigate', direction.label, {
                  type: 'navigate',
                  exitId: direction.exitId,
                }),
              },
            )
          }
        >
          Navigate {direction.label}
        </Button>
      ))}
      {inputs?.actions.map((action) => (
        <Button
          key={action.verbId}
          size="sm"
          variant="outline"
          className="w-full justify-start"
          disabled={!action.enabled || !controller}
          onClick={() =>
            controller &&
            onCommand(
              () =>
                controller.runRuntimeInteraction(
                  action.verbId,
                  action.bindingOrder.map((slotId, index) => ({
                    slotId,
                    subject: inputs.selectedSubjects[index]!,
                  })),
                ),
              `Interaction ${action.verbId} sent`,
              {
                recordedAction: createRecordedAction(
                  'run-interaction',
                  action.label || action.verbId,
                  {
                    type: 'run-interaction',
                    verbId: action.verbId,
                    bindings: action.bindingOrder.map((slotId, index) => ({
                      slotId,
                      subject: inputs.selectedSubjects[index]!,
                    })),
                  },
                ),
              },
            )
          }
        >
          {labelById(project, 'verbs', action.verbId)} ({action.selectedCount}/
          {action.bindingOrder.length})
        </Button>
      ))}
      {semanticTargets.map((target, index) =>
        target.kind === 'subject' ? (
          <div className="flex gap-2" key={`subject:${subjectText(target.subject)}:${index}`}>
            <Button
              size="sm"
              variant="outline"
              className="flex-1 justify-start"
              disabled={!controller}
              onClick={() => {
                if (!controller) return;
                onCommand(
                  () => controller.primaryActivateRuntimeSubject(target.subject),
                  `Primary Activate ${subjectText(target.subject)}`,
                  {
                    recordedAction: createRecordedAction('primary-activate', target.label, {
                      type: 'primary-activate',
                      subject: target.subject,
                    }),
                  },
                );
              }}
            >
              Activate {target.label}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!controller}
              onClick={() => {
                if (!controller) return;
                onCommand(
                  () => controller.openRuntimeVerbMenu(target.subject),
                  `Open Verb Menu ${subjectText(target.subject)}`,
                  {
                    recordedAction: createRecordedAction('open-verb-menu', target.label, {
                      type: 'open-verb-menu',
                      subject: target.subject,
                    }),
                  },
                );
              }}
            >
              Menu
            </Button>
          </div>
        ) : (
          <Button
            key={`exit:${target.exitId}:${index}`}
            size="sm"
            variant="outline"
            className="w-full justify-start"
            disabled={!controller}
            onClick={() => {
              if (!controller) return;
              onCommand(
                () => controller.navigateRuntime(target.exitId),
                `Navigate ${target.exitId} sent`,
                {
                  recordedAction: createRecordedAction('navigate', target.label, {
                    type: 'navigate',
                    exitId: target.exitId,
                  }),
                },
              );
            }}
          >
            Navigate {target.label}
          </Button>
        ),
      )}
    </Panel>
  );
}

function parseDebugVariableDraft(
  type: string | undefined,
  text: string,
  enumValues?: readonly string[],
) {
  if (
    type === 'boolean' ||
    type === 'integer' ||
    type === 'number' ||
    type === 'string' ||
    type === 'enum'
  ) {
    return parseVariableValueText(type, text, enumValues);
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
  onCommand: (
    command: RuntimeCommandFactory,
    label: string,
    options?: RuntimeCommandOptions,
  ) => void;
}) {
  const record = recordFor(project, 'variables', variable.id);
  const data = record ? parseVariableData(record.data) : null;
  const [draft, setDraft] = useState(variableValueToText(variable.value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(variableValueToText(variable.value));
  }, [editing, variable.value]);
  const parsed = parseDebugVariableDraft(data?.type ?? variable.type, draft, data?.enumValues);
  const controller = controlsContext?.controller ?? null;
  const disabled = mutationDisabled || !controller;
  const type = data?.type ?? variable.type;
  const TypeIcon = variableTypeIcon(type);
  const label = fallbackLabel(variable.id, record?.label ?? variable.label);
  const defaultValue = data?.value ?? variable.defaultValue;
  const commit = () => {
    if (!controller || !parsed.ok || disabled) return;
    onCommand(
      () => controller.setRuntimeVariable(variable.id, parsed.value),
      `Debug set ${variable.id}`,
    );
    setEditing(false);
  };
  const cancel = () => {
    setDraft(variableValueToText(variable.value));
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
            {(data?.enumValues ?? []).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="shrink-0"
            onClick={cancel}
            aria-label={`Cancel editing ${label}`}
          >
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
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="shrink-0"
          onClick={cancel}
          aria-label={`Cancel editing ${label}`}
        >
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
          <TooltipTrigger
            render={
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground" />
            }
          >
            <TypeIcon className="h-3.5 w-3.5" />
          </TooltipTrigger>
          <TooltipContent
            side="left"
            align="center"
            sideOffset={8}
            className="block max-w-72 space-y-1"
          >
            <div>
              <span className="font-medium">Type:</span> {type ?? 'unknown'}
            </div>
            <div>
              <span className="font-medium">Default:</span>{' '}
              <span className="font-mono">{stringifyValue(defaultValue)}</span>
            </div>
            <div>
              <span className="font-medium">ID:</span>{' '}
              <span className="font-mono">{variable.id}</span>
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <span className="min-w-0 flex-1 truncate font-medium" title={`${label} (${variable.id})`}>
        {label}
      </span>
      {variable.dirty || variable.overridden ? (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
          title="Changed from default"
        />
      ) : null}
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
            <span
              className="min-w-0 max-w-[45%] truncate font-mono text-muted-foreground"
              title={variableValueToText(variable.value)}
            >
              {variableValueToText(variable.value)}
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
                if (controller)
                  onCommand(
                    () => controller.resetRuntimeVariable(variable.id),
                    `Debug reset ${variable.id}`,
                  );
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

function VariablesPanel({
  snapshot,
  project,
  controlsContext,
  mutationDisabled,
  onCommand,
}: {
  snapshot: RuntimeDebugSnapshot | null;
  project: AuthoringProject | null;
  controlsContext: EnginePreviewControlsContext | null;
  mutationDisabled: boolean;
  onCommand: (
    command: RuntimeCommandFactory,
    label: string,
    options?: RuntimeCommandOptions,
  ) => void;
}) {
  const variables = useMemo(() => snapshot?.variables ?? [], [snapshot?.variables]);
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const filteredVariables = useMemo(() => {
    if (!normalizedQuery) return variables;
    return variables.filter((variable) => {
      const record = recordFor(project, 'variables', variable.id);
      const label = fallbackLabel(variable.id, record?.label ?? variable.label);
      return [variable.id, label, variable.type, variableValueToText(variable.value)].some(
        (value) => String(value).toLowerCase().includes(normalizedQuery),
      );
    });
  }, [normalizedQuery, project, variables]);
  return (
    <Panel
      title="Variables"
      icon={<Database className="h-3.5 w-3.5" />}
      summary={`${variables.length}`}
    >
      {variables.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          No runtime variables in the latest snapshot.
        </div>
      ) : null}
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
            {filteredVariables.map((variable) => (
              <VariableDebugRow
                key={variable.id}
                variable={variable}
                project={project}
                controlsContext={controlsContext}
                mutationDisabled={mutationDisabled}
                onCommand={onCommand}
              />
            ))}
            {filteredVariables.length === 0 ? (
              <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                No matching variables.
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

function InventoryPanel({
  snapshot,
  project,
  controlsContext,
  mutationDisabled,
  onCommand,
}: {
  snapshot: RuntimeDebugSnapshot | null;
  project: AuthoringProject | null;
  controlsContext: EnginePreviewControlsContext | null;
  mutationDisabled: boolean;
  onCommand: (
    command: RuntimeCommandFactory,
    label: string,
    options?: RuntimeCommandOptions,
  ) => void;
}) {
  const inventory = snapshot?.inventory ?? [];
  const objectIds = useMemo(() => (project ? Object.keys(project.interactables) : []), [project]);
  const [selectedObjectId, setSelectedObjectId] = useState('');
  useEffect(() => {
    if (!selectedObjectId && objectIds[0]) setSelectedObjectId(objectIds[0]);
    else if (selectedObjectId && !objectIds.includes(selectedObjectId))
      setSelectedObjectId(objectIds[0] ?? '');
  }, [objectIds, selectedObjectId]);
  const controller = controlsContext?.controller ?? null;
  const disabled = mutationDisabled || !controller;
  return (
    <Panel
      title="Inventory"
      icon={<PackagePlus className="h-3.5 w-3.5" />}
      summary={`${inventory.length}`}
    >
      <div className="flex gap-2">
        <select
          className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs"
          value={selectedObjectId}
          onChange={(event) => setSelectedObjectId(event.target.value)}
          aria-label="Debug object to give"
        >
          {objectIds.map((id) => (
            <option key={id} value={id}>
              {labelById(project, 'interactables', id)} ({id})
            </option>
          ))}
        </select>
        <Button
          className="!h-7 shrink-0"
          size="sm"
          variant="secondary"
          disabled={disabled || !selectedObjectId}
          onClick={() =>
            controller &&
            onCommand(
              () => controller.giveRuntimeObject(selectedObjectId),
              `Debug give ${selectedObjectId}`,
            )
          }
        >
          Debug give
        </Button>
      </div>
      {inventory.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          Inventory is empty in the latest snapshot.
        </div>
      ) : null}
      {inventory.map((item) => (
        <div key={item.id} className="rounded-md border p-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{labelById(project, 'interactables', item.id)}</span>
            {item.selected ? <Badge>selected</Badge> : null}
          </div>
          <div className="mt-1 font-mono text-[11px] text-muted-foreground">{item.id}</div>
          <InfoRow label="Location" value={labelEntity(project, item.location)} />
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() =>
                controller &&
                onCommand(
                  () => controller.removeRuntimeInventoryObject(item.id),
                  `Debug remove ${item.id}`,
                )
              }
            >
              Debug remove
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!controller}
              onClick={() =>
                controller &&
                onCommand(
                  () => controller.selectRuntimeSubjects([{ kind: 'interactable', id: item.id }]),
                  `Selected ${item.id}`,
                  {
                    recordedAction: createRecordedAction('select-subjects', `Select ${item.id}`, {
                      type: 'select-subjects',
                      subjects: [{ kind: 'interactable', id: item.id }],
                    }),
                  },
                )
              }
            >
              Select
            </Button>
          </div>
        </div>
      ))}
    </Panel>
  );
}

function RoomObjectToolsPanel({
  snapshot,
  project,
  controlsContext,
  mutationDisabled,
  onCommand,
}: {
  snapshot: RuntimeDebugSnapshot | null;
  project: AuthoringProject | null;
  controlsContext: EnginePreviewControlsContext | null;
  mutationDisabled: boolean;
  onCommand: (
    command: RuntimeCommandFactory,
    label: string,
    options?: RuntimeCommandOptions,
  ) => void;
}) {
  const objects = project ? Object.entries(project.interactables).slice(0, 6) : [];
  const roomItems = useMemo(
    () =>
      filterSelectorItems(buildCommandPaletteItems(project), {
        collections: ['rooms'],
        includeActions: false,
      }),
    [project],
  );
  const [roomSelectorOpen, setRoomSelectorOpen] = useState(false);
  const controller = controlsContext?.controller ?? null;
  const debugDisabled = mutationDisabled || !controller;
  return (
    <>
      <Panel
        title="World tools"
        icon={<MousePointer2 className="h-3.5 w-3.5" />}
        summary={
          snapshot?.currentRoomId ? labelById(project, 'rooms', snapshot.currentRoomId) : 'No room'
        }
      >
        <Button
          size="sm"
          variant="secondary"
          disabled={debugDisabled || roomItems.length === 0}
          onClick={() => setRoomSelectorOpen(true)}
        >
          Teleport to Room
        </Button>
        <div className="text-xs font-medium">Object helpers</div>
        <div className="grid grid-cols-2 gap-1">
          {objects.map(([id, object]) => (
            <Button
              key={id}
              size="sm"
              variant="outline"
              disabled={debugDisabled}
              onClick={() =>
                controller && onCommand(() => controller.giveRuntimeObject(id), `Debug give ${id}`)
              }
            >
              {object.label || id}
            </Button>
          ))}
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={!controller}
          onClick={() =>
            controller &&
            onCommand(
              () => controller.clearRuntimeSubjectSelection(),
              'Subject selection cleared',
              {
                recordedAction: createRecordedAction(
                  'clear-subject-selection',
                  'Clear subject selection',
                  { type: 'clear-subject-selection' },
                ),
              },
            )
          }
        >
          Clear subject selection
        </Button>
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
          onCommand(
            () => controller.teleportRuntimeRoom(item.entityId!),
            `Debug teleport ${item.entityId}`,
          );
        }}
        onOpenChange={setRoomSelectorOpen}
      />
    </>
  );
}

function SaveSnapshotPanel({ snapshot }: { snapshot: RuntimeDebugSnapshot | null }) {
  const json = snapshot ? stringifyValue(snapshot.saveSnapshot) : '{}';
  return (
    <Panel
      title="Save data"
      icon={<Save className="h-3.5 w-3.5" />}
      summary={snapshot ? 'Available' : 'Unavailable'}
    >
      <Button
        size="sm"
        variant="outline"
        disabled={!snapshot}
        onClick={() => void navigator.clipboard?.writeText(json)}
      >
        <Clipboard className="h-3.5 w-3.5" />
        Copy JSON
      </Button>
      <pre className="max-h-56 overflow-auto rounded-md bg-muted p-2 text-[11px] leading-relaxed">
        {json}
      </pre>
    </Panel>
  );
}

function EventLogPanel({
  entries,
  diagnostics,
}: {
  entries: RuntimeLogEntry[];
  diagnostics: RuntimeDebugSnapshot['diagnostics'];
}) {
  return (
    <Panel title="Events & diagnostics" summary={`${diagnostics.length + entries.length}`}>
      {diagnostics.slice(0, 8).map((diagnostic, index) => (
        <div key={`${diagnostic.message}-${index}`} className="rounded-md border p-2 text-xs">
          <Badge
            variant={
              diagnostic.severity === 'error'
                ? 'destructive'
                : diagnostic.severity === 'warning'
                  ? 'secondary'
                  : 'outline'
            }
          >
            {diagnostic.severity}
          </Badge>
          <div className="mt-1">{diagnostic.message}</div>
          {diagnostic.path ? (
            <div className="font-mono text-[11px] text-muted-foreground">{diagnostic.path}</div>
          ) : null}
        </div>
      ))}
      {entries.length === 0 ? (
        <div className="text-xs text-muted-foreground">No runtime events captured yet.</div>
      ) : null}
      {entries.map((entry) => (
        <div key={entry.id} className="rounded-md border p-2 text-xs">
          <div className="flex items-center gap-2">
            <Badge
              variant={
                entry.severity === 'error'
                  ? 'destructive'
                  : entry.severity === 'warning'
                    ? 'secondary'
                    : 'outline'
              }
            >
              {entry.severity}
            </Badge>
            <span>{entry.label}</span>
          </div>
          {entry.detail ? (
            <div className="mt-1 font-mono text-[11px] text-muted-foreground">{entry.detail}</div>
          ) : null}
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
        <Badge
          variant={isRecording ? 'default' : draft.mode === 'failed' ? 'destructive' : 'secondary'}
        >
          {draft.mode}
        </Badge>
        <Badge variant="outline">
          {draft.actions.length} action{draft.actions.length === 1 ? '' : 's'}
        </Badge>
        <Badge variant="outline">{draft.traceEvents.length} trace</Badge>
      </div>
      <div className="grid grid-cols-2 gap-1">
        <Button
          size="sm"
          variant="secondary"
          disabled={isRecording || isReplaying}
          onClick={onStart}
        >
          Start Recording
        </Button>
        <Button size="sm" variant="outline" disabled={!isRecording} onClick={onStop}>
          Stop
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={isReplaying || (draft.actions.length === 0 && draft.traceEvents.length === 0)}
          onClick={onClear}
        >
          Clear
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={isReplaying || draft.actions.length === 0}
          onClick={onUndoLast}
        >
          Undo Last
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={isRecording || isReplaying || draft.actions.length === 0}
          onClick={onReplay}
        >
          Replay
        </Button>
        <Button size="sm" variant="outline" disabled={!canSave} onClick={onSaveNew}>
          Save as New Test
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!canSave || !targetTestId.trim()}
          onClick={onApplyExisting}
        >
          Apply to Existing Test
        </Button>
      </div>
      <div className="flex gap-1">
        <Input
          className="h-8 text-xs"
          value={targetTestId}
          onChange={(event) => onTargetTestIdChange(event.target.value)}
          placeholder="Existing test id"
        />
        <Button
          size="sm"
          variant="ghost"
          disabled={!draft.savedTestId}
          onClick={onOpenSavedTest}
          title="Open saved test"
        >
          <FolderOpen className="h-4 w-4" />
        </Button>
      </div>
      <div className="rounded-md border bg-muted/40 p-2 text-[11px] text-muted-foreground">
        Recording captures accepted runtime semantic inputs from this preview tab. Debug-only
        mutation controls and UI gestures are not recorded.
      </div>
      {recordingStale ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          Recording is using an older runtime snapshot. Restart with the latest project before
          recording if the new project edits should be included.
        </div>
      ) : null}
      {draft.replayError ? (
        <div className="rounded-md border border-destructive/40 p-2 text-xs text-destructive">
          {draft.replayError}
        </div>
      ) : null}
      {draft.saveError ? (
        <div className="rounded-md border border-destructive/40 p-2 text-xs text-destructive">
          {draft.saveError}
        </div>
      ) : null}
      {draft.savedTestId ? (
        <div className="rounded-md border p-2 text-xs text-muted-foreground">
          Saved test: <span className="font-mono">{draft.savedTestId}</span>
        </div>
      ) : null}
      <div className="space-y-1">
        <div className="text-xs font-medium">Actions</div>
        {draft.actions.length === 0 ? (
          <div className="text-xs text-muted-foreground">No recorded player actions yet.</div>
        ) : null}
        {draft.actions.map((action, index) => (
          <div key={action.id} className="rounded-md border p-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span>
                {index + 1}. {recordedActionLabel(action)}
              </span>
              <Badge variant="outline">runtime-input</Badge>
            </div>
            <div className="mt-1 font-mono text-[11px] text-muted-foreground">
              {stringifyValue(action.input)}
            </div>
          </div>
        ))}
      </div>
      <div className="space-y-1">
        <div className="text-xs font-medium">Trace events</div>
        {draft.traceEvents.slice(0, 6).map((event) => (
          <div key={event.id} className="rounded-md border p-2 text-xs">
            <div className="flex items-center gap-2">
              <Badge
                variant={
                  event.severity === 'error'
                    ? 'destructive'
                    : event.severity === 'warning'
                      ? 'secondary'
                      : 'outline'
                }
              >
                {event.severity}
              </Badge>
              <span>{event.label}</span>
            </div>
            {event.detail ? (
              <div className="mt-1 font-mono text-[11px] text-muted-foreground">{event.detail}</div>
            ) : null}
          </div>
        ))}
      </div>
    </Panel>
  );
}

function CompiledProjectStaleWarning({
  project,
  blockers,
  freshness,
  actionAvailable,
  onReloadLatest,
}: {
  project: AuthoringProject | null;
  blockers: ProjectValidationDiagnostic[];
  freshness: CompiledProjectFreshness;
  actionAvailable: boolean;
  onReloadLatest: () => void;
}) {
  const hasLoadedRuntime = freshness === 'stale';
  const distinctBlockers = [
    ...new Map(
      blockers.map((diagnostic) => [`${diagnostic.path}\u0000${diagnostic.message}`, diagnostic]),
    ).values(),
  ];
  const blockerCount = distinctBlockers.length;
  const reloadLabel = hasLoadedRuntime ? 'Restart with latest project' : 'Load latest project';
  return (
    <div className="border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-900 dark:text-amber-200">
      <div className="flex min-w-0 items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 truncate font-medium">
            {blockerCount > 0
              ? hasLoadedRuntime
                ? `Project changed; ${blockerCount} error${blockerCount === 1 ? '' : 's'} block restart.`
                : `${blockerCount} project error${blockerCount === 1 ? '' : 's'} block Play.`
              : hasLoadedRuntime
                ? 'Project changed since this Play session was loaded.'
                : 'Project is ready to load for Play.'}
          </span>
          {blockerCount > 0 ? (
            <TooltipProvider delay={150}>
              <div className="flex shrink-0 items-center gap-0.5" aria-label="Play blockers">
                {distinctBlockers.slice(0, 6).map((diagnostic, index) => {
                  const target = project
                    ? resolveProjectDiagnosticTarget(project, diagnostic.path)
                    : null;
                  const icon = (
                    <button
                      type="button"
                      aria-label={`Play blocker ${index + 1}: ${diagnostic.message}`}
                      className={`flex h-5 w-5 items-center justify-center rounded-sm ${target ? 'hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-500' : 'cursor-default'}`}
                      onClick={target ? () => navigateToWorkbenchTarget(target) : undefined}
                    >
                      <AlertCircle className="h-3.5 w-3.5" />
                    </button>
                  );
                  return (
                    <Tooltip key={`${diagnostic.code}:${diagnostic.path}:${index}`}>
                      <TooltipTrigger render={icon} />
                      <TooltipContent side="bottom" align="center" className="max-w-80 space-y-1">
                        <div>{diagnostic.message}</div>
                        {diagnostic.path ? (
                          <div className="break-all font-mono text-[10px] opacity-75">
                            {diagnostic.path}
                          </div>
                        ) : null}
                        {target ? (
                          <div className="text-[10px] opacity-75">Click to open.</div>
                        ) : null}
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
                {blockerCount > 6 ? (
                  <span className="pl-0.5 text-[10px] font-medium">+{blockerCount - 6}</span>
                ) : null}
              </div>
            </TooltipProvider>
          ) : null}
        </div>
        {blockerCount === 0 && actionAvailable ? (
          <Button
            size="icon-sm"
            variant="ghost"
            className="shrink-0 text-current hover:bg-amber-500/20"
            onClick={onReloadLatest}
            aria-label={reloadLabel}
            title={reloadLabel}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function RuntimeInspector({
  state,
  project,
  controlsContext,
  compiledProjectState,
  canReloadLatestProject,
  runtimeBlockers,
  mode,
  recorderDraft,
  targetTestId,
  onTargetTestIdChange,
  onModeChange,
  onCommand,
  onReloadLatestProject,
  onRecorderStart,
  onRecorderStop,
  onRecorderClear,
  onRecorderUndoLast,
  onRecorderReplay,
  onRecorderSaveNew,
  onRecorderApplyExisting,
  onOpenSavedTest,
}: {
  state: FullGamePreviewState;
  project: AuthoringProject | null;
  controlsContext: EnginePreviewControlsContext | null;
  compiledProjectState: FullGamePreviewCompiledProjectState;
  canReloadLatestProject: boolean;
  runtimeBlockers: ProjectValidationDiagnostic[];
  mode: FullGamePreviewMode;
  recorderDraft: RecordedTestDraft;
  targetTestId: string;
  onTargetTestIdChange: (value: string) => void;
  onModeChange: (mode: FullGamePreviewMode) => void;
  onCommand: (
    command: RuntimeCommandFactory,
    label: string,
    options?: RuntimeCommandOptions,
  ) => void;
  onReloadLatestProject: () => void;
  onRecorderStart: () => void;
  onRecorderStop: () => void;
  onRecorderClear: () => void;
  onRecorderUndoLast: () => void;
  onRecorderReplay: () => void;
  onRecorderSaveNew: () => void;
  onRecorderApplyExisting: () => void;
  onOpenSavedTest: () => void;
}) {
  const mutationDisabled = mode === 'recording';
  const projectReloadAvailable = canReloadLatestProject;
  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-background">
      <div className="shrink-0 border-b bg-background px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold">Play Inspector</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {state.snapshot?.currentRoomId
                ? `In ${labelById(project, 'rooms', state.snapshot.currentRoomId)}`
                : 'Runtime tools and live state'}
            </div>
          </div>
          <div
            className="flex rounded-md border bg-muted/60 p-0.5"
            role="group"
            aria-label="Play inspector mode"
          >
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
      {compiledProjectState.freshness === 'stale' || runtimeBlockers.length > 0 ? (
        <CompiledProjectStaleWarning
          project={project}
          blockers={runtimeBlockers}
          freshness={compiledProjectState.freshness}
          actionAvailable={projectReloadAvailable}
          onReloadLatest={onReloadLatestProject}
        />
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {mode === 'recording' ? (
          <RecorderPanel
            draft={recorderDraft}
            targetTestId={targetTestId}
            compiledProjectFreshness={compiledProjectState.freshness}
            onTargetTestIdChange={onTargetTestIdChange}
            onStart={onRecorderStart}
            onStop={onRecorderStop}
            onClear={onRecorderClear}
            onUndoLast={onRecorderUndoLast}
            onReplay={onRecorderReplay}
            onSaveNew={onRecorderSaveNew}
            onApplyExisting={onRecorderApplyExisting}
            onOpenSavedTest={onOpenSavedTest}
          />
        ) : null}
        <RuntimeSummaryPanel snapshot={state.snapshot} />
        <InputAvailabilityPanel
          snapshot={state.snapshot}
          project={project}
          controlsContext={controlsContext}
          onCommand={onCommand}
        />
        <ResolverAnalysisPanel snapshot={state.snapshot} project={project} />
        {mode === 'debug' ? (
          <>
            <VariablesPanel
              snapshot={state.snapshot}
              project={project}
              controlsContext={controlsContext}
              mutationDisabled={mutationDisabled}
              onCommand={onCommand}
            />
            <InventoryPanel
              snapshot={state.snapshot}
              project={project}
              controlsContext={controlsContext}
              mutationDisabled={mutationDisabled}
              onCommand={onCommand}
            />
            <RoomObjectToolsPanel
              snapshot={state.snapshot}
              project={project}
              controlsContext={controlsContext}
              mutationDisabled={mutationDisabled}
              onCommand={onCommand}
            />
            <SaveSnapshotPanel snapshot={state.snapshot} />
          </>
        ) : null}
        <EventLogPanel entries={state.eventLog} diagnostics={state.snapshot?.diagnostics ?? []} />
      </div>
    </aside>
  );
}

function FullGamePreviewTransportBar({
  context,
  compiledProjectState,
  project,
  snapshot,
  onRuntimeCommand,
  runtimeBlockers,
}: {
  context: EnginePreviewControlsContext;
  compiledProjectState: FullGamePreviewCompiledProjectState;
  project: AuthoringProject | null;
  snapshot: RuntimeDebugSnapshot | null;
  onRuntimeCommand: (
    command: RuntimeCommandFactory,
    label: string,
    options?: RuntimeCommandOptions,
  ) => void;
  runtimeBlockers: ProjectValidationDiagnostic[];
}) {
  const runtimeDisabled = context.connectionState !== 'ready';
  const currentRuntimeBlocked = runtimeBlockers.length > 0;
  const currentRoom = snapshot?.currentRoomId
    ? ({
        type: 'room',
        id: snapshot.currentRoomId,
        collection: 'rooms',
        label: project?.rooms[snapshot.currentRoomId]?.label,
      } as RuntimeDebugEntityRef)
    : null;
  const currentEntityIsCurrentRoom =
    snapshot?.currentEntity?.collection === 'rooms' &&
    snapshot.currentEntity.id === snapshot.currentRoomId;

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
      <Button
        size="sm"
        variant="ghost"
        onClick={context.reload}
        disabled={
          runtimeDisabled || currentRuntimeBlocked || compiledProjectState.freshness === 'stale'
        }
        aria-label="Reload engine preview"
        title="Reload engine preview"
      >
        <RefreshCw className="h-4 w-4" />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => onRuntimeCommand(() => context.controller.runtimeReset(), 'Runtime reset')}
        disabled={runtimeDisabled || currentRuntimeBlocked}
        aria-label="Reset game runtime"
        title="Reset game runtime"
      >
        <RotateCcw className="h-4 w-4" />
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          onRuntimeCommand(
            () => context.controller.fastForwardRuntimeToInput(),
            'Fast-forward requested',
          )
        }
        disabled={runtimeDisabled}
      >
        <FastForward className="h-4 w-4" />
        Fast-forward
      </Button>
      <div className="ml-auto flex min-w-0 items-center gap-1">
        <RuntimeEntityButton
          entity={snapshot?.currentEntity}
          project={project}
          label="Current entity"
        />
        {!currentEntityIsCurrentRoom ? (
          <RuntimeEntityButton entity={currentRoom} project={project} label="Current room" />
        ) : null}
      </div>
      <label className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
        Cap
        <Input
          className="h-7 w-16"
          type="number"
          min="0"
          max="1000"
          step="1"
          value={context.fpsCap}
          onChange={(event) => context.setFpsCap(sanitizePreviewFpsCap(Number(event.target.value)))}
        />
      </label>
    </div>
  );
}

export function FullGamePreviewEditor() {
  const projectDocument = useProjectStore((state) => state.document);
  const pendingInputEntries = usePendingInputStore((state) => state.entriesBySaveUnitId);
  const project = useMemo(
    () => (isAuthoringProject(projectDocument) ? projectDocument : null),
    [projectDocument],
  );
  const executeCommand = useCommandStore((store) => store.executeCommand);
  const openTab = useWorkbenchStore((store) => store.openTab);
  const [state, setState] = useState<FullGamePreviewState>({ snapshot: null, eventLog: [] });
  const [compiledProjectState, setCompiledProjectState] =
    useState<FullGamePreviewCompiledProjectState>({
      loadedSourceFingerprint: null,
      currentSourceFingerprint: null,
      freshness: 'not-loaded',
    });
  const [mode, setMode] = useState<FullGamePreviewMode>('debug');
  const [previewCapabilities, setPreviewCapabilities] = useState<string[]>([]);
  const [previewControls, setPreviewControls] = useState<EnginePreviewControlsContext | null>(null);
  const [previewReadyGeneration, setPreviewReadyGeneration] = useState(0);
  const [recorderDraft, setRecorderDraft] = useState<RecordedTestDraft>({
    mode: 'idle',
    actions: [],
    traceEvents: [],
  });
  const [targetTestId, setTargetTestId] = useState('');
  const controlsRef = useRef<EnginePreviewControlsContext | null>(null);
  const bootstrappedReadyGenerationRef = useRef(0);
  const staleWarningFingerprintRef = useRef<string | null>(null);
  const [exportedCompiledProject, setExportedCompiledProject] = useState<
    Awaited<ReturnType<typeof compiledProjectDiagnosticEntries>>
  >({
    ok: false,
    compiledProject: null,
    shaderMaterialMetadata: null,
    previewAssets: [],
    sourceFingerprint: null,
    blockers: [],
    entries: [],
  });
  const [compiledProjectPreparationPending, setCompiledProjectPreparationPending] = useState(true);
  useEffect(() => {
    let current = true;
    setCompiledProjectPreparationPending(true);
    void compiledProjectDiagnosticEntries(project, pendingInputEntries).then((result) => {
      if (current) {
        setExportedCompiledProject(result);
        setCompiledProjectPreparationPending(false);
      }
    });
    return () => {
      current = false;
    };
  }, [project, pendingInputEntries]);
  const canReloadLatestProject =
    exportedCompiledProject.ok && !!exportedCompiledProject.compiledProject;

  const { notifyProjectReplaced: notifyAssetProfilerProjectReplaced } = useAssetProfilerPolling({
    controls: previewControls,
    supported: previewCapabilities.includes('asset-profiler-v1'),
  });

  const handlePreviewControlsChange = useCallback(
    (context: EnginePreviewControlsContext | null) => {
      controlsRef.current = context;
      setPreviewControls(context);
      if (!context) setPreviewCapabilities([]);
    },
    [],
  );

  useEffect(() => {
    if (!targetTestId.trim() && recorderDraft.savedTestId)
      setTargetTestId(recorderDraft.savedTestId);
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

  const loadCompiledProjectIntoPreview = useCallback(
    async (context: EnginePreviewControlsContext | null = controlsRef.current) => {
      if (!context) return false;
      const exported = exportedCompiledProject;
      if (!exported.ok || !exported.compiledProject) {
        setState((current) => ({
          ...current,
          eventLog: exported.entries.reduce(
            (entries, entry) => addLogEntry(entries, entry),
            addLogEntry(current.eventLog, {
              label: 'Runtime project not loaded',
              severity: 'warning',
            }),
          ),
        }));
        return false;
      }
      await context.controller.loadCompiledProject(
        exported.compiledProject,
        exported.previewAssets,
        exported.shaderMaterialMetadata,
      );
      notifyAssetProfilerProjectReplaced();
      setCompiledProjectState({
        loadedSourceFingerprint: exported.sourceFingerprint,
        currentSourceFingerprint: exported.sourceFingerprint,
        freshness: exported.sourceFingerprint ? 'fresh' : 'not-loaded',
      });
      staleWarningFingerprintRef.current = null;
      setState((current) => ({
        ...current,
        eventLog: exported.entries.reduce(
          (entries, entry) => addLogEntry(entries, entry),
          addLogEntry(current.eventLog, {
            label: 'Runtime project loaded for Play tab',
            detail: project?.project.name,
            severity: exported.entries.length > 0 ? 'warning' : 'info',
          }),
        ),
      }));
      return true;
    },
    [exportedCompiledProject, notifyAssetProfilerProjectReplaced, project?.project.name],
  );

  const replayActions = useCallback(
    (actions: RecordedRuntimeAction[], successMode: RecordedTestDraft['mode'] = 'idle') => {
      const context = controlsRef.current;
      if (!context) {
        setRecorderDraft((current) => ({
          ...current,
          mode: 'failed',
          replayError: 'Engine preview is not connected.',
        }));
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
      setState((current) => ({
        ...current,
        eventLog: addLogEntry(current.eventLog, {
          label: `Replaying ${actions.length} recorded action${actions.length === 1 ? '' : 's'}`,
          severity: 'info',
        }),
      }));
      context.sendRuntimeCommand(
        replay()
          .then(() => {
            setRecorderDraft((current) => ({
              ...current,
              mode: successMode,
              replayError: undefined,
            }));
          })
          .catch((error: Error) => {
            setRecorderDraft((current) => ({
              ...current,
              mode: 'failed',
              replayError: error.message,
              traceEvents: addTraceEvent(current.traceEvents, {
                label: 'Replay failed',
                detail: error.message,
                severity: 'error',
              }),
            }));
            throw error;
          }),
        'Replay recorded actions',
      );
    },
    [],
  );

  const handleRuntimeCommand = useCallback(
    (command: RuntimeCommandFactory, label: string, options: RuntimeCommandOptions = {}) => {
      setState((current) => ({
        ...current,
        eventLog: addLogEntry(current.eventLog, { label, severity: 'info' }),
      }));
      const recordedAction = options.recordedAction;
      controlsRef.current?.sendRuntimeCommand(
        command().then(() => {
          if (recordedAction) {
            setRecorderDraft((current) => {
              if (current.mode !== 'recording') return current;
              return {
                ...current,
                actions: [...current.actions, recordedAction],
                replayError: undefined,
                traceEvents: addTraceEvent(current.traceEvents, {
                  label: `Recorded ${recordedActionLabel(recordedAction)}`,
                  detail: stringifyValue(recordedAction.input),
                  severity: 'info',
                }),
              };
            });
          }
          return requestDebugSnapshot(controlsRef.current);
        }),
        label,
      );
    },
    [requestDebugSnapshot],
  );

  const handlePreviewMessage = useCallback(
    (message: PreviewToEditorMessage) => {
      if (message.type === 'ready' || message.type === 'capabilities') {
        setPreviewCapabilities(message.capabilities);
      }
      if (message.type === 'ready') {
        setPreviewReadyGeneration((current) => current + 1);
      }
      const logEntry = previewMessageLabel(message);
      setState((current) => ({
        snapshot:
          message.type === 'runtime-debug-snapshot'
            ? message.snapshot
            : message.type === 'runtime-fast-forward-result'
              ? message.result.finalSnapshot
              : current.snapshot,
        eventLog: logEntry ? addLogEntry(current.eventLog, logEntry) : current.eventLog,
      }));
      if (logEntry) {
        setRecorderDraft((current) => {
          if (current.mode === 'idle' && current.actions.length === 0) return current;
          return { ...current, traceEvents: addTraceEvent(current.traceEvents, logEntry) };
        });
      }
      if (
        message.type === 'preview-interacted' ||
        message.type === 'object-clicked' ||
        message.type === 'preview-object-selected'
      ) {
        requestDebugSnapshot(controlsRef.current);
      }
    },
    [requestDebugSnapshot],
  );

  useEffect(() => {
    if (
      !previewControls ||
      previewControls.connectionState !== 'ready' ||
      compiledProjectPreparationPending ||
      previewReadyGeneration === 0
    ) {
      return;
    }

    const runtimeAlreadyLoaded = compiledProjectState.loadedSourceFingerprint !== null;
    if (runtimeAlreadyLoaded && bootstrappedReadyGenerationRef.current >= previewReadyGeneration) {
      return;
    }

    if (!runtimeAlreadyLoaded && !canReloadLatestProject) {
      bootstrappedReadyGenerationRef.current = previewReadyGeneration;
      return;
    }

    bootstrappedReadyGenerationRef.current = previewReadyGeneration;
    let cancelled = false;
    void loadCompiledProjectIntoPreview(previewControls)
      .then((loaded) => {
        if (!cancelled && loaded) requestDebugSnapshot(previewControls);
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setState((current) => ({
          ...current,
          eventLog: addLogEntry(current.eventLog, { label: error.message, severity: 'error' }),
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [
    loadCompiledProjectIntoPreview,
    canReloadLatestProject,
    compiledProjectPreparationPending,
    compiledProjectState.loadedSourceFingerprint,
    previewControls,
    previewReadyGeneration,
    requestDebugSnapshot,
  ]);

  useEffect(() => {
    setCompiledProjectState((current) => {
      const freshness =
        current.loadedSourceFingerprint === null
          ? 'not-loaded'
          : exportedCompiledProject.blockers.length === 0 &&
              exportedCompiledProject.sourceFingerprint === current.loadedSourceFingerprint
            ? 'fresh'
            : 'stale';
      return {
        ...current,
        currentSourceFingerprint: exportedCompiledProject.sourceFingerprint,
        freshness,
      };
    });
  }, [exportedCompiledProject.blockers.length, exportedCompiledProject.sourceFingerprint]);

  useEffect(() => {
    if (compiledProjectState.freshness !== 'stale') return;
    const warningFingerprint = `${compiledProjectState.currentSourceFingerprint ?? 'none'}:${exportedCompiledProject.blockers.map((item) => `${item.code}:${item.path}`).join('|')}`;
    if (staleWarningFingerprintRef.current === warningFingerprint) return;
    staleWarningFingerprintRef.current = warningFingerprint;
    setState((current) => ({
      ...current,
      eventLog: addLogEntry(current.eventLog, {
        label: 'Project changed since this Play session was loaded',
        detail:
          exportedCompiledProject.blockers.length > 0
            ? 'The running game remains on the last valid runtime snapshot because the current project is blocked.'
            : 'The running game is using an older runtime snapshot.',
        severity: 'warning',
      }),
    }));
  }, [
    compiledProjectState.currentSourceFingerprint,
    compiledProjectState.freshness,
    exportedCompiledProject.blockers,
  ]);

  const reloadLatestCompiledProject = useCallback(
    (context: EnginePreviewControlsContext | null = controlsRef.current) => {
      if (!context || !canReloadLatestProject) return;
      void loadCompiledProjectIntoPreview(context)
        .then((loaded) => {
          if (loaded) requestDebugSnapshot(context);
        })
        .catch((error: Error) => {
          setState((current) => ({
            ...current,
            eventLog: addLogEntry(current.eventLog, { label: error.message, severity: 'error' }),
          }));
        });
    },
    [canReloadLatestProject, loadCompiledProjectIntoPreview, requestDebugSnapshot],
  );

  const startRecording = useCallback(() => {
    setMode('recording');
    setRecorderDraft((current) => ({
      mode: 'recording',
      actions: current.mode === 'idle' ? [] : current.actions,
      traceEvents: addTraceEvent(current.traceEvents, {
        label: 'Recording started',
        severity: 'info',
      }),
      replayError: undefined,
    }));
    requestDebugSnapshot(controlsRef.current);
  }, [requestDebugSnapshot]);

  const stopRecording = useCallback(() => {
    setRecorderDraft((current) => ({
      ...current,
      mode: 'idle',
      traceEvents: addTraceEvent(current.traceEvents, {
        label: 'Recording stopped',
        severity: 'info',
      }),
    }));
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
        traceEvents: addTraceEvent(current.traceEvents, {
          label: 'Undo last recorded action',
          detail: `${actions.length} action${actions.length === 1 ? '' : 's'} remain`,
          severity: 'info',
        }),
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
      const message =
        conversion.diagnostics[0] ?? 'Recording has no saveable runtime semantic actions.';
      setRecorderDraft((current) => ({ ...current, saveError: message }));
      return;
    }
    const result = executeCommand({
      type: 'entity.createRecord',
      label: `Create recorded test ${testId}`,
      payload: { collection: 'tests', entityId: testId, label, data: conversion.data },
      ...MUTATION_SURFACE_ATTRIBUTIONS.playRecorderTests,
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
      setRecorderDraft((current) => ({
        ...current,
        saveError: 'Enter an existing test id first.',
      }));
      return;
    }
    const record = project?.tests[testId];
    if (!record) {
      setRecorderDraft((current) => ({
        ...current,
        saveError: `Test '${testId}' does not exist.`,
      }));
      return;
    }
    const label = record.label || testId;
    const conversion = recordedTestDraftToTestData(recorderDraft, {
      label,
      base: parseTestData(record.data) ?? undefined,
    });
    if (!conversion.ok) {
      const message =
        conversion.diagnostics[0] ?? 'Recording has no saveable runtime semantic actions.';
      setRecorderDraft((current) => ({ ...current, saveError: message }));
      return;
    }
    const result = executeCommand({
      type: 'test.replaceData',
      label: `Apply recording to ${testId}`,
      payload: { testId, data: conversion.data },
      ...MUTATION_SURFACE_ATTRIBUTIONS.playRecorderTests,
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
            audioEnabled
            previewActivityRefreshOnVisible={
              compiledProjectState.loadedSourceFingerprint ? 'runtime-debug' : 'none'
            }
            onPreviewMessage={handlePreviewMessage}
            onControlsContextChange={handlePreviewControlsChange}
            renderControls={(context) => {
              return (
                <FullGamePreviewTransportBar
                  context={context}
                  compiledProjectState={compiledProjectState}
                  project={project}
                  snapshot={state.snapshot}
                  onRuntimeCommand={handleRuntimeCommand}
                  runtimeBlockers={exportedCompiledProject.blockers}
                />
              );
            }}
          />
        </div>
      </ResizePanel>
      <PanelResizeSeparator orientation="horizontal" aria-label="Resize Play Inspector" />
      <ResizePanel
        id="full-game-preview-inspector"
        defaultSize="300px"
        minSize="260px"
        maxSize="55%"
      >
        <RuntimeInspector
          state={state}
          project={project}
          controlsContext={previewControls}
          compiledProjectState={compiledProjectState}
          canReloadLatestProject={canReloadLatestProject}
          runtimeBlockers={exportedCompiledProject.blockers}
          mode={mode}
          recorderDraft={recorderDraft}
          targetTestId={targetTestId}
          onTargetTestIdChange={setTargetTestId}
          onModeChange={setMode}
          onCommand={handleRuntimeCommand}
          onReloadLatestProject={() => reloadLatestCompiledProject()}
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
