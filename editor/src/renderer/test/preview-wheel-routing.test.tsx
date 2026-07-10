import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { routePreviewWheelToScrollAncestors, type PreviewWheelMessage } from '@/preview/preview-wheel-routing';
import { isEditorToPreviewMessage, isPreviewToEditorMessage } from '../../shared/preview-protocol';

function defineScrollMetrics(
  element: HTMLElement,
  metrics: Partial<Pick<HTMLElement, 'clientWidth' | 'clientHeight' | 'scrollWidth' | 'scrollHeight'>>,
) {
  for (const [key, value] of Object.entries(metrics)) {
    Object.defineProperty(element, key, { value, configurable: true });
  }
}

function makeWheel(overrides: Partial<PreviewWheelMessage> = {}): PreviewWheelMessage {
  return {
    version: 1,
    type: 'preview-wheel',
    routeId: 'preview-lease:test',
    deltaX: 0,
    deltaY: 20,
    deltaMode: 0,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...overrides,
  };
}

function makeScrollTree() {
  const group = document.createElement('div');
  group.dataset.workbenchGroupId = 'group:test';
  const outer = document.createElement('div');
  outer.style.overflowY = 'auto';
  outer.style.overflowX = 'auto';
  const inner = document.createElement('div');
  inner.style.overflowY = 'auto';
  inner.style.overflowX = 'auto';
  const placeholder = document.createElement('div');
  group.append(outer);
  outer.append(inner);
  inner.append(placeholder);
  document.body.append(group);
  defineScrollMetrics(outer, { clientWidth: 100, scrollWidth: 300, clientHeight: 100, scrollHeight: 400 });
  defineScrollMetrics(inner, { clientWidth: 100, scrollWidth: 200, clientHeight: 100, scrollHeight: 200 });
  return { group, outer, inner, placeholder };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('preview wheel protocol', () => {
  it('validates wheel routing commands and iframe wheel messages', () => {
    expect(isEditorToPreviewMessage({
      version: 1,
      type: 'set-preview-wheel-routing',
      requestId: 'request-1',
      policy: 'editor-scroll',
      routeId: 'preview-lease:test',
    })).toBe(true);
    expect(isEditorToPreviewMessage({
      version: 1,
      type: 'set-preview-wheel-routing',
      requestId: 'request-2',
      policy: 'editor-scroll',
    })).toBe(false);
    expect(isEditorToPreviewMessage({
      version: 1,
      type: 'set-preview-wheel-routing',
      requestId: 'request-3',
      policy: 'preview-input',
    })).toBe(false);
    expect(isPreviewToEditorMessage(makeWheel({ deltaX: 0.25, deltaY: 1.75 }))).toBe(true);
    expect(isPreviewToEditorMessage(makeWheel({ deltaY: Number.NaN }))).toBe(false);
    expect(isPreviewToEditorMessage(makeWheel({ deltaMode: 3 as 0 }))).toBe(false);
  });

  it('installs a non-passive capture listener before the generated SDL script', () => {
    const widget = readFileSync('../web/widget.html', 'utf8');
    const listenerIndex = widget.indexOf("window.addEventListener('wheel'");
    const generatedScriptIndex = widget.indexOf('{{{ SCRIPT }}}');
    expect(listenerIndex).toBeGreaterThan(0);
    expect(listenerIndex).toBeLessThan(generatedScriptIndex);
    expect(widget).toContain('if (event.ctrlKey || event.metaKey) return;');
    expect(widget).toContain("'preview-wheel-routing-v1'");
    expect(widget).toContain('event.stopImmediatePropagation()');
    expect(widget).toContain('{ capture: true, passive: false }');
  });
});

describe('preview wheel scroll routing', () => {
  it('scrolls the nearest eligible ancestor and preserves fractional pixel deltas', () => {
    const { group, inner, placeholder } = makeScrollTree();
    try {
      inner.scrollTop = 10;
      const result = routePreviewWheelToScrollAncestors(placeholder, makeWheel({ deltaY: 2.5 }));
      expect(inner.scrollTop).toBe(12.5);
      expect(result).toEqual({ movedX: false, movedY: true, remainingX: 0, remainingY: 0 });
    } finally {
      group.remove();
    }
  });

  it('chains residual movement to an outer ancestor at the inner boundary', () => {
    const { group, outer, inner, placeholder } = makeScrollTree();
    try {
      inner.scrollTop = 90;
      outer.scrollTop = 20;
      const result = routePreviewWheelToScrollAncestors(placeholder, makeWheel({ deltaY: 40 }));
      expect(inner.scrollTop).toBe(100);
      expect(outer.scrollTop).toBe(50);
      expect(result.remainingY).toBe(0);
    } finally {
      group.remove();
    }
  });

  it('maps Shift plus vertical input to horizontal scrolling only when deltaX is absent', () => {
    const { group, inner, placeholder } = makeScrollTree();
    try {
      const result = routePreviewWheelToScrollAncestors(placeholder, makeWheel({ deltaY: 25, shiftKey: true }));
      expect(inner.scrollLeft).toBe(25);
      expect(inner.scrollTop).toBe(0);
      expect(result.movedX).toBe(true);
    } finally {
      group.remove();
    }
  });

  it('normalizes line-mode deltas without integer quantization', () => {
    const { group, inner, placeholder } = makeScrollTree();
    try {
      placeholder.style.lineHeight = '20px';
      routePreviewWheelToScrollAncestors(placeholder, makeWheel({ deltaY: 1.5, deltaMode: 1 }));
      expect(inner.scrollTop).toBe(30);
    } finally {
      group.remove();
    }
  });
});
