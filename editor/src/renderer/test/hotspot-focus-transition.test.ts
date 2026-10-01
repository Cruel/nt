import { describe, expect, it } from 'vite-plus/test';
import {
  resolveProjectedSourcePresentation,
  screenPresentationToLocal,
} from '@/components/focus-transition/focus-transition-presentation';

describe('focus transition presentations', () => {
  it('reconstructs a cropped projected source as the full transition image in screen space', () => {
    const presentation = resolveProjectedSourcePresentation({
      viewport: { width: 1000, height: 500 },
      displayedViewportScreenRect: { x: 100, y: 150, width: 600, height: 300 },
      visibleImageRect: { x: 120, y: -40, width: 1000, height: 500 },
      visibleImageUv: { x: 0.25, y: 0, width: 0.5, height: 1 },
      rotationDegrees: 15,
    });

    expect(presentation.rotationDegrees).toBe(15);
    expect(presentation.rect.width).toBe(1200);
    expect(presentation.rect.height).toBe(300);
    expect(presentation.rect.x).toBeCloseTo(-124.242, 3);
    expect(presentation.rect.y).toBeCloseTo(145.453, 3);
  });

  it('preserves a stretched source presentation without imposing destination image-fit policy', () => {
    expect(
      resolveProjectedSourcePresentation({
        viewport: { width: 1000, height: 500 },
        displayedViewportScreenRect: { x: 50, y: 25, width: 800, height: 400 },
        visibleImageRect: { x: 0, y: 0, width: 1000, height: 500 },
        visibleImageUv: { x: 0, y: 0, width: 1, height: 1 },
        rotationDegrees: 0,
      }),
    ).toEqual({
      rect: { x: 50, y: 25, width: 800, height: 400 },
      rotationDegrees: 0,
    });
  });

  it('converts screen presentations into a transition overlay local coordinate space', () => {
    expect(
      screenPresentationToLocal(
        { rect: { x: 248, y: 96, width: 640, height: 360 }, rotationDegrees: 0 },
        { x: 180, y: 40, width: 900, height: 600 },
      ),
    ).toEqual({
      rect: { x: 68, y: 56, width: 640, height: 360 },
      rotationDegrees: 0,
    });
  });
});
