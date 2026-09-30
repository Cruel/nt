import { describe, expect, it } from 'vite-plus/test';
import { resolveHotspotFocusTransitionFrames } from '@/components/hotspots/hotspot-focus-transition';

describe('Room Hotspot Focus transition', () => {
  it('expands a cropped Room background back to the full source image before native Focus framing', () => {
    const frames = resolveHotspotFocusTransitionFrames({
      roomPresentation: {
        viewport: { width: 1000, height: 500 },
        visibleImageRect: { x: 120, y: -40, width: 1000, height: 500 },
        visibleImageUv: { x: 0.25, y: 0, width: 0.5, height: 1 },
        rotationDegrees: 15,
      },
      displayedRoomViewport: { x: 100, y: 150, width: 600, height: 300 },
      focusViewport: { width: 800, height: 600 },
      imageSize: { width: 2000, height: 500 },
      focusCamera: { zoom: 0.5, pan: { x: 40, y: -20 } },
    });

    expect(frames.room.rotationDegrees).toBe(15);
    expect(frames.room.rect.width).toBe(1200);
    expect(frames.room.rect.height).toBe(300);
    expect(frames.room.rect.x).toBeCloseTo(-124.242, 3);
    expect(frames.room.rect.y).toBeCloseTo(145.453, 3);
    expect(frames.native).toEqual({
      rect: { x: 0, y: 200, width: 800, height: 200 },
      rotationDegrees: 0,
    });
    expect(frames.focused).toEqual({
      rect: { x: -60, y: 155, width: 1000, height: 250 },
      rotationDegrees: 0,
    });
  });

  it('preserves a stretched Room presentation as the entry endpoint while Focus restores native aspect', () => {
    const frames = resolveHotspotFocusTransitionFrames({
      roomPresentation: {
        viewport: { width: 1000, height: 500 },
        visibleImageRect: { x: 0, y: 0, width: 1000, height: 500 },
        visibleImageUv: { x: 0, y: 0, width: 1, height: 1 },
        rotationDegrees: 0,
      },
      displayedRoomViewport: { x: 50, y: 25, width: 800, height: 400 },
      focusViewport: { width: 1000, height: 500 },
      imageSize: { width: 400, height: 800 },
      focusCamera: { zoom: 1, pan: { x: 0, y: 0 } },
    });

    expect(frames.room).toEqual({
      rect: { x: 50, y: 25, width: 800, height: 400 },
      rotationDegrees: 0,
    });
    expect(frames.native.rect).toEqual({ x: 375, y: 0, width: 250, height: 500 });
    expect(frames.focused.rect).toEqual({ x: 300, y: -150, width: 400, height: 800 });
  });
});
