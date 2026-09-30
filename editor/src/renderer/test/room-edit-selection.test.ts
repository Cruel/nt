import { describe, expect, it } from 'vite-plus/test';
import {
  defaultRoomEditSelectionCandidate,
  hitTestRoomEditCandidates,
  marqueeRoomEditSelections,
  topmostRoomEditOccupantCandidate,
  type RoomEditSelectionCandidate,
} from '@/editors/rooms/room-edit-selection';

describe('Room Edit semantic selection', () => {
  it('retains the containing Placement when an occupant visual is hit outside Placement bounds', () => {
    const candidates: RoomEditSelectionCandidate[] = [
      {
        selection: { kind: 'prop', id: 'lamp' },
        projected: {
          rect: { x: 80, y: 80, width: 200, height: 200 },
          rotationDegrees: 0,
        },
        label: 'Prop · lamp',
        category: 'occupant',
        placementId: 'desk',
      },
      {
        selection: { kind: 'placement', id: 'desk' },
        projected: {
          rect: { x: 120, y: 120, width: 80, height: 80 },
          rotationDegrees: 0,
        },
        label: 'Placement · desk',
        category: 'placement',
        placementId: 'desk',
      },
    ];

    const hits = hitTestRoomEditCandidates(
      candidates,
      { x: 90, y: 90 },
      { width: 500, height: 500 },
    );

    expect(hits.map((candidate) => candidate.selection)).toEqual([
      { kind: 'prop', id: 'lamp' },
      { kind: 'placement', id: 'desk' },
    ]);
    expect(defaultRoomEditSelectionCandidate(hits)?.selection).toEqual({
      kind: 'placement',
      id: 'desk',
    });
    expect(topmostRoomEditOccupantCandidate(hits)?.selection).toEqual({ kind: 'prop', id: 'lamp' });
  });

  it('prefers an empty Placement over a full-room background Environment', () => {
    const candidates: RoomEditSelectionCandidate[] = [
      {
        selection: { kind: 'environment', id: 'fog' },
        projected: { rect: { x: 0, y: 0, width: 500, height: 500 }, rotationDegrees: 0 },
        label: 'Environment · fog',
        category: 'independent',
        placementId: null,
      },
      {
        selection: { kind: 'placement', id: 'empty' },
        projected: { rect: { x: 100, y: 100, width: 100, height: 100 }, rotationDegrees: 0 },
        label: 'Placement · empty',
        category: 'placement',
        placementId: 'empty',
      },
    ];
    const hits = hitTestRoomEditCandidates(
      candidates,
      { x: 150, y: 150 },
      { width: 500, height: 500 },
    );
    expect(defaultRoomEditSelectionCandidate(hits)?.selection).toEqual({
      kind: 'placement',
      id: 'empty',
    });
  });

  it('marquee-selects a Placement by the union of its box and visible occupant geometry', () => {
    const candidates: RoomEditSelectionCandidate[] = [
      {
        selection: { kind: 'prop', id: 'lamp' },
        projected: { rect: { x: 310, y: 100, width: 100, height: 100 }, rotationDegrees: 0 },
        label: 'Prop · lamp',
        category: 'occupant',
        placementId: 'desk',
      },
      {
        selection: { kind: 'placement', id: 'desk' },
        projected: { rect: { x: 100, y: 100, width: 100, height: 100 }, rotationDegrees: 0 },
        label: 'Placement · desk',
        category: 'placement',
        placementId: 'desk',
      },
      {
        selection: { kind: 'environment', id: 'fog' },
        projected: { rect: { x: 500, y: 100, width: 100, height: 100 }, rotationDegrees: 0 },
        label: 'Environment · fog',
        category: 'independent',
        placementId: null,
      },
    ];

    expect(
      marqueeRoomEditSelections(
        candidates,
        { x: 350, y: 120, width: 20, height: 20 },
        { width: 1000, height: 500 },
      ),
    ).toEqual([{ kind: 'placement', id: 'desk' }]);
    expect(
      marqueeRoomEditSelections(
        candidates,
        { x: 540, y: 120, width: 20, height: 20 },
        { width: 1000, height: 500 },
      ),
    ).toEqual([{ kind: 'environment', id: 'fog' }]);
  });
});
