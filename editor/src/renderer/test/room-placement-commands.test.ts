import { describe, expect, it } from 'vite-plus/test';
import { toJsonValue } from '@/project/json-value';
import { createInitialCommandBusState, executeCommand, undoCommand } from './command-test-utils';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import { defaultInteractionProgram } from '../../shared/project-schema/authoring-interaction-programs';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import {
  defaultInteractableData,
  defaultInteractableInstanceData,
} from '../../shared/project-schema/authoring-interactables';
import { roomDestroyInteractableInstanceCommand } from '@/commands/builtin-commands';

describe('Room placement commands', () => {
  it('places an Interactable with exact defaults and undoes both records atomically', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'desk',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
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

  it('reorders WorldContent occurrences across families with sparse authored order', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'stage',
        bounds: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
        presentation: { label: null, layout: null },
      },
    ];
    room.cast = [
      {
        id: 'hero',
        character: { $ref: { collection: 'characters', id: 'hero' } },
        condition: { kind: 'always' },
        placementId: 'stage',
        profileId: null,
        poseId: null,
        expressionId: null,
        appearanceId: null,
        idleId: null,
        visible: true,
        order: 0,
      },
    ];
    room.props = [
      {
        id: 'desk',
        condition: { kind: 'always' },
        placementId: 'stage',
        asset: { $ref: { collection: 'assets', id: 'desk' } },
        materialApplication: null,
        visible: true,
        order: 1024,
      },
    ];
    room.interactables = [
      {
        id: 'key',
        interactable: { $ref: { registry: 'interactableInstances', id: 'key' } },
        condition: { kind: 'always' },
        placementId: 'stage',
        visible: true,
        order: 2048,
      },
    ];
    project.characters.hero = {
      id: 'hero',
      label: 'Hero',
      data: defaultCharacterData('Hero'),
    };
    project.assets.desk = {
      id: 'desk',
      label: 'Desk',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/desk.png' },
        aliases: [],
        imageMetadata: { width: 64, height: 64, hasAlpha: true, orientation: 1 },
      },
    };
    project.interactables.key = {
      id: 'key',
      label: 'Key',
      data: defaultInteractableData('Key'),
    };
    project.interactableInstances.key = defaultInteractableInstanceData('key', 'key', {
      kind: 'room',
      room: { $ref: { collection: 'rooms', id: 'foyer' } },
    });
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    let state = createInitialCommandBusState(toJsonValue(project));

    const front = executeCommand(state, {
      type: 'room.reorderPresentation',
      payload: { roomId: 'foyer', target: { kind: 'cast', id: 'hero' }, action: 'front' },
    });
    expect(front.ok, JSON.stringify(front.diagnostics)).toBe(true);
    state = front.state;
    expect((front.document as typeof project).rooms.foyer?.data).toMatchObject({
      cast: [{ id: 'hero', order: 3072 }],
      props: [{ id: 'desk', order: 1024 }],
      interactables: [{ id: 'key', order: 2048 }],
    });

    const forward = executeCommand(state, {
      type: 'room.reorderPresentation',
      payload: { roomId: 'foyer', target: { kind: 'prop', id: 'desk' }, action: 'forward' },
    });
    expect(forward.ok).toBe(true);
    expect((forward.document as typeof project).rooms.foyer?.data).toMatchObject({
      cast: [{ id: 'hero', order: 3072 }],
      props: [{ id: 'desk', order: 2560 }],
      interactables: [{ id: 'key', order: 2048 }],
    });
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
        presentation: { label: null, layout: null },
      },
      {
        id: 'right',
        bounds: { x: 0.7, y: 0.1, width: 0.2, height: 0.2 },
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
        presentation: { label: null, layout: null },
      },
      {
        id: 'shelf',
        bounds: { x: 0.6, y: 0.2, width: 0.2, height: 0.3 },
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

  it('expands count into the minimum exact stack identities allowed by stackLimit', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    const coins = defaultInteractableData('Coins');
    coins.stackable = true;
    coins.stackLimit = 3;
    project.interactables.coins = { id: 'coins', label: 'Coins', data: coins };
    const state = createInitialCommandBusState(toJsonValue(project));

    const placed = executeCommand(state, {
      type: 'room.placeInteractable',
      payload: {
        roomId: 'foyer',
        interactableId: 'coins',
        instanceId: 'coins',
        placementId: 'coins-placement',
        bounds: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
        count: 7,
      },
    });

    expect(placed.ok).toBe(true);
    const placedProject = placed.document as typeof project;
    expect(Object.keys(placedProject.interactableInstances)).toEqual([
      'coins',
      'coins-2',
      'coins-3',
    ]);
    expect(
      Object.values(placedProject.interactableInstances).map((instance) => instance.quantity),
    ).toEqual([3, 3, 1]);
    expect(placedProject.rooms.foyer?.data.interactables).toMatchObject([
      { interactable: { $ref: { id: 'coins' } }, placementId: 'coins-placement', order: 0 },
      { interactable: { $ref: { id: 'coins-2' } }, placementId: 'coins-placement', order: 1024 },
      { interactable: { $ref: { id: 'coins-3' } }, placementId: 'coins-placement', order: 2048 },
    ]);
    expect(undoCommand(placed.state).document).toEqual(state.document);
  });

  it('separates occurrence removal, semantic unplacement, and destruction', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'key-placement',
        bounds: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
        presentation: { label: null, layout: null },
      },
    ];
    room.interactables = [
      {
        id: 'key-occurrence',
        interactable: { $ref: { registry: 'interactableInstances', id: 'key' } },
        condition: { kind: 'always' },
        placementId: 'key-placement',
        visible: true,
        order: 0,
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    project.interactables.key = { id: 'key', label: 'Key', data: defaultInteractableData('Key') };
    project.interactableInstances.key = defaultInteractableInstanceData('key', 'key', {
      kind: 'room',
      room: { $ref: { collection: 'rooms', id: 'foyer' } },
    });
    const initial = createInitialCommandBusState(toJsonValue(project));

    const occurrenceOnly = executeCommand(initial, {
      type: 'room.removeInteractableOccurrence',
      payload: { roomId: 'foyer', occurrenceId: 'key-occurrence' },
    });
    expect(occurrenceOnly.ok).toBe(true);
    expect(
      (occurrenceOnly.document as typeof project).interactableInstances.key?.location.kind,
    ).toBe('room');
    expect((occurrenceOnly.document as typeof project).rooms.foyer?.data.interactables).toEqual([]);

    const unplaced = executeCommand(initial, {
      type: 'room.unplaceInteractableInstance',
      payload: { instanceId: 'key' },
    });
    expect(unplaced.ok).toBe(true);
    expect((unplaced.document as typeof project).interactableInstances.key?.location).toEqual({
      kind: 'unplaced',
    });
    expect((unplaced.document as typeof project).rooms.foyer?.data.interactables).toEqual([]);

    const destroyed = executeCommand(initial, {
      type: 'room.destroyInteractableInstance',
      payload: { instanceId: 'key' },
    });
    expect(destroyed.ok).toBe(true);
    expect((destroyed.document as typeof project).interactableInstances.key).toBeUndefined();
    expect((destroyed.document as typeof project).rooms.foyer?.data.interactables).toEqual([]);
  });

  it('blocks Instance destruction while typed references remain', () => {
    const project = createAuthoringProject();
    project.interactables.key = { id: 'key', label: 'Key', data: defaultInteractableData('Key') };
    project.interactableInstances.key = defaultInteractableInstanceData('key', 'key');
    project.undefinedInteractionProgram = defaultInteractionProgram();
    project.undefinedInteractionProgram.instructions.push({
      id: 'move-key',
      kind: 'move-instance',
      subject: {
        kind: 'interactable',
        interactable: { $ref: { registry: 'interactableInstances', id: 'key' } },
      },
      location: { kind: 'unplaced' },
    });
    const initial = createInitialCommandBusState(toJsonValue(project));

    const destroyed = executeCommand(initial, {
      type: 'room.destroyInteractableInstance',
      payload: { instanceId: 'key' },
    });

    expect(destroyed.ok).toBe(false);
    expect(destroyed.state.document).toEqual(initial.document);
    expect(destroyed.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        path: '/undefinedInteractionProgram/instructions/0/subject/interactable/$ref',
      }),
    ]);
  });

  it('fails closed when Instance destruction has no current dependency graph', () => {
    const project = createAuthoringProject();
    project.interactables.key = { id: 'key', label: 'Key', data: defaultInteractableData('Key') };
    project.interactableInstances.key = defaultInteractableInstanceData('key', 'key');
    const document = toJsonValue(project);

    const result = roomDestroyInteractableInstanceCommand({
      document,
      savedDocument: document,
      payload: { instanceId: 'key' },
      request: {
        type: 'room.destroyInteractableInstance',
        payload: { instanceId: 'key' },
        originSaveUnitId: 'test:room',
        persistencePolicy: 'manual-save',
      },
      graphSnapshot: null,
      projectInstanceId: 'test:project',
      projectRevision: 1,
    });

    expect(result.patches).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: 'The dependency graph is not ready for the current project revision.',
        path: '/interactableInstances/key',
      }),
    ]);
  });
});
