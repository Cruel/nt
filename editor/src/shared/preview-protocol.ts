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
  | { version: 1; type: 'runtime-run-action'; requestId: string; verbId: string; objectIds: string[] };

export type PreviewToEditorMessage =
  | { version: 1; type: 'ready'; capabilities: string[] }
  | { version: 1; type: 'command-result'; requestId: string; ok: boolean; error?: string }
  | { version: 1; type: 'state'; position: PreviewPosition; running: boolean }
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
  return typeof value === 'object' && value !== null;
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
      return Array.isArray(value.capabilities) && value.capabilities.every((item) => typeof item === 'string');
    case 'command-result':
      return (
        typeof value.requestId === 'string' &&
        typeof value.ok === 'boolean' &&
        (value.error === undefined || typeof value.error === 'string')
      );
    case 'state':
      return isPosition(value.position) && typeof value.running === 'boolean';
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
