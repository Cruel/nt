import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';

describe('preview widget resize bridge', () => {
  it('fills the iframe viewport and applies only the newest distinct resize tuple', () => {
    const widget = readFileSync('../web/widget.html', 'utf8');

    expect(widget).toContain('canvas { display: block; width: 100vw; height: 100vh;');
    expect(widget).toContain(
      "new ResizeObserver(resizeCanvas).observe(document.getElementById('canvas'));",
    );
    expect(widget).toContain(
      'pendingResize = { logicalWidth, logicalHeight, framebufferWidth, framebufferHeight, scaleX, scaleY };',
    );
    expect(widget).toContain('if (resizeScheduled) return;');
    expect(widget).toContain('requestAnimationFrame(() => {');
    expect(widget).toContain('if (key === appliedResizeKey) return;');
    expect(widget).toContain('Module._noveltea_preview_resize(');
    expect(widget).toContain("window.addEventListener('pageshow', resizeCanvas);");
    expect(widget).toContain("document.addEventListener('visibilitychange'");
  });
});
