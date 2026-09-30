import { describe, expect, it } from 'vite-plus/test';
import {
  defaultRoomEditSelectionCandidate,
  hitTestRoomEditCandidates,
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
});
