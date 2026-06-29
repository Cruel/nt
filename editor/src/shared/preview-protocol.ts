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

export type PreviewMode = 'runtime' | 'material' | 'ui-layout' | 'room' | 'scene' | 'character' | 'symbolic';

export type PreviewDocument =
  | { kind: 'symbolic'; target: PreviewTarget; label: string; revision?: string }
  | {
      kind: 'material-preview' | 'ui-layout-preview' | 'room-preview' | 'scene-preview' | 'character-preview';
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

export type EditorToPreviewMessage =
  | { version: 1; type: 'set-demo-position'; requestId: string; position: PreviewPosition }
  | { version: 1; type: 'reset-demo'; requestId: string }
  | { version: 1; type: 'play'; requestId: string }
  | { version: 1; type: 'stop'; requestId: string }
  | { version: 1; type: 'request-state'; requestId: string }
  | { version: 1; type: 'runtime-reset'; requestId: string }
  | { version: 1; type: 'runtime-continue'; requestId: string }
  | { version: 1; type: 'runtime-dialogue-option'; requestId: string; optionIndex: number }
  | { version: 1; type: 'runtime-navigate'; requestId: string; direction: number }
  | { version: 1; type: 'runtime-select-object'; requestId: string; objectId: string }
  | { version: 1; type: 'runtime-clear-object-selection'; requestId: string }
  | { version: 1; type: 'runtime-run-action'; requestId: string; verbId: string; objectIds: string[] }
  | { version: 1; type: 'load-preview-document'; requestId: string; document: PreviewDocument }
  | { version: 1; type: 'update-preview-document'; requestId: string; document: PreviewDocument }
  | { version: 1; type: 'set-preview-mode'; requestId: string; mode: PreviewMode }
  | { version: 1; type: 'request-preview-state'; requestId: string }
  | { version: 1; type: 'request-preview-snapshot'; requestId: string; snapshotId: string };

export type PreviewToEditorMessage =
  | { version: 1; type: 'ready'; capabilities: string[] }
  | { version: 1; type: 'capabilities'; capabilities: string[] }
  | { version: 1; type: 'command-result'; requestId: string; ok: boolean; error?: string }
  | { version: 1; type: 'state'; position: PreviewPosition; running: boolean }
  | { version: 1; type: 'preview-state'; state: PreviewStateSnapshot }
  | { version: 1; type: 'preview-snapshot'; snapshotId: string; dataUrl: string }
  | { version: 1; type: 'preview-diagnostic'; diagnostic: PreviewDiagnosticMessage }
  | { version: 1; type: 'preview-object-selected'; objectId: string; position?: PreviewPosition }
  | { version: 1; type: 'preview-object-hovered'; objectId: string; position?: PreviewPosition }
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
  return ['runtime', 'material', 'ui-layout', 'room', 'scene', 'character', 'symbolic'].includes(String(value));
}

export function isPreviewDocument(value: unknown): value is PreviewDocument {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'symbolic') {
    return isPreviewTarget(value.target) && typeof value.label === 'string' && (value.revision === undefined || typeof value.revision === 'string');
  }
  if (!['material-preview', 'ui-layout-preview', 'room-preview', 'scene-preview', 'character-preview'].includes(value.kind)) {
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
    case 'runtime-continue':
    case 'runtime-clear-object-selection':
    case 'request-preview-state':
      return true;
    case 'runtime-dialogue-option':
      return typeof value.optionIndex === 'number' && Number.isInteger(value.optionIndex);
    case 'runtime-navigate':
      return typeof value.direction === 'number' && Number.isInteger(value.direction);
    case 'runtime-select-object':
      return typeof value.objectId === 'string';
    case 'runtime-run-action':
      return typeof value.verbId === 'string' && Array.isArray(value.objectIds) && value.objectIds.every((item) => typeof item === 'string');
    case 'load-preview-document':
    case 'update-preview-document':
      return isPreviewDocument(value.document);
    case 'set-preview-mode':
      return isPreviewMode(value.mode);
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
        (value.error === undefined || typeof value.error === 'string')
      );
    case 'state':
      return isPosition(value.position) && typeof value.running === 'boolean';
    case 'preview-state':
      return isPreviewStateSnapshot(value.state);
    case 'preview-snapshot':
      return typeof value.snapshotId === 'string' && typeof value.dataUrl === 'string';
    case 'preview-diagnostic':
      return isPreviewDiagnosticMessage(value.diagnostic);
    case 'preview-object-selected':
    case 'preview-object-hovered':
      return typeof value.objectId === 'string' && (value.position === undefined || isPosition(value.position));
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
