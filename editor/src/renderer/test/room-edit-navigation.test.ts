import { describe, expect, it } from 'vite-plus/test';
import {
  applyRoomEditNavigation,
  clampRoomEditNavigation,
  interpolateRoomEditNavigation,
  ROOM_EDIT_FIT_NAVIGATION,
  zoomRoomEditNavigationAtPoint,
} from '@/editors/rooms/room-edit-navigation';

describe('Room Edit navigation', () => {
  const renderedCenter = (
    projected: {
      rect: { x: number; y: number; width: number; height: number };
      rotationDegrees: number;
    },
    viewport: { width: number; height: number },
  ) => {
    const center = {
      x: projected.rect.x + projected.rect.width * 0.5,
      y: projected.rect.y + projected.rect.height * 0.5,
    };
    const viewportCenter = { x: viewport.width * 0.5, y: viewport.height * 0.5 };
    const radians = (projected.rotationDegrees * Math.PI) / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const x = center.x - viewportCenter.x;
    const y = center.y - viewportCenter.y;
    return {
      x: viewportCenter.x + x * cosine - y * sine,
      y: viewportCenter.y + x * sine + y * cosine,
    };
  };

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

  it('keeps pan and pointer-centered zoom in screen space for rotated cameras', () => {
    const viewport = { width: 1000, height: 500 };
    const authoredPoint = {
      rect: { x: 500, y: 150, width: 0, height: 0 },
      rotationDegrees: 90,
    };

    const panned = applyRoomEditNavigation(authoredPoint, viewport, {
      zoom: 1,
      pan: { x: 50, y: 0 },
    });
    expect(renderedCenter(panned, viewport)).toEqual(
      expect.objectContaining({ x: expect.closeTo(650, 5), y: expect.closeTo(250, 5) }),
    );

    const pointer = { x: 600, y: 250 };
    const next = zoomRoomEditNavigationAtPoint(ROOM_EDIT_FIT_NAVIGATION, viewport, pointer, 2);
    const zoomed = applyRoomEditNavigation(authoredPoint, viewport, next);
    expect(renderedCenter(zoomed, viewport).x).toBeCloseTo(pointer.x);
    expect(renderedCenter(zoomed, viewport).y).toBeCloseTo(pointer.y);
  });

  it('allows useful overscroll while keeping some of the authored surface recoverable', () => {
    const viewport = { width: 1000, height: 500 };
    const canonicalSurface = { x: 0, y: 0, width: 1000, height: 500 };

    const clamped = clampRoomEditNavigation(
      { zoom: 2, pan: { x: 100_000, y: -100_000 } },
      viewport,
      { rect: canonicalSurface, rotationDegrees: 0 },
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

  it('clamps overscroll against the rotated screen-space surface bounds', () => {
    const viewport = { width: 1000, height: 500 };
    const canonicalSurface = {
      rect: { x: 0, y: 0, width: 1000, height: 500 },
      rotationDegrees: 90,
    };

    const clamped = clampRoomEditNavigation(
      { zoom: 1, pan: { x: 100_000, y: 0 } },
      viewport,
      canonicalSurface,
    );
    const projected = applyRoomEditNavigation(canonicalSurface, viewport, clamped);
    const screenWidth = projected.rect.height;
    const rotatedCenterX =
      viewport.width * 0.5 -
      (projected.rect.y + projected.rect.height * 0.5 - viewport.height * 0.5);
    const left = rotatedCenterX - screenWidth * 0.5;
    const right = rotatedCenterX + screenWidth * 0.5;

    expect(left).toBeLessThan(viewport.width);
    expect(right).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(viewport.width - 80);
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
