import { describe, expect, it } from 'vitest';
import {
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
