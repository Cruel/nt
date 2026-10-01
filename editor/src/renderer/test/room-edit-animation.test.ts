import { describe, expect, it } from 'vite-plus/test';
import {
  applyCharacterIdleDisplayProjection,
  applyCharacterIdleProjection,
  occurrenceElapsedSeconds,
  retainOccurrenceEpochs,
} from '@/editors/rooms/room-edit-animation';

describe('Room Edit occurrence animation', () => {
  it('starts occurrence-relative time at zero even after a large renderer clock and resets after removal', () => {
    const epochs = new Map();

    expect(occurrenceElapsedSeconds(epochs, 'environment:fog', 'gameplay', 10_000)).toBe(0);
    expect(occurrenceElapsedSeconds(epochs, 'environment:fog', 'gameplay', 10_002.5)).toBe(2.5);

    retainOccurrenceEpochs(epochs, new Set());
    expect(occurrenceElapsedSeconds(epochs, 'environment:fog', 'gameplay', 25_000)).toBe(0);
    expect(occurrenceElapsedSeconds(epochs, 'environment:fog', 'gameplay', 25_001)).toBe(1);
  });

  it('resets an occurrence epoch when its clock domain changes', () => {
    const epochs = new Map();
    expect(occurrenceElapsedSeconds(epochs, 'environment:fog', 'gameplay', 100)).toBe(0);
    expect(occurrenceElapsedSeconds(epochs, 'environment:fog', 'gameplay', 104)).toBe(4);
    expect(occurrenceElapsedSeconds(epochs, 'environment:fog', 'unscaled-presentation', 104)).toBe(
      0,
    );
  });

  it('matches native bob, sway, and pulse geometry semantics', () => {
    const projected = {
      rect: { x: 100, y: 100, width: 200, height: 300 },
      rotationDegrees: 0,
    };
    const viewport = { width: 1000, height: 500 };
    const base = {
      id: 'idle',
      label: 'Idle',
      amplitude: 0.1,
      periodMs: 1000,
      clock: 'unscaled-presentation' as const,
    };
    const quarterPeriod = 0.25;

    expect(
      applyCharacterIdleProjection(projected, { ...base, kind: 'bob' }, quarterPeriod, viewport)
        .rect,
    ).toEqual({ x: 100, y: 50, width: 200, height: 300 });
    expect(
      applyCharacterIdleProjection(projected, { ...base, kind: 'sway' }, quarterPeriod, viewport)
        .rect,
    ).toEqual({ x: 200, y: 100, width: 200, height: 300 });
    const pulse = applyCharacterIdleProjection(
      projected,
      { ...base, kind: 'pulse' },
      quarterPeriod,
      viewport,
    ).rect;
    expect(pulse.x).toBeCloseTo(90);
    expect(pulse.y).toBeCloseTo(85);
    expect(pulse.width).toBeCloseTo(220);
    expect(pulse.height).toBeCloseTo(330);
  });

  it('applies authoring navigation after Character idle motion so bob and sway scale with Edit zoom', () => {
    const projected = {
      rect: { x: 100, y: 100, width: 200, height: 300 },
      rotationDegrees: 0,
    };
    const viewport = { width: 1000, height: 500 };
    const idle = {
      id: 'idle',
      label: 'Idle',
      kind: 'bob' as const,
      amplitude: 0.1,
      periodMs: 1000,
      clock: 'unscaled-presentation' as const,
    };

    const displayed = applyCharacterIdleDisplayProjection(projected, idle, 0.25, viewport, {
      zoom: 2,
      pan: { x: 0, y: 0 },
    });

    // Canonical bob moves 50px upward; at 2x authoring zoom the displayed displacement is 100px.
    expect(displayed.rect).toEqual({ x: -300, y: -150, width: 400, height: 600 });
  });
});
