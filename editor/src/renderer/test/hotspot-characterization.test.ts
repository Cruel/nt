import { describe, expect, it } from 'vite-plus/test';
import {
  defaultInteractableData,
  interactableDataSchema,
} from '../../shared/project-schema/authoring-interactables';
import { defaultRoomData, roomDataSchema } from '../../shared/project-schema/authoring-rooms';

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
});
