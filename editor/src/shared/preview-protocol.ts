import type { PreviewWheelPolicy } from './preview-wheel-routing';
import {
  appliedPreviewDocumentResultSchema,
  focusedRecordPreviewDocumentSchema,
  type AppliedPreviewDocumentResult,
  type FocusedRecordPreviewDocument,
} from './focused-preview-contracts';
import { shaderVariantSchema, type ShaderVariant } from './shader-variants';
import {
  isAssetProfilerWirePayload,
  isCanonicalUnsignedDecimal,
  type AssetProfilerWirePayload,
} from './asset-profiler-protocol';

export const PREVIEW_PROTOCOL_VERSION = 1;

export interface PreviewPosition {
  x: number;
  y: number;
}

export type PreviewConnectionState =
  | 'missing'
  | 'loading'
  | 'connecting'
  | 'ready'
  | 'error'
  | 'disconnected';

export interface EnginePreviewSession {
  url: string;
  origin: string;
  sessionToken: string;
}

export interface PreviewTarget {
  collection?: string;
  entityId?: string;
  kind?: string;
  label?: string;
}

export type PreviewMode =
  | 'runtime'
  | 'material'
  | 'layout'
  | 'room'
  | 'scene'
  | 'character'
  | 'dialogue'
  | 'symbolic';

export type PreviewDocument =
  | { kind: 'symbolic'; target: PreviewTarget; label: string; revision?: string }
  | {
      kind:
        | 'shader-preview'
        | 'material-preview'
        | 'layout-preview'
        | 'room-preview'
        | 'scene-preview'
        | 'character-preview'
        | 'dialogue-preview';
      recordId: string;
      revision: string;
      data: Record<string, unknown>;
    };

const legacyPreviewDocumentSchemas = {
  'character-preview': 'noveltea.character-preview',
  'dialogue-preview': 'noveltea.dialogue-preview',
  'scene-preview': 'noveltea.scene-preview',
  'layout-preview': 'noveltea.layout-preview',
} as const;

type DataPreviewDocument = Exclude<PreviewDocument, { kind: 'symbolic' }>;

function hasCurrentLegacyPreviewSchema(document: DataPreviewDocument): boolean {
  const expected =
    legacyPreviewDocumentSchemas[document.kind as keyof typeof legacyPreviewDocumentSchemas];
  return expected === undefined || document.data.schema === expected;
}

export interface PreviewDiagnosticMessage {
  severity: 'info' | 'warning' | 'error';
  message: string;
  path?: string;
  target?: PreviewTarget;
}

export interface PreviewStateSnapshot {
  mode?: PreviewMode;
  target?: PreviewTarget;
  ready: boolean;
  detail?: Record<string, unknown>;
}

export const RMLUI_RASTER_SNAP_MODES = ['none', 'geometry', 'text', 'all'] as const;
export type RmlUiRasterSnapMode = (typeof RMLUI_RASTER_SNAP_MODES)[number];

export function normalizeRmlUiRasterSnapMode(value: unknown): RmlUiRasterSnapMode {
  return RMLUI_RASTER_SNAP_MODES.includes(value as RmlUiRasterSnapMode)
    ? (value as RmlUiRasterSnapMode)
    : 'all';
}

export interface EnginePreviewSettings {
  showFpsCounter?: boolean;
  fpsCap?: number;
  rmluiRasterSnap?: RmlUiRasterSnapMode;
}

export type { PreviewDisplayProfile } from './preview-display';

export interface AuthoredPreviewEnvironment {
  profile: {
    name: string;
    nativeResolution: { width: number; height: number };
    scalePolicy: { ui: 'inherit' | 'ignore'; text: 'inherit' | 'ignore' };
  };
  project: {
    referenceResolution: { width: number; height: number };
    worldRasterPolicy: 'capped' | 'native';
    barColor: string;
    accessibility: {
      uiScale: { enabled: boolean; minimum: number; maximum: number };
      textScale: { enabled: boolean; minimum: number; maximum: number };
    };
  };
}

export interface RuntimeDebugEntityRef {
  type: string;
  id: string;
  collection?: string;
  label?: string;
}

export interface RuntimeDebugWaitingState {
  kind:
    | 'unloaded'
    | 'none'
    | 'continue'
    | 'choice'
    | 'navigation'
    | 'action'
    | 'title'
    | 'paused'
    | 'error'
    | 'unknown';
  canContinue: boolean;
  reason?: string;
}

export interface RuntimeDebugVariableSnapshot {
  id: string;
  label: string;
  type: string;
  value: unknown;
  defaultValue?: unknown;
  dirty?: boolean;
  overridden?: boolean;
}

export interface RuntimeDebugInventoryItemSnapshot {
  id: string;
  label: string;
  selected?: boolean;
  enabled?: boolean;
  location?: RuntimeDebugEntityRef;
}

export interface RuntimeDebugChoiceSnapshot {
  kind: 'dialogue' | 'scene';
  id: string;
  label: string;
  enabled: boolean;
}

export interface RuntimeDebugNavigationSnapshot {
  exitId: string;
  direction: number;
  label: string;
  enabled: boolean;
}

export interface RuntimeDebugActionSnapshot {
  verbId: string;
  label: string;
  bindingOrder: string[];
  selectedCount: number;
  rank?: number;
  primary?: boolean;
  enabled: boolean;
  reason?: string;
}

export interface RuntimeDebugVerbOfferSnapshot {
  verbId: string;
  slotId: string;
  label: string;
  bindingOrder: string[];
  rank: number;
  primary: boolean;
}

export type PreviewInteractionSubject =
  | { kind: 'character'; id: string }
  | { kind: 'interactable'; id: string }
  | {
      kind: 'feature';
      ownerKind: 'room' | 'interactable';
      ownerId: string;
      featureId: string;
    };

export type PreviewClickableTarget =
  | { kind: 'subject'; subject: PreviewInteractionSubject; label: string }
  | { kind: 'exit'; exitId: string; label: string };

export interface RuntimeDebugAvailableInputsSnapshot {
  continue: boolean;
  choices: RuntimeDebugChoiceSnapshot[];
  navigation: RuntimeDebugNavigationSnapshot[];
  actions: RuntimeDebugActionSnapshot[];
  verbOffers: RuntimeDebugVerbOfferSnapshot[];
  verbMenuOpen: boolean;
  selectedSubjects: PreviewInteractionSubject[];
  clickableTargets: PreviewClickableTarget[];
}

export interface RuntimeDebugDiagnosticSnapshot {
  severity: 'info' | 'warning' | 'error';
  message: string;
  category?: string;
  path?: string;
  source?: RuntimeDebugEntityRef;
  scriptContext?: string;
  hookContext?: string;
  luaTraceback?: string;
}

export interface RuntimeDebugGameplayInstanceSnapshot {
  kind: 'room' | 'character' | 'interactable';
  id: string;
  declared: boolean;
  provenance: 'declared' | 'archetype' | 'compiled-definition' | 'clone';
  archetype: string | null;
  source: string | null;
}

export interface RuntimeDebugPublicationSnapshot {
  revision: number;
  presentationRevision: number;
  observationCount: number;
  actorCount: number;
  interactableCount: number;
  propCount: number;
  environmentCount: number;
  layoutCount: number;
  desiredAudioCount: number;
  gameplayInstances: RuntimeDebugGameplayInstanceSnapshot[];
}

export type RuntimeFastForwardStopReason =
  | 'choice-available'
  | 'navigation-available'
  | 'action-available'
  | 'explicit-input'
  | 'blocking-ui'
  | 'ui-target-available'
  | 'error'
  | 'budget-exhausted'
  | 'stabilization-limit'
  | 'game-end'
  | 'unloaded'
  | 'unknown';

export interface RuntimeDebugSnapshot {
  requestId?: string;
  loaded: boolean;
  running: boolean;
  shellMode?: string;
  runtimeMode?: string;
  gameplayPaused?: boolean;
  entrypoint?: RuntimeDebugEntityRef;
  currentEntity?: RuntimeDebugEntityRef;
  currentRoomId?: string;
  currentMapId?: string;
  currentDialogueId?: string;
  waiting: RuntimeDebugWaitingState;
  availableInputs: RuntimeDebugAvailableInputsSnapshot;
  variables: RuntimeDebugVariableSnapshot[];
  inventory: RuntimeDebugInventoryItemSnapshot[];
  selectedSubjects: PreviewInteractionSubject[];
  diagnostics: RuntimeDebugDiagnosticSnapshot[];
  saveSnapshot: Record<string, unknown>;
  publication: RuntimeDebugPublicationSnapshot;
}

export interface RuntimeFastForwardResult {
  reason: RuntimeFastForwardStopReason;
  stepsApplied: number;
  ticksApplied: number;
  lastInput?: string;
  semanticInputBudget?: number;
  simulatedTickBudget?: number;
  stabilizationTickBudget?: number;
  simulatedSecondsBudget?: number;
  diagnostic?: string;
  finalSnapshot: RuntimeDebugSnapshot;
}

export type RuntimeDebugEventKind =
  | 'variable-set'
  | 'variable-reset'
  | 'inventory-give'
  | 'inventory-remove'
  | 'room-teleport'
  | 'instance-create'
  | 'instance-replace-configuration'
  | 'instance-clear-configuration'
  | 'instance-destroy'
  | 'room-exit-retarget'
  | 'object-select'
  | 'object-clear-selection'
  | 'action-run';

export interface RuntimeDebugEvent {
  requestId?: string;
  kind: RuntimeDebugEventKind;
  debugOnly: true;
  label: string;
  message?: string;
  target?: RuntimeDebugEntityRef;
  secondaryTargets?: RuntimeDebugEntityRef[];
  oldValue?: unknown;
  newValue?: unknown;
  rejected?: boolean;
}

export type EditorToPreviewMessage =
  | { version: 1; type: 'play'; requestId: string }
  | { version: 1; type: 'stop'; requestId: string }
  | { version: 1; type: 'runtime-reset'; requestId: string }
  | {
      version: 1;
      type: 'runtime-load-compiled-project';
      requestId: string;
      compiledProject: unknown;
      shaderMaterialMetadata?: unknown;
      assets?: Array<{ sourcePath: string; runtimePath: string }>;
    }
  | { version: 1; type: 'runtime-start'; requestId: string }
  | { version: 1; type: 'runtime-stop'; requestId: string }
  | { version: 1; type: 'runtime-step'; requestId: string; deltaSeconds?: number }
  | { version: 1; type: 'runtime-continue'; requestId: string }
  | { version: 1; type: 'runtime-fast-forward-to-input'; requestId: string }
  | { version: 1; type: 'runtime-dialogue-choice'; requestId: string; edgeId: string }
  | { version: 1; type: 'runtime-scene-choice'; requestId: string; optionId: string }
  | { version: 1; type: 'runtime-navigate'; requestId: string; exitId: string }
  | {
      version: 1;
      type: 'runtime-select-subjects';
      requestId: string;
      subjects: PreviewInteractionSubject[];
    }
  | {
      version: 1;
      type: 'runtime-primary-activate';
      requestId: string;
      subject: PreviewInteractionSubject;
    }
  | {
      version: 1;
      type: 'runtime-open-verb-menu';
      requestId: string;
      subject: PreviewInteractionSubject;
    }
  | { version: 1; type: 'runtime-clear-subject-selection'; requestId: string }
  | {
      version: 1;
      type: 'runtime-run-interaction';
      requestId: string;
      verbId: string;
      bindings: Array<{ slotId: string; subject: PreviewInteractionSubject }>;
    }
  | { version: 1; type: 'runtime-request-debug-snapshot'; requestId: string }
  | {
      version: 1;
      type: 'runtime-request-asset-profiler';
      requestId: string;
      mode: 'full' | 'delta';
      sessionId?: string;
      afterSequence?: string;
    }
  | {
      version: 1;
      type: 'runtime-set-variable';
      requestId: string;
      variableId: string;
      value: unknown;
    }
  | { version: 1; type: 'runtime-reset-variable'; requestId: string; variableId: string }
  | { version: 1; type: 'runtime-give-object'; requestId: string; objectId: string }
  | { version: 1; type: 'runtime-remove-inventory-object'; requestId: string; objectId: string }
  | { version: 1; type: 'runtime-teleport-room'; requestId: string; roomId: string }
  | {
      version: 1;
      type: 'runtime-create-instance';
      requestId: string;
      instanceKind: 'room' | 'character' | 'interactable';
      sourceKind: 'archetype' | 'compiled' | 'effective';
      sourceId: string;
    }
  | {
      version: 1;
      type: 'runtime-replace-instance-configuration';
      requestId: string;
      instanceKind: 'room' | 'character' | 'interactable';
      instanceId: string;
      sourceKind: 'archetype' | 'compiled' | 'effective';
      sourceId: string;
    }
  | {
      version: 1;
      type: 'runtime-clear-instance-configuration';
      requestId: string;
      instanceKind: 'room' | 'character' | 'interactable';
      instanceId: string;
    }
  | {
      version: 1;
      type: 'runtime-destroy-instance';
      requestId: string;
      instanceKind: 'room' | 'character' | 'interactable';
      instanceId: string;
    }
  | {
      version: 1;
      type: 'runtime-retarget-room-exit';
      requestId: string;
      roomId: string;
      exitId: string;
      targetRoomId: string;
    }
  | {
      version: 1;
      type: 'load-preview-document';
      requestId: string;
      document: PreviewDocument;
      environment?: AuthoredPreviewEnvironment;
    }
  | {
      version: 1;
      type: 'update-preview-document';
      requestId: string;
      document: PreviewDocument;
      environment?: AuthoredPreviewEnvironment;
    }
  | {
      version: 1;
      type: 'apply-focused-editor-document';
      requestId: string;
      applySequence: number;
      document: FocusedRecordPreviewDocument;
    }
  | { version: 1; type: 'set-preview-mode'; requestId: string; mode: PreviewMode }
  | { version: 1; type: 'request-preview-state'; requestId: string }
  | { version: 1; type: 'set-engine-settings'; requestId: string; settings: EnginePreviewSettings }
  | {
      version: 1;
      type: 'set-preview-activity';
      requestId: string;
      active: boolean;
      visible?: boolean;
    }
  | {
      version: 1;
      type: 'set-preview-wheel-routing';
      requestId: string;
      policy: PreviewWheelPolicy;
      routeId: string;
    }
  | { version: 1; type: 'request-preview-snapshot'; requestId: string; snapshotId: string };

export type PreviewToEditorMessage =
  | {
      version: 1;
      type: 'ready';
      capabilities: string[];
      hostGeneration: number;
      transportGeneration: number;
      activeShaderVariant: ShaderVariant;
    }
  | { version: 1; type: 'capabilities'; capabilities: string[] }
  | {
      version: 1;
      type: 'command-result';
      requestId: string;
      ok: boolean;
      error?: string;
      errorCode?: string;
    }
  | { version: 1; type: 'preview-state'; state: PreviewStateSnapshot }
  | { version: 1; type: 'preview-snapshot'; snapshotId: string; dataUrl: string }
  | {
      version: 1;
      type: 'runtime-debug-snapshot';
      requestId?: string;
      snapshot: RuntimeDebugSnapshot;
    }
  | {
      version: 1;
      type: 'runtime-asset-profiler';
      requestId: string;
      payload: AssetProfilerWirePayload;
    }
  | { version: 1; type: 'runtime-debug-event'; requestId?: string; event: RuntimeDebugEvent }
  | {
      version: 1;
      type: 'runtime-fast-forward-result';
      requestId: string;
      result: RuntimeFastForwardResult;
    }
  | { version: 1; type: 'preview-diagnostic'; diagnostic: PreviewDiagnosticMessage }
  | {
      version: 1;
      type: 'focused-document-applied';
      requestId: string;
      hostGeneration: number;
      applySequence: number;
      result: AppliedPreviewDocumentResult;
      diagnostics: PreviewDiagnosticMessage[];
    }
  | {
      version: 1;
      type: 'preview-diagnostics-replaced';
      scopeKey: string;
      diagnostics: PreviewDiagnosticMessage[];
    }
  | { version: 1; type: 'preview-object-selected'; objectId: string; position?: PreviewPosition }
  | { version: 1; type: 'preview-object-hovered'; objectId: string; position?: PreviewPosition }
  | { version: 1; type: 'preview-interacted'; interaction: 'pointer' | 'focus' }
  | {
      version: 1;
      type: 'preview-wheel';
      routeId: string;
      deltaX: number;
      deltaY: number;
      deltaMode: 0 | 1 | 2;
      shiftKey: boolean;
      ctrlKey: boolean;
      altKey: boolean;
      metaKey: boolean;
    }
  | { version: 1; type: 'fps-counter'; fps: number; frameTimeMs: number; fpsCap: number }
  | {
      version: 1;
      type: 'object-clicked';
      objectId: string;
      position: PreviewPosition;
      pointerPosition: PreviewPosition;
    }
  | { version: 1; type: 'runtime-error'; message: string };

export interface PreviewHelloMessage {
  type: 'noveltea-preview-hello';
  version: 1;
  sessionToken: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPosition(value: unknown): value is PreviewPosition {
  return (
    isRecord(value) &&
    typeof value.x === 'number' &&
    Number.isFinite(value.x) &&
    value.x >= 0 &&
    value.x <= 1 &&
    typeof value.y === 'number' &&
    Number.isFinite(value.y) &&
    value.y >= 0 &&
    value.y <= 1
  );
}

function isPreviewTarget(value: unknown): value is PreviewTarget {
  if (!isRecord(value)) return false;
  return (
    (value.collection === undefined || typeof value.collection === 'string') &&
    (value.entityId === undefined || typeof value.entityId === 'string') &&
    (value.kind === undefined || typeof value.kind === 'string') &&
    (value.label === undefined || typeof value.label === 'string')
  );
}

function isPreviewMode(value: unknown): value is PreviewMode {
  return [
    'runtime',
    'material',
    'layout',
    'room',
    'scene',
    'character',
    'dialogue',
    'symbolic',
  ].includes(String(value));
}

export function isPreviewDocument(value: unknown): value is PreviewDocument {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'symbolic') {
    return (
      isPreviewTarget(value.target) &&
      typeof value.label === 'string' &&
      (value.revision === undefined || typeof value.revision === 'string')
    );
  }
  if (
    ![
      'shader-preview',
      'material-preview',
      'layout-preview',
      'room-preview',
      'scene-preview',
      'character-preview',
      'dialogue-preview',
    ].includes(value.kind)
  ) {
    return false;
  }
  if (
    typeof value.recordId !== 'string' ||
    typeof value.revision !== 'string' ||
    !isRecord(value.data)
  ) {
    return false;
  }
  return hasCurrentLegacyPreviewSchema(value as DataPreviewDocument);
}

function isPreviewDiagnosticMessage(value: unknown): value is PreviewDiagnosticMessage {
  if (!isRecord(value)) return false;
  return (
    ['info', 'warning', 'error'].includes(String(value.severity)) &&
    typeof value.message === 'string' &&
    (value.path === undefined || typeof value.path === 'string') &&
    (value.target === undefined || isPreviewTarget(value.target))
  );
}

function isPreviewStateSnapshot(value: unknown): value is PreviewStateSnapshot {
  if (!isRecord(value)) return false;
  return (
    (value.mode === undefined || isPreviewMode(value.mode)) &&
    (value.target === undefined || isPreviewTarget(value.target)) &&
    typeof value.ready === 'boolean' &&
    (value.detail === undefined || isRecord(value.detail))
  );
}

function isEnginePreviewSettings(value: unknown): value is EnginePreviewSettings {
  if (!isRecord(value)) return false;
  return (
    (value.showFpsCounter === undefined || typeof value.showFpsCounter === 'boolean') &&
    (value.fpsCap === undefined ||
      (typeof value.fpsCap === 'number' &&
        Number.isFinite(value.fpsCap) &&
        value.fpsCap >= 0 &&
        value.fpsCap <= 1000)) &&
    (value.rmluiRasterSnap === undefined ||
      RMLUI_RASTER_SNAP_MODES.includes(value.rmluiRasterSnap as RmlUiRasterSnapMode))
  );
}

function isRuntimeDebugEntityRef(value: unknown): value is RuntimeDebugEntityRef {
  if (!isRecord(value)) return false;
  return (
    typeof value.type === 'string' &&
    typeof value.id === 'string' &&
    (value.collection === undefined || typeof value.collection === 'string') &&
    (value.label === undefined || typeof value.label === 'string')
  );
}

function isRuntimeDebugWaitingState(value: unknown): value is RuntimeDebugWaitingState {
  if (!isRecord(value)) return false;
  return (
    [
      'unloaded',
      'none',
      'continue',
      'choice',
      'navigation',
      'action',
      'title',
      'paused',
      'error',
      'unknown',
    ].includes(String(value.kind)) &&
    typeof value.canContinue === 'boolean' &&
    (value.reason === undefined || typeof value.reason === 'string')
  );
}

function isRuntimeDebugVariableSnapshot(value: unknown): value is RuntimeDebugVariableSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.label === 'string' &&
    typeof value.type === 'string' &&
    'value' in value &&
    (value.dirty === undefined || typeof value.dirty === 'boolean') &&
    (value.overridden === undefined || typeof value.overridden === 'boolean')
  );
}

function isRuntimeDebugInventoryItemSnapshot(
  value: unknown,
): value is RuntimeDebugInventoryItemSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.label === 'string' &&
    (value.selected === undefined || typeof value.selected === 'boolean') &&
    (value.enabled === undefined || typeof value.enabled === 'boolean') &&
    (value.location === undefined || isRuntimeDebugEntityRef(value.location))
  );
}

function isRuntimeDebugChoiceSnapshot(value: unknown): value is RuntimeDebugChoiceSnapshot {
  if (!isRecord(value)) return false;
  return (
    (value.kind === 'dialogue' || value.kind === 'scene') &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.label === 'string' &&
    typeof value.enabled === 'boolean'
  );
}

function isRuntimeDebugNavigationSnapshot(value: unknown): value is RuntimeDebugNavigationSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.exitId === 'string' &&
    value.exitId.length > 0 &&
    typeof value.direction === 'number' &&
    Number.isInteger(value.direction) &&
    typeof value.label === 'string' &&
    typeof value.enabled === 'boolean'
  );
}

function isRuntimeDebugActionSnapshot(value: unknown): value is RuntimeDebugActionSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.verbId === 'string' &&
    typeof value.label === 'string' &&
    Array.isArray(value.bindingOrder) &&
    value.bindingOrder.every((slotId) => typeof slotId === 'string' && slotId.length > 0) &&
    typeof value.selectedCount === 'number' &&
    Number.isInteger(value.selectedCount) &&
    (value.rank === undefined ||
      (typeof value.rank === 'number' && Number.isInteger(value.rank))) &&
    (value.primary === undefined || typeof value.primary === 'boolean') &&
    typeof value.enabled === 'boolean' &&
    (value.reason === undefined || typeof value.reason === 'string')
  );
}

function isRuntimeDebugVerbOfferSnapshot(value: unknown): value is RuntimeDebugVerbOfferSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.verbId === 'string' &&
    value.verbId.length > 0 &&
    typeof value.slotId === 'string' &&
    value.slotId.length > 0 &&
    typeof value.label === 'string' &&
    Array.isArray(value.bindingOrder) &&
    value.bindingOrder.every((slotId) => typeof slotId === 'string' && slotId.length > 0) &&
    typeof value.rank === 'number' &&
    Number.isInteger(value.rank) &&
    typeof value.primary === 'boolean'
  );
}

function isPreviewInteractionSubject(value: unknown): value is PreviewInteractionSubject {
  if (!isRecord(value)) return false;
  if (value.kind === 'character' || value.kind === 'interactable')
    return typeof value.id === 'string' && value.id.length > 0 && Object.keys(value).length === 2;
  return (
    value.kind === 'feature' &&
    (value.ownerKind === 'room' || value.ownerKind === 'interactable') &&
    typeof value.ownerId === 'string' &&
    value.ownerId.length > 0 &&
    typeof value.featureId === 'string' &&
    value.featureId.length > 0 &&
    Object.keys(value).length === 4
  );
}

function isPreviewClickableTarget(value: unknown): value is PreviewClickableTarget {
  if (!isRecord(value) || typeof value.label !== 'string') return false;
  return value.kind === 'subject'
    ? isPreviewInteractionSubject(value.subject)
    : value.kind === 'exit' && typeof value.exitId === 'string' && value.exitId.length > 0;
}

function isRuntimeDebugAvailableInputsSnapshot(
  value: unknown,
): value is RuntimeDebugAvailableInputsSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.continue === 'boolean' &&
    Array.isArray(value.choices) &&
    value.choices.every(isRuntimeDebugChoiceSnapshot) &&
    Array.isArray(value.navigation) &&
    value.navigation.every(isRuntimeDebugNavigationSnapshot) &&
    Array.isArray(value.actions) &&
    value.actions.every(isRuntimeDebugActionSnapshot) &&
    Array.isArray(value.verbOffers) &&
    value.verbOffers.every(isRuntimeDebugVerbOfferSnapshot) &&
    typeof value.verbMenuOpen === 'boolean' &&
    Array.isArray(value.selectedSubjects) &&
    value.selectedSubjects.every(isPreviewInteractionSubject) &&
    Array.isArray(value.clickableTargets) &&
    value.clickableTargets.every(isPreviewClickableTarget)
  );
}

function isRuntimeDebugDiagnosticSnapshot(value: unknown): value is RuntimeDebugDiagnosticSnapshot {
  if (!isRecord(value)) return false;
  return (
    ['info', 'warning', 'error'].includes(String(value.severity)) &&
    typeof value.message === 'string' &&
    (value.category === undefined || typeof value.category === 'string') &&
    (value.path === undefined || typeof value.path === 'string') &&
    (value.source === undefined || isRuntimeDebugEntityRef(value.source)) &&
    (value.scriptContext === undefined || typeof value.scriptContext === 'string') &&
    (value.hookContext === undefined || typeof value.hookContext === 'string') &&
    (value.luaTraceback === undefined || typeof value.luaTraceback === 'string')
  );
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isRuntimeDebugGameplayInstanceSnapshot(
  value: unknown,
): value is RuntimeDebugGameplayInstanceSnapshot {
  if (!isRecord(value)) return false;
  return (
    ['room', 'character', 'interactable'].includes(String(value.kind)) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.declared === 'boolean' &&
    ['declared', 'archetype', 'compiled-definition', 'clone'].includes(String(value.provenance)) &&
    (value.archetype === null || typeof value.archetype === 'string') &&
    (value.source === null || typeof value.source === 'string')
  );
}

function isRuntimeDebugPublicationSnapshot(
  value: unknown,
): value is RuntimeDebugPublicationSnapshot {
  if (!isRecord(value)) return false;
  return (
    isNonnegativeInteger(value.revision) &&
    isNonnegativeInteger(value.presentationRevision) &&
    isNonnegativeInteger(value.observationCount) &&
    isNonnegativeInteger(value.actorCount) &&
    isNonnegativeInteger(value.interactableCount) &&
    isNonnegativeInteger(value.propCount) &&
    isNonnegativeInteger(value.environmentCount) &&
    isNonnegativeInteger(value.layoutCount) &&
    isNonnegativeInteger(value.desiredAudioCount) &&
    Array.isArray(value.gameplayInstances) &&
    value.gameplayInstances.every(isRuntimeDebugGameplayInstanceSnapshot)
  );
}

export function isRuntimeDebugSnapshot(value: unknown): value is RuntimeDebugSnapshot {
  if (!isRecord(value)) return false;
  return (
    (value.requestId === undefined || typeof value.requestId === 'string') &&
    typeof value.loaded === 'boolean' &&
    typeof value.running === 'boolean' &&
    (value.shellMode === undefined || typeof value.shellMode === 'string') &&
    (value.runtimeMode === undefined || typeof value.runtimeMode === 'string') &&
    (value.gameplayPaused === undefined || typeof value.gameplayPaused === 'boolean') &&
    (value.entrypoint === undefined || isRuntimeDebugEntityRef(value.entrypoint)) &&
    (value.currentEntity === undefined || isRuntimeDebugEntityRef(value.currentEntity)) &&
    (value.currentRoomId === undefined || typeof value.currentRoomId === 'string') &&
    (value.currentMapId === undefined || typeof value.currentMapId === 'string') &&
    (value.currentDialogueId === undefined || typeof value.currentDialogueId === 'string') &&
    isRuntimeDebugWaitingState(value.waiting) &&
    isRuntimeDebugAvailableInputsSnapshot(value.availableInputs) &&
    Array.isArray(value.variables) &&
    value.variables.every(isRuntimeDebugVariableSnapshot) &&
    Array.isArray(value.inventory) &&
    value.inventory.every(isRuntimeDebugInventoryItemSnapshot) &&
    Array.isArray(value.selectedSubjects) &&
    value.selectedSubjects.every(isPreviewInteractionSubject) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(isRuntimeDebugDiagnosticSnapshot) &&
    isRecord(value.saveSnapshot) &&
    isRuntimeDebugPublicationSnapshot(value.publication)
  );
}

function isRuntimeFastForwardStopReason(value: unknown): value is RuntimeFastForwardStopReason {
  return [
    'choice-available',
    'navigation-available',
    'action-available',
    'explicit-input',
    'blocking-ui',
    'ui-target-available',
    'error',
    'budget-exhausted',
    'stabilization-limit',
    'game-end',
    'unloaded',
    'unknown',
  ].includes(String(value));
}

function isRuntimeFastForwardResult(value: unknown): value is RuntimeFastForwardResult {
  if (!isRecord(value)) return false;
  return (
    isRuntimeFastForwardStopReason(value.reason) &&
    typeof value.stepsApplied === 'number' &&
    Number.isInteger(value.stepsApplied) &&
    value.stepsApplied >= 0 &&
    typeof value.ticksApplied === 'number' &&
    Number.isInteger(value.ticksApplied) &&
    value.ticksApplied >= 0 &&
    (value.lastInput === undefined || typeof value.lastInput === 'string') &&
    (value.semanticInputBudget === undefined ||
      (typeof value.semanticInputBudget === 'number' &&
        Number.isInteger(value.semanticInputBudget) &&
        value.semanticInputBudget >= 0)) &&
    (value.simulatedTickBudget === undefined ||
      (typeof value.simulatedTickBudget === 'number' &&
        Number.isInteger(value.simulatedTickBudget) &&
        value.simulatedTickBudget >= 0)) &&
    (value.stabilizationTickBudget === undefined ||
      (typeof value.stabilizationTickBudget === 'number' &&
        Number.isInteger(value.stabilizationTickBudget) &&
        value.stabilizationTickBudget >= 0)) &&
    (value.simulatedSecondsBudget === undefined ||
      (typeof value.simulatedSecondsBudget === 'number' &&
        Number.isFinite(value.simulatedSecondsBudget) &&
        value.simulatedSecondsBudget >= 0)) &&
    (value.diagnostic === undefined || typeof value.diagnostic === 'string') &&
    isRuntimeDebugSnapshot(value.finalSnapshot)
  );
}

function isRuntimeDebugEventKind(value: unknown): value is RuntimeDebugEventKind {
  return [
    'variable-set',
    'variable-reset',
    'inventory-give',
    'inventory-remove',
    'room-teleport',
    'instance-create',
    'instance-replace-configuration',
    'instance-clear-configuration',
    'instance-destroy',
    'room-exit-retarget',
    'object-select',
    'object-clear-selection',
    'action-run',
  ].includes(String(value));
}

function isRuntimeDebugEvent(value: unknown): value is RuntimeDebugEvent {
  if (!isRecord(value)) return false;
  return (
    (value.requestId === undefined || typeof value.requestId === 'string') &&
    isRuntimeDebugEventKind(value.kind) &&
    value.debugOnly === true &&
    typeof value.label === 'string' &&
    (value.message === undefined || typeof value.message === 'string') &&
    (value.target === undefined || isRuntimeDebugEntityRef(value.target)) &&
    (value.secondaryTargets === undefined ||
      (Array.isArray(value.secondaryTargets) &&
        value.secondaryTargets.every(isRuntimeDebugEntityRef))) &&
    (value.rejected === undefined || typeof value.rejected === 'boolean')
  );
}

function isPreviewResolution(value: unknown): value is { width: number; height: number } {
  if (!isRecord(value)) return false;
  return (
    Number.isInteger(value.width) &&
    Number(value.width) > 0 &&
    Number(value.width) <= 10000 &&
    Number.isInteger(value.height) &&
    Number(value.height) > 0 &&
    Number(value.height) <= 10000
  );
}

function isScalePolicy(value: unknown) {
  return (
    isRecord(value) &&
    (value.ui === 'inherit' || value.ui === 'ignore') &&
    (value.text === 'inherit' || value.text === 'ignore')
  );
}

function isAccessibilityScalePolicy(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.enabled === 'boolean' &&
    typeof value.minimum === 'number' &&
    Number.isFinite(value.minimum) &&
    value.minimum > 0 &&
    typeof value.maximum === 'number' &&
    Number.isFinite(value.maximum) &&
    value.maximum >= value.minimum
  );
}

function isAuthoredPreviewEnvironment(value: unknown): value is AuthoredPreviewEnvironment {
  if (!isRecord(value) || !isRecord(value.profile) || !isRecord(value.project)) return false;
  const accessibility = value.project.accessibility;
  return (
    typeof value.profile.name === 'string' &&
    value.profile.name.length > 0 &&
    isPreviewResolution(value.profile.nativeResolution) &&
    isScalePolicy(value.profile.scalePolicy) &&
    isPreviewResolution(value.project.referenceResolution) &&
    (value.project.worldRasterPolicy === 'capped' ||
      value.project.worldRasterPolicy === 'native') &&
    typeof value.project.barColor === 'string' &&
    /^#[0-9a-fA-F]{6}$/.test(value.project.barColor) &&
    isRecord(accessibility) &&
    isAccessibilityScalePolicy(accessibility.uiScale) &&
    isAccessibilityScalePolicy(accessibility.textScale)
  );
}

export function isEditorToPreviewMessage(value: unknown): value is EditorToPreviewMessage {
  if (
    !isRecord(value) ||
    value.version !== PREVIEW_PROTOCOL_VERSION ||
    typeof value.type !== 'string' ||
    typeof value.requestId !== 'string'
  ) {
    return false;
  }
  switch (value.type) {
    case 'play':
    case 'stop':
    case 'runtime-reset':
    case 'runtime-start':
    case 'runtime-stop':
    case 'runtime-continue':
    case 'runtime-fast-forward-to-input':
    case 'runtime-clear-subject-selection':
    case 'runtime-request-debug-snapshot':
    case 'request-preview-state':
      return true;
    case 'runtime-request-asset-profiler':
      return value.mode === 'full'
        ? value.sessionId === undefined && value.afterSequence === undefined
        : value.mode === 'delta' &&
            isCanonicalUnsignedDecimal(value.sessionId) &&
            isCanonicalUnsignedDecimal(value.afterSequence);
    case 'runtime-load-compiled-project':
      return (
        'compiledProject' in value &&
        (value.shaderMaterialMetadata === undefined || isRecord(value.shaderMaterialMetadata)) &&
        (value.assets === undefined ||
          (Array.isArray(value.assets) &&
            value.assets.every(
              (item) =>
                isRecord(item) &&
                typeof item.sourcePath === 'string' &&
                typeof item.runtimePath === 'string',
            )))
      );
    case 'runtime-step':
      return (
        value.deltaSeconds === undefined ||
        (typeof value.deltaSeconds === 'number' &&
          Number.isFinite(value.deltaSeconds) &&
          value.deltaSeconds >= 0)
      );
    case 'runtime-dialogue-choice':
      return typeof value.edgeId === 'string' && value.edgeId.length > 0;
    case 'runtime-scene-choice':
      return typeof value.optionId === 'string' && value.optionId.length > 0;
    case 'runtime-navigate':
      return typeof value.exitId === 'string' && value.exitId.length > 0;
    case 'runtime-select-subjects':
      return Array.isArray(value.subjects) && value.subjects.every(isPreviewInteractionSubject);
    case 'runtime-primary-activate':
    case 'runtime-open-verb-menu':
      return isPreviewInteractionSubject(value.subject);
    case 'runtime-run-interaction':
      return (
        typeof value.verbId === 'string' &&
        value.verbId.length > 0 &&
        Array.isArray(value.bindings) &&
        value.bindings.every(
          (binding) =>
            isRecord(binding) &&
            typeof binding.slotId === 'string' &&
            binding.slotId.length > 0 &&
            isPreviewInteractionSubject(binding.subject),
        )
      );
    case 'runtime-set-variable':
      return (
        typeof value.variableId === 'string' &&
        value.variableId.length > 0 &&
        'value' in value &&
        value.value !== undefined
      );
    case 'runtime-reset-variable':
      return typeof value.variableId === 'string' && value.variableId.length > 0;
    case 'runtime-give-object':
    case 'runtime-remove-inventory-object':
      return typeof value.objectId === 'string' && value.objectId.length > 0;
    case 'runtime-teleport-room':
      return typeof value.roomId === 'string' && value.roomId.length > 0;
    case 'runtime-create-instance':
      return (
        ['room', 'character', 'interactable'].includes(String(value.instanceKind)) &&
        ['archetype', 'compiled', 'effective'].includes(String(value.sourceKind)) &&
        typeof value.sourceId === 'string' &&
        value.sourceId.length > 0
      );
    case 'runtime-replace-instance-configuration':
      return (
        ['room', 'character', 'interactable'].includes(String(value.instanceKind)) &&
        typeof value.instanceId === 'string' &&
        value.instanceId.length > 0 &&
        ['archetype', 'compiled', 'effective'].includes(String(value.sourceKind)) &&
        typeof value.sourceId === 'string' &&
        value.sourceId.length > 0
      );
    case 'runtime-clear-instance-configuration':
    case 'runtime-destroy-instance':
      return (
        ['room', 'character', 'interactable'].includes(String(value.instanceKind)) &&
        typeof value.instanceId === 'string' &&
        value.instanceId.length > 0
      );
    case 'runtime-retarget-room-exit':
      return (
        typeof value.roomId === 'string' &&
        value.roomId.length > 0 &&
        typeof value.exitId === 'string' &&
        value.exitId.length > 0 &&
        typeof value.targetRoomId === 'string' &&
        value.targetRoomId.length > 0
      );
    case 'load-preview-document':
    case 'update-preview-document': {
      if (!isPreviewDocument(value.document)) return false;
      return value.document.kind === 'layout-preview'
        ? isAuthoredPreviewEnvironment(value.environment)
        : value.environment === undefined;
    }
    case 'apply-focused-editor-document':
      return (
        typeof value.applySequence === 'number' &&
        Number.isSafeInteger(value.applySequence) &&
        value.applySequence >= 0 &&
        focusedRecordPreviewDocumentSchema.safeParse(value.document).success
      );
    case 'set-preview-mode':
      return isPreviewMode(value.mode);
    case 'set-engine-settings':
      return isEnginePreviewSettings(value.settings);
    case 'set-preview-activity':
      return (
        typeof value.active === 'boolean' &&
        (value.visible === undefined || typeof value.visible === 'boolean')
      );
    case 'set-preview-wheel-routing':
      return (
        (value.policy === 'editor-scroll' || value.policy === 'preview-input') &&
        typeof value.routeId === 'string' &&
        value.routeId.length > 0
      );
    case 'request-preview-snapshot':
      return typeof value.snapshotId === 'string';
    default:
      return false;
  }
}

export function isPreviewHelloMessage(value: unknown): value is PreviewHelloMessage {
  return (
    isRecord(value) &&
    value.type === 'noveltea-preview-hello' &&
    value.version === PREVIEW_PROTOCOL_VERSION &&
    typeof value.sessionToken === 'string'
  );
}

export function isPreviewToEditorMessage(value: unknown): value is PreviewToEditorMessage {
  if (
    !isRecord(value) ||
    value.version !== PREVIEW_PROTOCOL_VERSION ||
    typeof value.type !== 'string'
  ) {
    return false;
  }
  switch (value.type) {
    case 'ready':
      return (
        Array.isArray(value.capabilities) &&
        value.capabilities.every((item) => typeof item === 'string') &&
        typeof value.hostGeneration === 'number' &&
        Number.isSafeInteger(value.hostGeneration) &&
        value.hostGeneration > 0 &&
        typeof value.transportGeneration === 'number' &&
        Number.isSafeInteger(value.transportGeneration) &&
        value.transportGeneration > 0 &&
        shaderVariantSchema.safeParse(value.activeShaderVariant).success
      );
    case 'capabilities':
      return (
        Array.isArray(value.capabilities) &&
        value.capabilities.every((item) => typeof item === 'string')
      );
    case 'command-result':
      return (
        typeof value.requestId === 'string' &&
        typeof value.ok === 'boolean' &&
        (value.error === undefined || typeof value.error === 'string') &&
        (value.errorCode === undefined || typeof value.errorCode === 'string') &&
        value.snapshot === undefined &&
        value.payload === undefined &&
        value.state === undefined
      );
    case 'preview-state':
      return isPreviewStateSnapshot(value.state);
    case 'preview-snapshot':
      return typeof value.snapshotId === 'string' && typeof value.dataUrl === 'string';
    case 'runtime-debug-snapshot':
      return (
        (value.requestId === undefined || typeof value.requestId === 'string') &&
        isRuntimeDebugSnapshot(value.snapshot)
      );
    case 'runtime-asset-profiler':
      return typeof value.requestId === 'string' && isAssetProfilerWirePayload(value.payload);
    case 'runtime-debug-event':
      return (
        (value.requestId === undefined || typeof value.requestId === 'string') &&
        isRuntimeDebugEvent(value.event)
      );
    case 'runtime-fast-forward-result':
      return typeof value.requestId === 'string' && isRuntimeFastForwardResult(value.result);
    case 'preview-diagnostic':
      return isPreviewDiagnosticMessage(value.diagnostic);
    case 'focused-document-applied':
      return (
        typeof value.requestId === 'string' &&
        typeof value.hostGeneration === 'number' &&
        Number.isSafeInteger(value.hostGeneration) &&
        value.hostGeneration > 0 &&
        typeof value.applySequence === 'number' &&
        Number.isSafeInteger(value.applySequence) &&
        value.applySequence >= 0 &&
        appliedPreviewDocumentResultSchema.safeParse(value.result).success &&
        Array.isArray(value.diagnostics) &&
        value.diagnostics.every(isPreviewDiagnosticMessage)
      );
    case 'preview-diagnostics-replaced':
      return (
        typeof value.scopeKey === 'string' &&
        value.scopeKey.length > 0 &&
        Array.isArray(value.diagnostics) &&
        value.diagnostics.every(isPreviewDiagnosticMessage)
      );
    case 'preview-object-selected':
    case 'preview-object-hovered':
      return (
        typeof value.objectId === 'string' &&
        (value.position === undefined || isPosition(value.position))
      );
    case 'preview-interacted':
      return value.interaction === 'pointer' || value.interaction === 'focus';
    case 'preview-wheel':
      return (
        typeof value.routeId === 'string' &&
        value.routeId.length > 0 &&
        typeof value.deltaX === 'number' &&
        Number.isFinite(value.deltaX) &&
        typeof value.deltaY === 'number' &&
        Number.isFinite(value.deltaY) &&
        (value.deltaMode === 0 || value.deltaMode === 1 || value.deltaMode === 2) &&
        typeof value.shiftKey === 'boolean' &&
        typeof value.ctrlKey === 'boolean' &&
        typeof value.altKey === 'boolean' &&
        typeof value.metaKey === 'boolean'
      );
    case 'fps-counter':
      return (
        typeof value.fps === 'number' &&
        Number.isFinite(value.fps) &&
        value.fps >= 0 &&
        typeof value.frameTimeMs === 'number' &&
        Number.isFinite(value.frameTimeMs) &&
        value.frameTimeMs >= 0 &&
        typeof value.fpsCap === 'number' &&
        Number.isFinite(value.fpsCap) &&
        value.fpsCap >= 0 &&
        value.fpsCap <= 1000
      );
    case 'object-clicked':
      return (
        typeof value.objectId === 'string' &&
        isPosition(value.position) &&
        isPosition(value.pointerPosition)
      );
    case 'runtime-error':
      return typeof value.message === 'string';
    default:
      return false;
  }
}

export function validatePreviewHandshake(
  event: MessageEvent,
  iframeWindow: Window | null,
  session: EnginePreviewSession,
): event is MessageEvent<PreviewHelloMessage> {
  return (
    event.source === iframeWindow &&
    event.origin === session.origin &&
    isPreviewHelloMessage(event.data) &&
    event.data.sessionToken === session.sessionToken
  );
}
