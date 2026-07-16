import type { PreviewWheelPolicy } from './preview-wheel-routing';

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

export type PreviewMode = 'runtime' | 'material' | 'layout' | 'room' | 'scene' | 'character' | 'dialogue' | 'symbolic';

export type PreviewDocument =
  | { kind: 'symbolic'; target: PreviewTarget; label: string; revision?: string }
  | {
      kind: 'shader-preview' | 'material-preview' | 'layout-preview' | 'room-preview' | 'scene-preview' | 'character-preview' | 'dialogue-preview';
      recordId: string;
      revision: string;
      data: Record<string, unknown>;
    };

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

export interface EnginePreviewSettings {
  showFpsCounter?: boolean;
  fpsCap?: number;
}

export interface PreviewDisplayProfile {
  aspectRatio: { width: number; height: number };
  orientation: 'landscape' | 'portrait';
  barColor: string;
}

export interface RuntimeDebugEntityRef {
  type: string;
  id: string;
  collection?: string;
  label?: string;
}

export interface RuntimeDebugWaitingState {
  kind: 'unloaded' | 'none' | 'continue' | 'choice' | 'navigation' | 'action' | 'title' | 'paused' | 'error' | 'unknown';
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

export interface RuntimeDebugDialogueOptionSnapshot {
  index: number;
  label: string;
  enabled: boolean;
}

export interface RuntimeDebugNavigationSnapshot {
  index: number;
  label: string;
  enabled: boolean;
}

export interface RuntimeDebugActionSnapshot {
  verbId: string;
  label: string;
  objectCount: number;
  selectedCount: number;
  enabled: boolean;
  reason?: string;
}

export type PreviewInteractionSubject =
  | { kind: 'character'; id: string }
  | { kind: 'interactable'; id: string };

export interface RuntimeDebugAvailableInputsSnapshot {
  continue: boolean;
  dialogueOptions: RuntimeDebugDialogueOptionSnapshot[];
  navigation: RuntimeDebugNavigationSnapshot[];
  actions: RuntimeDebugActionSnapshot[];
  selectedSubjects: PreviewInteractionSubject[];
  clickableTargets: unknown[];
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
  controllerState?: Record<string, unknown>;
}

export interface RuntimeFastForwardResult {
  reason: RuntimeFastForwardStopReason;
  stepsApplied: number;
  ticksApplied: number;
  lastInput?: 'continue' | 'tick' | string;
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
  | { version: 1; type: 'set-demo-position'; requestId: string; position: PreviewPosition }
  | { version: 1; type: 'reset-demo'; requestId: string }
  | { version: 1; type: 'play'; requestId: string }
  | { version: 1; type: 'stop'; requestId: string }
  | { version: 1; type: 'request-state'; requestId: string }
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
  | { version: 1; type: 'runtime-dialogue-option'; requestId: string; optionIndex: number }
  | { version: 1; type: 'runtime-navigate'; requestId: string; direction: number }
  | { version: 1; type: 'runtime-select-subjects'; requestId: string; subjects: PreviewInteractionSubject[] }
  | { version: 1; type: 'runtime-clear-subject-selection'; requestId: string }
  | { version: 1; type: 'runtime-run-interaction'; requestId: string; verbId: string; operands: PreviewInteractionSubject[] }
  | { version: 1; type: 'runtime-request-debug-snapshot'; requestId: string }
  | { version: 1; type: 'runtime-set-variable'; requestId: string; variableId: string; value: unknown }
  | { version: 1; type: 'runtime-reset-variable'; requestId: string; variableId: string }
  | { version: 1; type: 'runtime-give-object'; requestId: string; objectId: string }
  | { version: 1; type: 'runtime-remove-inventory-object'; requestId: string; objectId: string }
  | { version: 1; type: 'runtime-teleport-room'; requestId: string; roomId: string }
  | { version: 1; type: 'load-preview-document'; requestId: string; document: PreviewDocument }
  | { version: 1; type: 'update-preview-document'; requestId: string; document: PreviewDocument }
  | { version: 1; type: 'set-preview-mode'; requestId: string; mode: PreviewMode }
  | { version: 1; type: 'request-preview-state'; requestId: string }
  | { version: 1; type: 'set-engine-settings'; requestId: string; settings: EnginePreviewSettings }
  | { version: 1; type: 'set-preview-display-profile'; requestId: string; profile: PreviewDisplayProfile | null; scaling: { mode: 'responsive' | 'reference'; logicalSize: { width: number; height: number } | null } }
  | { version: 1; type: 'set-preview-activity'; requestId: string; active: boolean; visible?: boolean }
  | { version: 1; type: 'set-preview-wheel-routing'; requestId: string; policy: PreviewWheelPolicy; routeId: string }
  | { version: 1; type: 'request-preview-snapshot'; requestId: string; snapshotId: string };

export type PreviewToEditorMessage =
  | { version: 1; type: 'ready'; capabilities: string[] }
  | { version: 1; type: 'capabilities'; capabilities: string[] }
  | { version: 1; type: 'command-result'; requestId: string; ok: boolean; error?: string }
  | { version: 1; type: 'state'; position: PreviewPosition; running: boolean }
  | { version: 1; type: 'preview-state'; state: PreviewStateSnapshot }
  | { version: 1; type: 'preview-snapshot'; snapshotId: string; dataUrl: string }
  | { version: 1; type: 'runtime-debug-snapshot'; requestId?: string; snapshot: RuntimeDebugSnapshot }
  | { version: 1; type: 'runtime-debug-event'; requestId?: string; event: RuntimeDebugEvent }
  | { version: 1; type: 'runtime-fast-forward-result'; requestId: string; result: RuntimeFastForwardResult }
  | { version: 1; type: 'preview-diagnostic'; diagnostic: PreviewDiagnosticMessage }
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
  return ['runtime', 'material', 'layout', 'room', 'scene', 'character', 'dialogue', 'symbolic'].includes(String(value));
}

export function isPreviewDocument(value: unknown): value is PreviewDocument {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'symbolic') {
    return isPreviewTarget(value.target) && typeof value.label === 'string' && (value.revision === undefined || typeof value.revision === 'string');
  }
  if (!['shader-preview', 'material-preview', 'layout-preview', 'room-preview', 'scene-preview', 'character-preview', 'dialogue-preview'].includes(value.kind)) {
    return false;
  }
  return typeof value.recordId === 'string' && typeof value.revision === 'string' && isRecord(value.data);
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
    (value.fpsCap === undefined || (typeof value.fpsCap === 'number' && Number.isFinite(value.fpsCap) && value.fpsCap >= 0 && value.fpsCap <= 1000))
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
    ['unloaded', 'none', 'continue', 'choice', 'navigation', 'action', 'title', 'paused', 'error', 'unknown'].includes(String(value.kind)) &&
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

function isRuntimeDebugInventoryItemSnapshot(value: unknown): value is RuntimeDebugInventoryItemSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.label === 'string' &&
    (value.selected === undefined || typeof value.selected === 'boolean') &&
    (value.enabled === undefined || typeof value.enabled === 'boolean') &&
    (value.location === undefined || isRuntimeDebugEntityRef(value.location))
  );
}

function isRuntimeDebugDialogueOptionSnapshot(value: unknown): value is RuntimeDebugDialogueOptionSnapshot {
  if (!isRecord(value)) return false;
  return typeof value.index === 'number' && Number.isInteger(value.index) && typeof value.label === 'string' && typeof value.enabled === 'boolean';
}

function isRuntimeDebugNavigationSnapshot(value: unknown): value is RuntimeDebugNavigationSnapshot {
  if (!isRecord(value)) return false;
  return typeof value.index === 'number' && Number.isInteger(value.index) && typeof value.label === 'string' && typeof value.enabled === 'boolean';
}

function isRuntimeDebugActionSnapshot(value: unknown): value is RuntimeDebugActionSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.verbId === 'string' &&
    typeof value.label === 'string' &&
    typeof value.objectCount === 'number' &&
    Number.isInteger(value.objectCount) &&
    typeof value.selectedCount === 'number' &&
    Number.isInteger(value.selectedCount) &&
    typeof value.enabled === 'boolean' &&
    (value.reason === undefined || typeof value.reason === 'string')
  );
}

function isPreviewInteractionSubject(value: unknown): value is PreviewInteractionSubject {
  return isRecord(value)
    && (value.kind === 'character' || value.kind === 'interactable')
    && typeof value.id === 'string'
    && value.id.length > 0
    && Object.keys(value).length === 2;
}

function isRuntimeDebugAvailableInputsSnapshot(value: unknown): value is RuntimeDebugAvailableInputsSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.continue === 'boolean' &&
    Array.isArray(value.dialogueOptions) &&
    value.dialogueOptions.every(isRuntimeDebugDialogueOptionSnapshot) &&
    Array.isArray(value.navigation) &&
    value.navigation.every(isRuntimeDebugNavigationSnapshot) &&
    Array.isArray(value.actions) &&
    value.actions.every(isRuntimeDebugActionSnapshot) &&
    Array.isArray(value.selectedSubjects) &&
    value.selectedSubjects.every(isPreviewInteractionSubject) &&
    Array.isArray(value.clickableTargets)
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
    (value.controllerState === undefined || isRecord(value.controllerState))
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
      (typeof value.semanticInputBudget === 'number' && Number.isInteger(value.semanticInputBudget) && value.semanticInputBudget >= 0)) &&
    (value.simulatedTickBudget === undefined ||
      (typeof value.simulatedTickBudget === 'number' && Number.isInteger(value.simulatedTickBudget) && value.simulatedTickBudget >= 0)) &&
    (value.stabilizationTickBudget === undefined ||
      (typeof value.stabilizationTickBudget === 'number' && Number.isInteger(value.stabilizationTickBudget) && value.stabilizationTickBudget >= 0)) &&
    (value.simulatedSecondsBudget === undefined ||
      (typeof value.simulatedSecondsBudget === 'number' && Number.isFinite(value.simulatedSecondsBudget) && value.simulatedSecondsBudget >= 0)) &&
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
      (Array.isArray(value.secondaryTargets) && value.secondaryTargets.every(isRuntimeDebugEntityRef))) &&
    (value.rejected === undefined || typeof value.rejected === 'boolean')
  );
}

function isPreviewDisplayProfile(value: unknown): value is PreviewDisplayProfile {
  if (!isRecord(value) || !isRecord(value.aspectRatio)) return false;
  return Number.isInteger(value.aspectRatio.width) && Number(value.aspectRatio.width) > 0 && Number(value.aspectRatio.width) <= 10000
    && Number.isInteger(value.aspectRatio.height) && Number(value.aspectRatio.height) > 0 && Number(value.aspectRatio.height) <= 10000
    && (value.orientation === 'landscape' || value.orientation === 'portrait')
    && typeof value.barColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.barColor);
}

export function isEditorToPreviewMessage(value: unknown): value is EditorToPreviewMessage {
  if (!isRecord(value) || value.version !== PREVIEW_PROTOCOL_VERSION || typeof value.type !== 'string' || typeof value.requestId !== 'string') {
    return false;
  }
  switch (value.type) {
    case 'set-demo-position':
      return isPosition(value.position);
    case 'reset-demo':
    case 'play':
    case 'stop':
    case 'request-state':
    case 'runtime-reset':
    case 'runtime-start':
    case 'runtime-stop':
    case 'runtime-continue':
    case 'runtime-fast-forward-to-input':
    case 'runtime-clear-subject-selection':
    case 'runtime-request-debug-snapshot':
    case 'request-preview-state':
      return true;
    case 'runtime-load-compiled-project':
      return 'compiledProject' in value && (
        value.shaderMaterialMetadata === undefined || isRecord(value.shaderMaterialMetadata)
      ) && (
        value.assets === undefined
        || (Array.isArray(value.assets) && value.assets.every((item) => isRecord(item)
          && typeof item.sourcePath === 'string'
          && typeof item.runtimePath === 'string'))
      );
    case 'runtime-step':
      return value.deltaSeconds === undefined || (typeof value.deltaSeconds === 'number' && Number.isFinite(value.deltaSeconds) && value.deltaSeconds >= 0);
    case 'runtime-dialogue-option':
      return typeof value.optionIndex === 'number' && Number.isInteger(value.optionIndex);
    case 'runtime-navigate':
      return typeof value.direction === 'number' && Number.isInteger(value.direction);
    case 'runtime-select-subjects':
      return Array.isArray(value.subjects) && value.subjects.every(isPreviewInteractionSubject);
    case 'runtime-run-interaction':
      return typeof value.verbId === 'string' && value.verbId.length > 0
        && Array.isArray(value.operands) && value.operands.every(isPreviewInteractionSubject);
    case 'runtime-set-variable':
      return typeof value.variableId === 'string' && value.variableId.length > 0 && 'value' in value && value.value !== undefined;
    case 'runtime-reset-variable':
      return typeof value.variableId === 'string' && value.variableId.length > 0;
    case 'runtime-give-object':
    case 'runtime-remove-inventory-object':
      return typeof value.objectId === 'string' && value.objectId.length > 0;
    case 'runtime-teleport-room':
      return typeof value.roomId === 'string' && value.roomId.length > 0;
    case 'load-preview-document':
    case 'update-preview-document':
      return isPreviewDocument(value.document);
    case 'set-preview-mode':
      return isPreviewMode(value.mode);
    case 'set-engine-settings':
      return isEnginePreviewSettings(value.settings);
    case 'set-preview-display-profile': {
      if (value.profile !== null && !isPreviewDisplayProfile(value.profile)) return false;
      if (!isRecord(value.scaling) || (value.scaling.mode !== 'responsive' && value.scaling.mode !== 'reference')) return false;
      const size = value.scaling.logicalSize;
      return size === null || (isRecord(size) && Number.isInteger(size.width) && Number(size.width) > 0 && Number(size.width) <= 4096 && Number.isInteger(size.height) && Number(size.height) > 0 && Number(size.height) <= 4096);
    }
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
  if (!isRecord(value) || value.version !== PREVIEW_PROTOCOL_VERSION || typeof value.type !== 'string') {
    return false;
  }
  switch (value.type) {
    case 'ready':
    case 'capabilities':
      return Array.isArray(value.capabilities) && value.capabilities.every((item) => typeof item === 'string');
    case 'command-result':
      return (
        typeof value.requestId === 'string' &&
        typeof value.ok === 'boolean' &&
        (value.error === undefined || typeof value.error === 'string') &&
        value.snapshot === undefined &&
        value.payload === undefined &&
        value.state === undefined
      );
    case 'state':
      return isPosition(value.position) && typeof value.running === 'boolean';
    case 'preview-state':
      return isPreviewStateSnapshot(value.state);
    case 'preview-snapshot':
      return typeof value.snapshotId === 'string' && typeof value.dataUrl === 'string';
    case 'runtime-debug-snapshot':
      return (value.requestId === undefined || typeof value.requestId === 'string') && isRuntimeDebugSnapshot(value.snapshot);
    case 'runtime-debug-event':
      return (value.requestId === undefined || typeof value.requestId === 'string') && isRuntimeDebugEvent(value.event);
    case 'runtime-fast-forward-result':
      return typeof value.requestId === 'string' && isRuntimeFastForwardResult(value.result);
    case 'preview-diagnostic':
      return isPreviewDiagnosticMessage(value.diagnostic);
    case 'preview-object-selected':
    case 'preview-object-hovered':
      return typeof value.objectId === 'string' && (value.position === undefined || isPosition(value.position));
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
      return typeof value.objectId === 'string' && isPosition(value.position) && isPosition(value.pointerPosition);
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
