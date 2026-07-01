import { describe, expect, it } from 'vitest';
import {
  isEditorToPreviewMessage,
  isPreviewDocument,
  isPreviewToEditorMessage,
  validatePreviewHandshake,
  type EnginePreviewSession,
} from '../../shared/preview-protocol';

describe('preview protocol validation', () => {
  it('rejects malformed messages', () => {
    expect(isPreviewToEditorMessage({ version: 1, type: 'state', position: { x: 2, y: 0 }, running: true })).toBe(false);
    expect(isPreviewToEditorMessage({ version: 2, type: 'ready', capabilities: [] })).toBe(false);
    expect(isPreviewToEditorMessage({ version: 1, type: 'object-clicked', objectId: 42 })).toBe(false);
  });

  it('accepts valid preview events', () => {
    expect(isPreviewToEditorMessage({ version: 1, type: 'ready', capabilities: ['demo-click'] })).toBe(true);
    expect(isPreviewToEditorMessage({
      version: 1,
      type: 'object-clicked',
      objectId: 'demo-triangle',
      position: { x: 0.5, y: 0.5 },
      pointerPosition: { x: 0.5, y: 0.5 },
    })).toBe(true);
  });

  it('accepts and rejects authoring preview protocol messages', () => {
    const document = {
      kind: 'symbolic',
      target: { collection: 'materials', entityId: 'mat-a' },
      label: 'Material A',
    };
    expect(isPreviewDocument(document)).toBe(true);
    expect(isPreviewDocument({ kind: 'shader-preview', recordId: 'shader-a', revision: 'rev', data: {} })).toBe(true);
    expect(isPreviewDocument({ kind: 'layout-preview', recordId: 'layout-a', revision: 'rev', data: {} })).toBe(true);
    expect(isPreviewDocument({ kind: 'room-preview', recordId: 'room-a', revision: 'rev', data: {} })).toBe(true);
    expect(isPreviewDocument({ kind: 'dialogue-preview', recordId: 'dialogue-a', revision: 'rev', data: {} })).toBe(true);
    expect(isEditorToPreviewMessage({ version: 1, type: 'load-preview-document', requestId: 'r1', document })).toBe(true);
    expect(isEditorToPreviewMessage({ version: 1, type: 'set-preview-mode', requestId: 'r2', mode: 'layout' })).toBe(true);
    expect(isEditorToPreviewMessage({ version: 1, type: 'set-preview-mode', requestId: 'r2d', mode: 'dialogue' })).toBe(true);
    expect(isEditorToPreviewMessage({ version: 1, type: 'request-preview-snapshot', requestId: 'r3', snapshotId: 's1' })).toBe(true);
    expect(isEditorToPreviewMessage({ version: 1, type: 'load-preview-document', requestId: 'r1', document: { kind: 'unknown' } })).toBe(false);
    const legacyLayoutMode = `ui-${'layout'}`;
    expect(isEditorToPreviewMessage({ version: 1, type: 'set-preview-mode', requestId: 'r2', mode: legacyLayoutMode })).toBe(false);
    expect(isPreviewToEditorMessage({
      version: 1,
      type: 'preview-diagnostic',
      diagnostic: { severity: 'warning', message: 'Unsupported preview mode' },
    })).toBe(true);
    expect(isPreviewToEditorMessage({ version: 1, type: 'preview-snapshot', snapshotId: 's1', dataUrl: 'data:image/png;base64,test' })).toBe(true);
  });

  it('rejects handshakes from the wrong source, origin, or token', () => {
    const iframeWindow = window;
    const session: EnginePreviewSession = {
      url: 'http://127.0.0.1:5000/?sessionToken=good',
      origin: 'http://127.0.0.1:5000',
      sessionToken: 'good',
    };
    const makeEvent = (source: Window | null, origin: string, sessionToken: string) => ({
      source,
      origin,
      data: { type: 'noveltea-preview-hello', version: 1, sessionToken },
    }) as MessageEvent;

    expect(validatePreviewHandshake(makeEvent(iframeWindow, session.origin, 'good'), iframeWindow, session)).toBe(true);
    expect(validatePreviewHandshake(makeEvent(null, session.origin, 'good'), iframeWindow, session)).toBe(false);
    expect(validatePreviewHandshake(makeEvent(iframeWindow, 'http://127.0.0.1:1', 'good'), iframeWindow, session)).toBe(false);
    expect(validatePreviewHandshake(makeEvent(iframeWindow, session.origin, 'bad'), iframeWindow, session)).toBe(false);
  });
});
