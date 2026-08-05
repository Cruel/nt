import { describe, expect, it } from 'vite-plus/test';
import { toJsonValue } from '@/project/json-value';
import { createInitialCommandBusState, executeCommand, undoCommand } from './command-test-utils';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultInteractableData } from '../../shared/project-schema/authoring-interactables';

describe('Room placement commands', () => {
  it('places an Interactable with exact defaults and undoes both records atomically', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'desk',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        order: 7,
        presentation: { label: null, layout: null },
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    project.interactables.key = {
      id: 'key',
      label: 'Brass key',
      data: defaultInteractableData('Brass key'),
    };
    const state = createInitialCommandBusState(toJsonValue(project));
    const placed = executeCommand(state, {
      type: 'room.placeInteractable',
      payload: {
        roomId: 'foyer',
        interactableId: 'key',
        placementId: 'key-placement',
        bounds: { x: 0.3, y: 0.4, width: 0.2, height: 0.1 },
      },
    });
    expect(placed.ok).toBe(true);
    expect(placed.document).toMatchObject({
      rooms: {
        foyer: {
          data: {
            placements: [
              {},
              {
                id: 'key-placement',
                bounds: { x: 0.3, y: 0.4, width: 0.2, height: 0.1 },
                order: 8,
                presentation: {
                  label: {
                    source: { kind: 'inline', text: 'Brass key' },
                    markup: 'active-text',
                  },
                  layout: null,
                },
              },
            ],
          },
        },
      },
      interactables: {
        key: {
          data: {
            initialState: {
              location: {
                kind: 'room-placement',
                placement: { room: 'foyer', placement: 'key-placement' },
              },
            },
          },
        },
      },
    });
    expect(placed.historyEntry?.affectedPaths).toEqual(
      expect.arrayContaining(['/rooms/foyer/data', '/interactables/key/data']),
    );
    expect(undoCommand(placed.state).document).toEqual(state.document);
  });

  it('moves, resizes, and explicitly detaches a shared placement', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'shared',
        bounds: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 },
        order: 4,
        presentation: { label: null, layout: null },
      },
      {
        id: 'shelf',
        bounds: { x: 0.6, y: 0.2, width: 0.2, height: 0.3 },
        order: 5,
        presentation: { label: null, layout: null },
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    const key = defaultInteractableData('Key');
    key.initialState.location = {
      kind: 'room-placement',
      placement: { room: 'foyer', placement: 'shared' },
    };
    project.interactables.key = { id: 'key', label: 'Key', data: key };
    let state = createInitialCommandBusState(toJsonValue(project));

    const moved = executeCommand(state, {
      type: 'room.moveInteractableToPlacement',
      payload: { roomId: 'foyer', interactableId: 'key', placementId: 'shelf' },
    });
    expect(moved.ok).toBe(true);
    state = moved.state;
    const returned = executeCommand(state, {
      type: 'room.moveInteractableToPlacement',
      payload: { roomId: 'foyer', interactableId: 'key', placementId: 'shared' },
    });
    expect(returned.ok).toBe(true);
    state = returned.state;
    const detached = executeCommand(state, {
      type: 'room.detachInteractablePlacement',
      payload: {
        roomId: 'foyer',
        interactableId: 'key',
        sourcePlacementId: 'shared',
        placementId: 'key-placement',
      },
    });
    expect(detached.ok).toBe(true);
    expect(detached.document).toMatchObject({
      rooms: {
        foyer: {
          data: {
            placements: [
              {},
              {},
              {
                id: 'key-placement',
                bounds: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 },
                order: 4,
              },
            ],
          },
        },
      },
      interactables: {
        key: {
          data: {
            initialState: {
              location: {
                kind: 'room-placement',
                placement: { room: 'foyer', placement: 'key-placement' },
              },
            },
          },
        },
      },
    });
    const resized = executeCommand(detached.state, {
      type: 'room.setPlacementBounds',
      payload: {
        roomId: 'foyer',
        placementId: 'key-placement',
        bounds: { x: 0.2, y: 0.2, width: 0.4, height: 0.3 },
      },
    });
    expect(resized.ok).toBe(true);
    expect(resized.document).toMatchObject({
      rooms: {
        foyer: {
          data: {
            placements: [{}, {}, { bounds: { x: 0.2, y: 0.2, width: 0.4, height: 0.3 } }],
          },
        },
      },
    });
  });
});
