import { describe, expect, it } from 'vite-plus/test';
import { toJsonValue } from '@/project/json-value';
import { createInitialCommandBusState, executeCommand, undoCommand } from './command-test-utils';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import { defaultInteractionProgram } from '../../shared/project-schema/authoring-interaction-programs';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import { emptyMaterialApplication } from '../../shared/project-schema/authoring-material-applications';
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

  it('translates mixed spatial selections once and splits only the selected occupants of a shared placement', () => {
    const project = createAuthoringProject();
    project.assets.pixel = {
      id: 'pixel',
      label: 'Pixel',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/pixel.png' },
        aliases: [],
        imageMetadata: { width: 1, height: 1, hasAlpha: true, orientation: 1 },
      },
    };
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'shared',
        bounds: { x: 0.1, y: 0.2, width: 0.2, height: 0.2 },
        presentation: { label: null, layout: null },
      },
      {
        id: 'group',
        bounds: { x: 0.5, y: 0.2, width: 0.2, height: 0.2 },
        presentation: { label: null, layout: null },
      },
    ];
    room.props = [
      {
        id: 'lamp',
        condition: { kind: 'always' },
        placementId: 'shared',
        asset: { $ref: { collection: 'assets', id: 'pixel' } },
        materialApplication: null,
        visible: true,
        order: 0,
      },
      {
        id: 'book',
        condition: { kind: 'always' },
        placementId: 'shared',
        asset: { $ref: { collection: 'assets', id: 'pixel' } },
        materialApplication: null,
        visible: true,
        order: 1024,
      },
    ];
    room.cast = [
      {
        id: 'hero',
        character: { $ref: { collection: 'characters', id: 'hero' } },
        condition: { kind: 'always' },
        placementId: 'group',
        profileId: null,
        poseId: null,
        expressionId: null,
        appearanceId: null,
        idleId: null,
        visible: true,
        order: 2048,
      },
    ];
    project.characters.hero = {
      id: 'hero',
      label: 'Hero',
      data: defaultCharacterData('Hero'),
    };
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    const initial = createInitialCommandBusState(toJsonValue(project));

    const moved = executeCommand(initial, {
      type: 'room.translateSelection',
      payload: {
        roomId: 'foyer',
        selection: [
          { kind: 'prop', id: 'lamp' },
          { kind: 'placement', id: 'group' },
          { kind: 'cast', id: 'hero' },
        ],
        delta: { x: 0.1, y: 0.15 },
      },
    });

    expect(moved.ok, JSON.stringify(moved.diagnostics)).toBe(true);
    const result = (moved.document as typeof project).rooms.foyer!.data;
    expect(result.placements).toHaveLength(3);
    expect(result.placements.find((item) => item.id === 'shared')?.bounds).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.2,
      height: 0.2,
    });
    expect(result.props.find((item) => item.id === 'book')?.placementId).toBe('shared');
    const lamp = result.props.find((item) => item.id === 'lamp')!;
    expect(lamp.placementId).not.toBe('shared');
    expect(result.placements.find((item) => item.id === lamp.placementId)?.bounds).toEqual({
      x: 0.2,
      y: 0.35,
      width: 0.2,
      height: 0.2,
    });
    expect(result.placements.find((item) => item.id === 'group')?.bounds).toEqual({
      x: 0.6,
      y: 0.35,
      width: 0.2,
      height: 0.2,
    });
    expect(result.cast.find((item) => item.id === 'hero')?.placementId).toBe('group');
    expect(undoCommand(moved.state).document).toEqual(initial.document);
  });

  it('resizes one explicitly selected occupant by splitting a shared placement', () => {
    const project = createAuthoringProject();
    project.assets.pixel = {
      id: 'pixel',
      label: 'Pixel',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/pixel.png' },
        aliases: [],
        imageMetadata: { width: 1, height: 1, hasAlpha: true, orientation: 1 },
      },
    };
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'shared',
        bounds: { x: 0.1, y: 0.2, width: 0.2, height: 0.2 },
        presentation: { label: null, layout: null },
      },
    ];
    room.props = ['lamp', 'book'].map((id, index) => ({
      id,
      condition: { kind: 'always' as const },
      placementId: 'shared',
      asset: { $ref: { collection: 'assets' as const, id: 'pixel' } },
      materialApplication: null,
      visible: true,
      order: index * 1024,
    }));
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    const initial = createInitialCommandBusState(toJsonValue(project));

    const resized = executeCommand(initial, {
      type: 'room.resizeSelection',
      payload: {
        roomId: 'foyer',
        selection: { kind: 'prop', id: 'lamp' },
        bounds: { x: 0.25, y: 0.3, width: 0.3, height: 0.4 },
      },
    });

    expect(resized.ok, JSON.stringify(resized.diagnostics)).toBe(true);
    const result = (resized.document as typeof project).rooms.foyer!.data;
    expect(result.placements).toHaveLength(2);
    expect(result.props.find((item) => item.id === 'book')?.placementId).toBe('shared');
    const lamp = result.props.find((item) => item.id === 'lamp')!;
    expect(lamp.placementId).not.toBe('shared');
    expect(result.placements.find((item) => item.id === lamp.placementId)?.bounds).toEqual({
      x: 0.25,
      y: 0.3,
      width: 0.3,
      height: 0.4,
    });
    expect(undoCommand(resized.state).document).toEqual(initial.document);
  });

  it('treats an unchanged shared-occurrence resize as a no-op without splitting or undo history', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'shared',
        bounds: { x: 0.1, y: 0.2, width: 0.2, height: 0.2 },
        presentation: { label: null, layout: null },
      },
    ];
    room.props = ['lamp', 'book'].map((id, index) => ({
      id,
      condition: { kind: 'always' as const },
      placementId: 'shared',
      asset: null,
      materialApplication: null,
      visible: true,
      order: index * 1024,
    }));
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    const initial = createInitialCommandBusState(toJsonValue(project));

    const resized = executeCommand(initial, {
      type: 'room.resizeSelection',
      payload: {
        roomId: 'foyer',
        selection: { kind: 'prop', id: 'lamp' },
        bounds: room.placements[0]!.bounds,
      },
    });

    expect(resized.ok, JSON.stringify(resized.diagnostics)).toBe(true);
    expect(resized.state.document).toEqual(initial.document);
    expect(resized.state.history).toEqual(initial.history);
  });

  it('deletes a semantic multi-selection atomically without destroying global Interactable identities', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'shared',
        bounds: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 },
        presentation: { label: null, layout: null },
      },
      {
        id: 'keep',
        bounds: { x: 0.6, y: 0.1, width: 0.2, height: 0.2 },
        presentation: { label: null, layout: null },
      },
    ];
    room.interactables = [
      {
        id: 'key-view',
        interactable: { $ref: { registry: 'interactableInstances', id: 'key' } },
        condition: { kind: 'always' },
        placementId: 'shared',
        visible: true,
        order: 0,
      },
    ];
    room.props = [
      {
        id: 'lamp',
        condition: { kind: 'always' },
        placementId: 'shared',
        asset: null,
        materialApplication: null,
        visible: true,
        order: 1024,
      },
      {
        id: 'vase',
        condition: { kind: 'always' },
        placementId: 'keep',
        asset: null,
        materialApplication: null,
        visible: true,
        order: 2048,
      },
    ];
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
    const initial = createInitialCommandBusState(toJsonValue(project));

    const deleted = executeCommand(initial, {
      type: 'room.deleteSelection',
      payload: {
        roomId: 'foyer',
        selection: [
          { kind: 'placement', id: 'shared' },
          { kind: 'prop', id: 'vase' },
        ],
      },
    });

    expect(deleted.ok, JSON.stringify(deleted.diagnostics)).toBe(true);
    const result = deleted.document as typeof project;
    expect(result.rooms.foyer!.data.placements.map((item) => item.id)).toEqual(['keep']);
    expect(result.rooms.foyer!.data.interactables).toEqual([]);
    expect(result.rooms.foyer!.data.props).toEqual([]);
    expect(result.interactableInstances.key).toBeDefined();
    expect(undoCommand(deleted.state).document).toEqual(initial.document);
  });

  it('inserts an explicitly assigned occupied presentation order instead of creating a duplicate', () => {
    const project = createAuthoringProject();
    project.assets.pixel = {
      id: 'pixel',
      label: 'Pixel',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/pixel.png' },
        aliases: [],
        imageMetadata: { width: 1, height: 1, hasAlpha: true, orientation: 1 },
      },
    };
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'stage',
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        presentation: { label: null, layout: null },
      },
    ];
    room.props = ['rear', 'middle', 'front'].map((id, index) => ({
      id,
      condition: { kind: 'always' as const },
      placementId: 'stage',
      asset: { $ref: { collection: 'assets' as const, id: 'pixel' } },
      materialApplication: null,
      visible: true,
      order: index * 1024,
    }));
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    const initial = createInitialCommandBusState(toJsonValue(project));

    const reordered = executeCommand(initial, {
      type: 'room.setPresentationOrder',
      payload: {
        roomId: 'foyer',
        target: { kind: 'prop', id: 'front' },
        order: 1024,
      },
    });

    expect(reordered.ok, JSON.stringify(reordered.diagnostics)).toBe(true);
    const props = (reordered.document as typeof project).rooms.foyer!.data.props;
    expect(new Set(props.map((item) => item.order)).size).toBe(3);
    expect(Object.fromEntries(props.map((item) => [item.id, item.order]))).toEqual({
      rear: 0,
      middle: 1024,
      front: 512,
    });
    expect(
      [...props].sort((left, right) => left.order - right.order).map((item) => item.id),
    ).toEqual(['rear', 'front', 'middle']);
  });

  it('rebalances the plane only when an occupied order has no available integer slot', () => {
    const project = createAuthoringProject();
    project.assets.pixel = {
      id: 'pixel',
      label: 'Pixel',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/pixel.png' },
        aliases: [],
        imageMetadata: { width: 1, height: 1, hasAlpha: true, orientation: 1 },
      },
    };
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'stage',
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        presentation: { label: null, layout: null },
      },
    ];
    room.props = ['rear', 'middle', 'front'].map((id, index) => ({
      id,
      condition: { kind: 'always' as const },
      placementId: 'stage',
      asset: { $ref: { collection: 'assets' as const, id: 'pixel' } },
      materialApplication: null,
      visible: true,
      order: index,
    }));
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    const initial = createInitialCommandBusState(toJsonValue(project));

    const reordered = executeCommand(initial, {
      type: 'room.setPresentationOrder',
      payload: {
        roomId: 'foyer',
        target: { kind: 'prop', id: 'front' },
        order: 1,
      },
    });

    expect(reordered.ok, JSON.stringify(reordered.diagnostics)).toBe(true);
    const props = (reordered.document as typeof project).rooms.foyer!.data.props;
    expect(Object.fromEntries(props.map((item) => [item.id, item.order]))).toEqual({
      rear: 0,
      middle: 2048,
      front: 1024,
    });
  });

  it('uses a one-slot signed-32-bit boundary gap before rebalancing a plane', () => {
    const project = createAuthoringProject();
    project.assets.pixel = {
      id: 'pixel',
      label: 'Pixel',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/pixel.png' },
        aliases: [],
        imageMetadata: { width: 1, height: 1, hasAlpha: true, orientation: 1 },
      },
    };
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'stage',
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        presentation: { label: null, layout: null },
      },
    ];
    room.props = ['rear', 'front'].map((id, index) => ({
      id,
      condition: { kind: 'always' as const },
      placementId: 'stage',
      asset: { $ref: { collection: 'assets' as const, id: 'pixel' } },
      materialApplication: null,
      visible: true,
      order: -2147483646 + index,
    }));
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    const initial = createInitialCommandBusState(toJsonValue(project));

    const reordered = executeCommand(initial, {
      type: 'room.reorderPresentation',
      payload: {
        roomId: 'foyer',
        target: { kind: 'prop', id: 'front' },
        action: 'backward',
      },
    });

    expect(reordered.ok, JSON.stringify(reordered.diagnostics)).toBe(true);
    const props = (reordered.document as typeof project).rooms.foyer!.data.props;
    expect(Object.fromEntries(props.map((item) => [item.id, item.order]))).toEqual({
      rear: -2147483646,
      front: -2147483647,
    });
  });

  it('rejects Room presentation orders outside the native signed 32-bit range', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'stage',
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        presentation: { label: null, layout: null },
      },
    ];
    room.props = [
      {
        id: 'prop',
        condition: { kind: 'always' },
        placementId: 'stage',
        asset: null,
        materialApplication: null,
        visible: true,
        order: 0,
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    const initial = createInitialCommandBusState(toJsonValue(project));

    const rejected = executeCommand(initial, {
      type: 'room.setPresentationOrder',
      payload: {
        roomId: 'foyer',
        target: { kind: 'prop', id: 'prop' },
        order: 2147483648,
      },
    });

    expect(rejected.ok).toBe(false);
    expect(rejected.state).toEqual(initial);
  });

  it('reorders a same-plane multi-selection atomically while preserving selected relative order', () => {
    const project = createAuthoringProject();
    project.assets.pixel = {
      id: 'pixel',
      label: 'Pixel',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/pixel.png' },
        aliases: [],
        imageMetadata: { width: 1, height: 1, hasAlpha: true, orientation: 1 },
      },
    };
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'stage',
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        presentation: { label: null, layout: null },
      },
    ];
    room.props = ['a', 'b', 'c', 'd'].map((id, index) => ({
      id,
      condition: { kind: 'always' as const },
      placementId: 'stage',
      asset: { $ref: { collection: 'assets' as const, id: 'pixel' } },
      materialApplication: null,
      visible: true,
      order: index * 1024,
    }));
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    const initial = createInitialCommandBusState(toJsonValue(project));

    const reordered = executeCommand(initial, {
      type: 'room.reorderPresentationSelection',
      payload: {
        roomId: 'foyer',
        targets: [
          { kind: 'prop', id: 'b' },
          { kind: 'prop', id: 'c' },
        ],
        action: 'front',
      },
    });

    expect(reordered.ok, JSON.stringify(reordered.diagnostics)).toBe(true);
    const props = (reordered.document as typeof project).rooms.foyer!.data.props;
    expect(
      [...props].sort((left, right) => left.order - right.order).map((item) => item.id),
    ).toEqual(['a', 'd', 'b', 'c']);
    expect(props.find((item) => item.id === 'a')?.order).toBe(0);
    expect(props.find((item) => item.id === 'd')?.order).toBe(3072);
    expect(new Set(props.map((item) => item.order)).size).toBe(4);
    expect(reordered.state.history.entries).toHaveLength(initial.history.entries.length + 1);
    expect(reordered.state.history.cursor).toBe(initial.history.cursor + 1);
    expect(undoCommand(reordered.state).document).toEqual(initial.document);
  });

  it('rejects bulk presentation reordering across different planes', () => {
    const project = createAuthoringProject();
    project.assets.pixel = {
      id: 'pixel',
      label: 'Pixel',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/pixel.png' },
        aliases: [],
        imageMetadata: { width: 1, height: 1, hasAlpha: true, orientation: 1 },
      },
    };
    project.materials.effect = {
      id: 'effect',
      label: 'Effect',
      data: defaultMaterialData('Effect', 'engine-2d'),
    };
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'stage',
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        presentation: { label: null, layout: null },
      },
    ];
    room.props = [
      {
        id: 'prop',
        condition: { kind: 'always' },
        placementId: 'stage',
        asset: { $ref: { collection: 'assets', id: 'pixel' } },
        materialApplication: null,
        visible: true,
        order: 0,
      },
    ];
    room.environments = [
      {
        id: 'overlay-effect',
        condition: { kind: 'always' },
        asset: null,
        materialApplication: emptyMaterialApplication('effect'),
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        plane: 'world-overlay',
        order: 0,
        clock: 'gameplay',
        scrollPerSecond: { x: 0, y: 0 },
        opacity: 1,
        visible: true,
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    const initial = createInitialCommandBusState(toJsonValue(project));

    const rejected = executeCommand(initial, {
      type: 'room.reorderPresentationSelection',
      payload: {
        roomId: 'foyer',
        targets: [
          { kind: 'prop', id: 'prop' },
          { kind: 'environment', id: 'overlay-effect' },
        ],
        action: 'front',
      },
    });

    expect(rejected.ok).toBe(false);
    expect(rejected.state).toEqual(initial);
  });

  it('uses one add command for dedicated placement by default and explicit placement sharing', () => {
    const project = createAuthoringProject();
    project.assets.pixel = {
      id: 'pixel',
      label: 'Pixel',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/pixel.png' },
        aliases: [],
        imageMetadata: { width: 1, height: 1, hasAlpha: true, orientation: 1 },
      },
    };
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'shared',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        presentation: { label: null, layout: null },
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    let state = createInitialCommandBusState(toJsonValue(project));

    const dedicated = executeCommand(state, {
      type: 'room.addPresentationContent',
      payload: {
        roomId: 'foyer',
        kind: 'prop',
        assetId: 'pixel',
        point: { x: 0.8, y: 0.7 },
      },
    });
    expect(dedicated.ok, JSON.stringify(dedicated.diagnostics)).toBe(true);
    state = dedicated.state;
    const afterDedicated = (state.document as typeof project).rooms.foyer!.data;
    const dedicatedProp = afterDedicated.props[0]!;
    expect(dedicatedProp.placementId).not.toBe('shared');
    const dedicatedBounds = afterDedicated.placements.find(
      (item) => item.id === dedicatedProp.placementId,
    )?.bounds;
    expect(dedicatedBounds?.x).toBeCloseTo(0.7);
    expect(dedicatedBounds?.y).toBeCloseTo(0.6);
    expect(dedicatedBounds?.width).toBe(0.2);
    expect(dedicatedBounds?.height).toBe(0.2);

    const shared = executeCommand(state, {
      type: 'room.addPresentationContent',
      payload: {
        roomId: 'foyer',
        kind: 'prop',
        assetId: 'pixel',
        placementId: 'shared',
      },
    });
    expect(shared.ok, JSON.stringify(shared.diagnostics)).toBe(true);
    const afterShared = (shared.document as typeof project).rooms.foyer!.data;
    expect(afterShared.placements).toHaveLength(2);
    expect(afterShared.props.map((item) => item.placementId)).toEqual([
      dedicatedProp.placementId,
      'shared',
    ]);
  });

  it('rejects non-image Assets for image-backed Prop and Environment Add', () => {
    const project = createAuthoringProject();
    project.assets.theme = {
      id: 'theme',
      label: 'Theme',
      data: {
        kind: 'audio',
        source: { type: 'project-file', path: 'assets/audio/theme.mp3' },
        aliases: [],
        extension: '.mp3',
        imageMetadata: null,
      },
    };
    project.materials.surface = {
      id: 'surface',
      label: 'Surface',
      data: defaultMaterialData('Surface'),
    };
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    const state = createInitialCommandBusState(toJsonValue(project));

    for (const payload of [
      {
        roomId: 'foyer',
        kind: 'prop' as const,
        assetId: 'theme',
        point: { x: 0.5, y: 0.5 },
      },
      {
        roomId: 'foyer',
        kind: 'environment' as const,
        assetId: 'theme',
        materialId: 'surface',
        point: { x: 0.5, y: 0.5 },
      },
    ]) {
      const result = executeCommand(state, {
        type: 'room.addPresentationContent',
        payload,
      });
      expect(result.ok).toBe(false);
      expect(result.state.document).toEqual(state.document);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ severity: 'error', message: expect.stringContaining('image') }),
      ]);
    }
  });

  it('places an explicitly selected existing Interactable Instance without creating another Instance', () => {
    const project = createAuthoringProject();
    project.interactables.key = {
      id: 'key',
      label: 'Brass key',
      data: defaultInteractableData('Brass key'),
    };
    project.interactableInstances['key-instance'] = defaultInteractableInstanceData(
      'key-instance',
      'key',
    );
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    const state = createInitialCommandBusState(toJsonValue(project));

    const result = executeCommand(state, {
      type: 'room.addPresentationContent',
      payload: {
        roomId: 'foyer',
        kind: 'interactable',
        source: { kind: 'existing', instanceId: 'key-instance' },
        point: { x: 0.65, y: 0.45 },
      },
    });

    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    const document = result.document as typeof project;
    expect(Object.keys(document.interactableInstances)).toEqual(['key-instance']);
    expect(document.interactableInstances['key-instance']?.location).toEqual({
      kind: 'room',
      room: { $ref: { collection: 'rooms', id: 'foyer' } },
    });
    expect(document.rooms.foyer?.data.interactables).toEqual([
      expect.objectContaining({
        interactable: { $ref: { registry: 'interactableInstances', id: 'key-instance' } },
      }),
    ]);
  });

  it('adds an existing same-Room Interactable Instance to an explicit placement without duplicating it', () => {
    const project = createAuthoringProject();
    project.interactables.key = {
      id: 'key',
      label: 'Brass key',
      data: defaultInteractableData('Brass key'),
    };
    project.interactableInstances['key-instance'] = defaultInteractableInstanceData(
      'key-instance',
      'key',
      { kind: 'room', room: { $ref: { collection: 'rooms', id: 'foyer' } } },
    );
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'shared',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        presentation: { label: null, layout: null },
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    const state = createInitialCommandBusState(toJsonValue(project));

    const result = executeCommand(state, {
      type: 'room.addPresentationContent',
      payload: {
        roomId: 'foyer',
        kind: 'interactable',
        source: { kind: 'existing', instanceId: 'key-instance' },
        placementId: 'shared',
      },
    });

    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    const document = result.document as typeof project;
    expect(Object.keys(document.interactableInstances)).toEqual(['key-instance']);
    expect(document.rooms.foyer?.data.placements).toHaveLength(1);
    expect(document.rooms.foyer?.data.interactables).toEqual([
      expect.objectContaining({
        placementId: 'shared',
        interactable: { $ref: { registry: 'interactableInstances', id: 'key-instance' } },
      }),
    ]);
  });

  it('adds another dedicated occurrence for an existing same-Room exact Instance with a unique occurrence ID', () => {
    const project = createAuthoringProject();
    project.interactables.key = {
      id: 'key',
      label: 'Brass key',
      data: defaultInteractableData('Brass key'),
    };
    project.interactableInstances['key-instance'] = defaultInteractableInstanceData(
      'key-instance',
      'key',
      { kind: 'room', room: { $ref: { collection: 'rooms', id: 'foyer' } } },
    );
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'existing-placement',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        presentation: { label: null, layout: null },
      },
    ];
    room.interactables = [
      {
        id: 'key-instance',
        interactable: { $ref: { registry: 'interactableInstances', id: 'key-instance' } },
        condition: { kind: 'always' },
        placementId: 'existing-placement',
        visible: true,
        order: 0,
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    const state = createInitialCommandBusState(toJsonValue(project));

    const result = executeCommand(state, {
      type: 'room.addPresentationContent',
      payload: {
        roomId: 'foyer',
        kind: 'interactable',
        source: { kind: 'existing', instanceId: 'key-instance' },
        point: { x: 0.7, y: 0.6 },
      },
    });

    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    const document = result.document as typeof project;
    expect(Object.keys(document.interactableInstances)).toEqual(['key-instance']);
    expect(document.rooms.foyer?.data.interactables.map((item) => item.id)).toEqual([
      'key-instance',
      'key-instance-2',
    ]);
    expect(document.rooms.foyer?.data.placements).toHaveLength(2);
  });
});
