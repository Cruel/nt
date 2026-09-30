import { describe, expect, it } from 'vite-plus/test';
import {
  applyRoomEditNavigation,
  clampRoomEditNavigation,
  interpolateRoomEditNavigation,
  ROOM_EDIT_FIT_NAVIGATION,
  zoomRoomEditNavigationAtPoint,
} from '@/editors/rooms/room-edit-navigation';

describe('Room Edit navigation', () => {
  it('keeps the authored point under the pointer stationary while zooming', () => {
    const viewport = { width: 1000, height: 500 };
    const point = { x: 760, y: 180 };
    const initial = { zoom: 1.5, pan: { x: 40, y: -25 } };
    const authoredOffset = {
      x: (point.x - viewport.width * 0.5 - initial.pan.x) / initial.zoom,
      y: (point.y - viewport.height * 0.5 - initial.pan.y) / initial.zoom,
    };
    const authoredPoint = {
      rect: {
        x: viewport.width * 0.5 + authoredOffset.x,
        y: viewport.height * 0.5 + authoredOffset.y,
        width: 0,
        height: 0,
      },
      rotationDegrees: 0,
    };

    const next = zoomRoomEditNavigationAtPoint(initial, viewport, point, 3);
    const projected = applyRoomEditNavigation(authoredPoint, viewport, next);

    expect(projected.rect.x).toBeCloseTo(point.x);
    expect(projected.rect.y).toBeCloseTo(point.y);
    expect(next.zoom).toBe(3);
  });

  it('allows useful overscroll while keeping some of the authored surface recoverable', () => {
    const viewport = { width: 1000, height: 500 };
    const canonicalSurface = { x: 0, y: 0, width: 1000, height: 500 };

    const clamped = clampRoomEditNavigation(
      { zoom: 2, pan: { x: 100_000, y: -100_000 } },
      viewport,
      canonicalSurface,
    );
    const projected = applyRoomEditNavigation(
      { rect: canonicalSurface, rotationDegrees: 0 },
      viewport,
      clamped,
    ).rect;

    expect(projected.x).toBeLessThan(viewport.width);
    expect(projected.x + projected.width).toBeGreaterThan(0);
    expect(projected.y).toBeLessThan(viewport.height);
    expect(projected.y + projected.height).toBeGreaterThan(0);
    expect(Math.abs(clamped.pan.x)).toBeGreaterThan(viewport.width * 0.5);
  });

  it('interpolates exact Fit and remembered endpoints for mode transitions', () => {
    const remembered = { zoom: 2.5, pan: { x: 240, y: -90 } };

    expect(interpolateRoomEditNavigation(remembered, ROOM_EDIT_FIT_NAVIGATION, 1)).toEqual(
      ROOM_EDIT_FIT_NAVIGATION,
    );
    expect(interpolateRoomEditNavigation(ROOM_EDIT_FIT_NAVIGATION, remembered, 1)).toEqual(
      remembered,
    );
  });
});
