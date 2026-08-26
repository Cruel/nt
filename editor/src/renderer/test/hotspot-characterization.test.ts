import { describe, expect, it } from 'vite-plus/test';
import {
  defaultInteractableData,
  interactableDataSchema,
} from '../../shared/project-schema/authoring-interactables';
import { defaultRoomData, roomDataSchema } from '../../shared/project-schema/authoring-rooms';

type Size = { width: number; height: number };
type Rect = { x: number; y: number; width: number; height: number };
type Fit = 'cover' | 'contain' | 'stretch' | 'center';

function fitBackground(viewport: Size, image: Size, fit: Fit): { rect: Rect; uv: Rect } {
  if (fit === 'stretch')
    return {
      rect: { x: 0, y: 0, width: viewport.width, height: viewport.height },
      uv: { x: 0, y: 0, width: 1, height: 1 },
    };

  if (fit === 'center')
    return {
      rect: {
        x: (viewport.width - image.width) / 2,
        y: (viewport.height - image.height) / 2,
        width: image.width,
        height: image.height,
      },
      uv: { x: 0, y: 0, width: 1, height: 1 },
    };

  const scale =
    fit === 'cover'
      ? Math.max(viewport.width / image.width, viewport.height / image.height)
      : Math.min(viewport.width / image.width, viewport.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  const rect = {
    x: (viewport.width - width) / 2,
    y: (viewport.height - height) / 2,
    width,
    height,
  };

  if (fit === 'contain') return { rect, uv: { x: 0, y: 0, width: 1, height: 1 } };

  return {
    rect: { x: 0, y: 0, width: viewport.width, height: viewport.height },
    uv: {
      x: rect.x === 0 ? 0 : -rect.x / rect.width,
      y: rect.y === 0 ? 0 : -rect.y / rect.height,
      width: viewport.width / rect.width,
      height: viewport.height / rect.height,
    },
  };
}

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
    room.features.push({ id: 'door', label: 'Door', traits: [], properties: {}, inventories: [] });
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

  it('captures current Room background fit vectors used by the native world layout policy', () => {
    const viewport = { width: 1600, height: 900 };
    const square = { width: 1000, height: 1000 };

    expect(fitBackground(viewport, square, 'cover')).toEqual({
      rect: { x: 0, y: 0, width: 1600, height: 900 },
      uv: { x: 0, y: 0.21875, width: 1, height: 0.5625 },
    });
    expect(fitBackground(viewport, square, 'contain')).toEqual({
      rect: { x: 350, y: 0, width: 900, height: 900 },
      uv: { x: 0, y: 0, width: 1, height: 1 },
    });
    expect(fitBackground(viewport, square, 'stretch')).toEqual({
      rect: { x: 0, y: 0, width: 1600, height: 900 },
      uv: { x: 0, y: 0, width: 1, height: 1 },
    });
    expect(fitBackground(viewport, square, 'center')).toEqual({
      rect: { x: 300, y: -50, width: 1000, height: 1000 },
      uv: { x: 0, y: 0, width: 1, height: 1 },
    });
  });

  it('captures normalized Room placement projection independently from background image fit', () => {
    const placement = { x: 0.1, y: 0.2, width: 0.25, height: 0.4 };
    const reference = { width: 1920, height: 1080 };

    expect({
      x: placement.x * reference.width,
      y: placement.y * reference.height,
      width: placement.width * reference.width,
      height: placement.height * reference.height,
    }).toEqual({ x: 192, y: 216, width: 480, height: 432 });
  });
});
