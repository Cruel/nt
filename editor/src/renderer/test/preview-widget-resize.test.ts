import { readFileSync } from 'node:fs';
import { createContext, Script } from 'node:vm';
import { describe, expect, it } from 'vite-plus/test';

interface PreviewSurfaceMetrics {
  logicalWidth: number;
  logicalHeight: number;
  framebufferWidth: number;
  framebufferHeight: number;
  scaleX: number;
  scaleY: number;
}

type ResolvePreviewSurfaceMetrics = (
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  maxDpr: number,
) => PreviewSurfaceMetrics;

function loadSurfaceMetricsResolver(widget: string): ResolvePreviewSurfaceMetrics {
  const beginMarker = '// BEGIN preview-surface-metrics';
  const endMarker = '// END preview-surface-metrics';
  const begin = widget.indexOf(beginMarker);
  const end = widget.indexOf(endMarker);
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);
  const source = widget.slice(begin + beginMarker.length, end);
  const sandbox: { resolvePreviewSurfaceMetricsForTest?: ResolvePreviewSurfaceMetrics } = {};
  new Script(
    `${source}\nglobalThis.resolvePreviewSurfaceMetricsForTest = resolvePreviewSurfaceMetrics;`,
  ).runInContext(createContext(sandbox));
  if (!sandbox.resolvePreviewSurfaceMetricsForTest)
    throw new Error('Preview surface metrics resolver was not loaded.');
  return sandbox.resolvePreviewSurfaceMetricsForTest;
}

describe('preview widget resize bridge', () => {
  it('fills the iframe viewport and applies only the newest distinct resize tuple', () => {
    const widget = readFileSync('../web/widget.html', 'utf8');

    expect(widget).toContain('canvas { display: block; width: 100vw; height: 100vh;');
    expect(widget).toContain(
      "new ResizeObserver(resizeCanvas).observe(document.getElementById('canvas'));",
    );
    expect(widget).toContain('pendingResize = resize;');
    expect(widget).toContain('canvas.width = resize.framebufferWidth;');
    expect(widget).toContain('canvas.height = resize.framebufferHeight;');
    expect(widget).toContain('if (resizeScheduled) return;');
    expect(widget).toContain('requestAnimationFrame(() => {');
    expect(widget).toContain('if (key === appliedResizeKey) return;');
    expect(widget).toContain('Module._noveltea_preview_resize(');
    expect(widget).toContain("window.addEventListener('pageshow', resizeCanvas);");
    expect(widget).toContain("document.addEventListener('visibilitychange'");
    expect(widget).toContain(
      'dprMediaQuery = window.matchMedia(`(resolution: ${currentDevicePixelRatio()}dppx)`);',
    );
    expect(widget).toContain(
      "dprMediaQuery.addEventListener('change', handleDevicePixelRatioChange, { once: true });",
    );
    expect(widget).toContain('function handleDevicePixelRatioChange() {');
    expect(widget).toContain('armDevicePixelRatioWatcher();\n      resizeCanvas();');
    expect(widget).not.toContain("params.get('maxDpr') || '1'");
  });

  it('uses actual DPR for logical and framebuffer tuples across the supported matrix', () => {
    const widget = readFileSync('../web/widget.html', 'utf8');
    const resolve = loadSurfaceMetricsResolver(widget);

    expect(resolve(600, 400, 1, 0)).toEqual({
      logicalWidth: 600,
      logicalHeight: 400,
      framebufferWidth: 600,
      framebufferHeight: 400,
      scaleX: 1,
      scaleY: 1,
    });
    expect(resolve(600, 400, 1.25, 0)).toEqual({
      logicalWidth: 600,
      logicalHeight: 400,
      framebufferWidth: 750,
      framebufferHeight: 500,
      scaleX: 1.25,
      scaleY: 1.25,
    });
    expect(resolve(600, 400, 1.5, 0)).toEqual({
      logicalWidth: 600,
      logicalHeight: 400,
      framebufferWidth: 900,
      framebufferHeight: 600,
      scaleX: 1.5,
      scaleY: 1.5,
    });
    expect(resolve(600, 400, 2, 0)).toEqual({
      logicalWidth: 600,
      logicalHeight: 400,
      framebufferWidth: 1200,
      framebufferHeight: 800,
      scaleX: 2,
      scaleY: 2,
    });

    const odd = resolve(601.4, 399.6, 1.25, 0);
    expect(odd.logicalWidth).toBe(601);
    expect(odd.logicalHeight).toBe(400);
    expect(odd.framebufferWidth).toBe(752);
    expect(odd.framebufferHeight).toBe(500);
    expect(odd.scaleX).toBe(752 / 601);
    expect(odd.scaleY).toBe(1.25);
  });

  it('treats a CSS-size-stable DPR change as a distinct resize and keeps maxDpr diagnostic-only', () => {
    const widget = readFileSync('../web/widget.html', 'utf8');
    const resolve = loadSurfaceMetricsResolver(widget);

    const oneX = resolve(600, 400, 1, 0);
    const twoX = resolve(600, 400, 2, 0);
    expect(twoX.logicalWidth).toBe(oneX.logicalWidth);
    expect(twoX.logicalHeight).toBe(oneX.logicalHeight);
    expect(twoX.framebufferWidth).not.toBe(oneX.framebufferWidth);
    expect(twoX.framebufferHeight).not.toBe(oneX.framebufferHeight);

    expect(resolve(600, 400, 2, 1)).toEqual(oneX);
    expect(resolve(600, 400, 2, 0).framebufferWidth).toBe(1200);
  });
});
