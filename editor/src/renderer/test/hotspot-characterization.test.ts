import { describe, expect, it } from 'vite-plus/test';
import {
  defaultInteractableData,
  interactableDataSchema,
} from '../../shared/project-schema/authoring-interactables';
import { defaultRoomData, roomDataSchema } from '../../shared/project-schema/authoring-rooms';
import { sampleHotspotMotionTrack } from '../../shared/project-schema/authoring-hotspots';

describe('hotspot current contracts', () => {
  it('requires exact Room and Interactable hotspot shapes and rejects missing or alternate fields', () => {
    const room = defaultRoomData('Foyer');
    const interactable = defaultInteractableData('Key');

    expect(room.hotspots).toEqual([]);
    expect(interactable.presentation.hotspots).toEqual({ kind: 'none' });
    const { hotspots: _roomHotspots, ...roomWithoutHotspots } = room;
    const { hotspots: _interactableHotspots, ...presentationWithoutHotspots } =
      interactable.presentation;
    expect(roomDataSchema.safeParse(roomWithoutHotspots).success).toBe(false);
    expect(
      interactableDataSchema.safeParse({
        ...interactable,
        presentation: presentationWithoutHotspots,
      }).success,
    ).toBe(false);
    expect(roomDataSchema.safeParse({ ...room, hotspotMode: 'custom' }).success).toBe(false);
    expect(interactableDataSchema.safeParse({ ...interactable, hotspots: [] }).success).toBe(false);
    expect(
      interactableDataSchema.safeParse({
        ...interactable,
        presentation: {
          ...interactable.presentation,
          hotspots: { kind: 'none', hotspots: [] },
        },
      }).success,
    ).toBe(false);
  });

  it('accepts normalized rectangular hotspots and rejects invalid bounds and labels', () => {
    const room = defaultRoomData('Foyer');
    room.features.push({
      id: 'door',
      label: 'Door',
      traits: [],
      localProperties: [],
      defaultProperties: [],
      inventories: [],
    });
    room.hotspots.push({
      id: 'door',
      label: 'Door',
      condition: { kind: 'always' },
      inputOrder: 4,
      highlight: { kind: 'none' },
      shape: { kind: 'rect', bounds: { x: 0.25, y: 0.1, width: 0.5, height: 0.8 } },
      target: { kind: 'owner-feature', featureId: 'door' },
    });
    expect(roomDataSchema.safeParse(room).success).toBe(true);
    expect(
      roomDataSchema.safeParse({
        ...room,
        hotspots: [
          {
            ...room.hotspots[0],
            shape: { kind: 'rect', bounds: { x: 0.75, y: 0, width: 0.5, height: 1 } },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      roomDataSchema.safeParse({
        ...room,
        hotspots: [{ ...room.hotspots[0], label: '   ' }],
      }).success,
    ).toBe(false);
  });

  it('samples motion-keyed hotspot geometry with static fallback, hold, linear, and inactivity', () => {
    const fallback = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
    const tracks = [
      {
        motionId: 'open',
        keyframes: [
          {
            timeMs: 100,
            interpolation: 'linear' as const,
            active: true,
            bounds: { x: 0.2, y: 0.2, width: 0.3, height: 0.4 },
          },
          {
            timeMs: 300,
            interpolation: 'hold' as const,
            active: true,
            bounds: { x: 0.4, y: 0.3, width: 0.2, height: 0.2 },
          },
          {
            timeMs: 500,
            interpolation: 'hold' as const,
            active: false,
            bounds: { x: 0.4, y: 0.3, width: 0.2, height: 0.2 },
          },
        ],
      },
    ];

    expect(sampleHotspotMotionTrack(fallback, tracks, 'idle', 200)).toEqual(fallback);
    expect(sampleHotspotMotionTrack(fallback, tracks, 'open', 50)).toEqual(fallback);
    const linear = sampleHotspotMotionTrack(fallback, tracks, 'open', 200);
    expect(linear?.x).toBeCloseTo(0.3);
    expect(linear?.y).toBeCloseTo(0.25);
    expect(linear?.width).toBeCloseTo(0.25);
    expect(linear?.height).toBeCloseTo(0.3);
    expect(sampleHotspotMotionTrack(fallback, tracks, 'open', 400)).toEqual(
      tracks[0]!.keyframes[1]!.bounds,
    );
    expect(sampleHotspotMotionTrack(fallback, tracks, 'open', 500)).toBeNull();
  });
});
