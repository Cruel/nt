import { describe, expect, it } from 'vite-plus/test';
import { toJsonValue } from '@/project/json-value';
import { createInitialCommandBusState, executeCommand, undoCommand } from './command-test-utils';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import {
  defaultInteractableData,
  defaultInteractableInstanceData,
} from '../../shared/project-schema/authoring-interactables';

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
        instanceId: 'key',
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
            interactables: [
              {
                id: 'key',
                interactable: { $ref: { registry: 'interactableInstances', id: 'key' } },
                condition: { kind: 'always' },
                placementId: 'key-placement',
                visible: true,
                order: 0,
              },
            ],
          },
        },
      },
      interactableInstances: {
        key: {
          definition: { $ref: { collection: 'interactables', id: 'key' } },
          location: {
            kind: 'room',
            room: { $ref: { collection: 'rooms', id: 'foyer' } },
          },
        },
      },
    });
    expect(placed.historyEntry?.affectedPaths).toEqual([
      '/interactableInstances/key',
      '/rooms/foyer/data',
    ]);
    expect(undoCommand(placed.state).document).toEqual(state.document);
  });

  it('places an existing exact Instance without cloning or discarding its deltas', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    project.interactables.key = {
      id: 'key',
      label: 'Brass key',
      data: defaultInteractableData('Brass key'),
    };
    const instance = defaultInteractableInstanceData('special-key', 'key');
    instance.editorLabel = 'Special key';
    instance.traits.add = ['important'];
    instance.localProperties.push({
      id: 'note',
      type: 'string',
      nullable: false,
      value: 'keep me',
    });
    project.interactableInstances['special-key'] = instance;

    const state = createInitialCommandBusState(toJsonValue(project));
    const placed = executeCommand(state, {
      type: 'room.placeInteractable',
      payload: {
        roomId: 'foyer',
        interactableId: 'key',
        instanceId: 'special-key',
        placementId: 'special-key-placement',
        bounds: { x: 0.2, y: 0.3, width: 0.2, height: 0.2 },
      },
    });

    expect(placed.ok).toBe(true);
    expect(placed.document).toMatchObject({
      interactableInstances: {
        'special-key': {
          editorLabel: 'Special key',
          definition: { $ref: { collection: 'interactables', id: 'key' } },
          traits: { add: ['important'] },
          localProperties: [{ id: 'note', type: 'string', nullable: false, value: 'keep me' }],
          location: {
            kind: 'room',
            room: { $ref: { collection: 'rooms', id: 'foyer' } },
          },
        },
      },
      rooms: {
        foyer: {
          data: {
            interactables: [
              expect.objectContaining({
                id: 'special-key',
                interactable: {
                  $ref: { registry: 'interactableInstances', id: 'special-key' },
                },
                placementId: 'special-key-placement',
              }),
            ],
          },
        },
      },
    });
    expect(Object.keys((placed.document as typeof project).interactableInstances)).toEqual([
      'special-key',
    ]);
    expect(undoCommand(placed.state).document).toEqual(state.document);
  });

  it('authors multiple exact occurrences and a fallback placement independently from Instance identity', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'left',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        order: 0,
        presentation: { label: null, layout: null },
      },
      {
        id: 'right',
        bounds: { x: 0.7, y: 0.1, width: 0.2, height: 0.2 },
        order: 1,
        presentation: { label: null, layout: null },
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    project.interactables.key = { id: 'key', label: 'Key', data: defaultInteractableData('Key') };
    project.interactableInstances.key = defaultInteractableInstanceData('key', 'key', {
      kind: 'room',
      room: { $ref: { collection: 'rooms', id: 'foyer' } },
    });
    let state = createInitialCommandBusState(toJsonValue(project));

    for (const [occurrenceId, placementId] of [
      ['key-left', 'left'],
      ['key-right', 'right'],
    ] as const) {
      const added = executeCommand(state, {
        type: 'room.addInteractableOccurrence',
        payload: { roomId: 'foyer', instanceId: 'key', occurrenceId, placementId },
      });
      expect(added.ok).toBe(true);
      state = added.state;
    }
    const fallback = executeCommand(state, {
      type: 'room.setFallbackInteractablePlacement',
      payload: { roomId: 'foyer', placementId: 'left' },
    });
    expect(fallback.ok).toBe(true);
    state = fallback.state;
    expect((state.document as typeof project).rooms.foyer?.data).toMatchObject({
      fallbackInteractablePlacementId: 'left',
      interactables: [
        { id: 'key-left', interactable: { $ref: { id: 'key' } }, placementId: 'left' },
        { id: 'key-right', interactable: { $ref: { id: 'key' } }, placementId: 'right' },
      ],
    });
    expect((state.document as typeof project).interactableInstances.key?.location).toEqual({
      kind: 'room',
      room: { $ref: { collection: 'rooms', id: 'foyer' } },
    });

    const removed = executeCommand(state, {
      type: 'room.removeInteractableOccurrence',
      payload: { roomId: 'foyer', occurrenceId: 'key-left' },
    });
    expect(removed.ok).toBe(true);
    expect((removed.document as typeof project).rooms.foyer?.data.interactables).toHaveLength(1);
    expect((removed.document as typeof project).interactableInstances.key).toBeDefined();
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
    const key = defaultInteractableData('Key');
    room.interactables = [
      {
        id: 'key',
        interactable: { $ref: { registry: 'interactableInstances', id: 'key' } },
        condition: { kind: 'always' },
        placementId: 'shared',
        visible: true,
        order: 0,
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    project.interactables.key = { id: 'key', label: 'Key', data: key };
    project.interactableInstances.key = defaultInteractableInstanceData('key', 'key', {
      kind: 'room',
      room: { $ref: { collection: 'rooms', id: 'foyer' } },
    });
    let state = createInitialCommandBusState(toJsonValue(project));

    const moved = executeCommand(state, {
      type: 'room.moveInteractableToPlacement',
      payload: { roomId: 'foyer', occurrenceId: 'key', placementId: 'shelf' },
    });
    expect(moved.ok).toBe(true);
    state = moved.state;
    const returned = executeCommand(state, {
      type: 'room.moveInteractableToPlacement',
      payload: { roomId: 'foyer', occurrenceId: 'key', placementId: 'shared' },
    });
    expect(returned.ok).toBe(true);
    state = returned.state;
    const detached = executeCommand(state, {
      type: 'room.detachInteractablePlacement',
      payload: {
        roomId: 'foyer',
        occurrenceId: 'key',
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
            interactables: [expect.objectContaining({ id: 'key', placementId: 'key-placement' })],
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
