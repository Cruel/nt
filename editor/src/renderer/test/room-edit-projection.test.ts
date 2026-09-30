import { describe, expect, it } from 'vite-plus/test';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  defaultInteractableData,
  defaultInteractableInstanceData,
} from '../../shared/project-schema/authoring-interactables';
import { emptyMaterialApplication } from '../../shared/project-schema/authoring-material-applications';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import {
  fitRoomEditBackground,
  resolveRoomEditProjection,
} from '@/editors/rooms/room-edit-projection';

describe('Room Edit spatial projection', () => {
  it('resolves the authored world-composition subset with cross-family plane/order and exact Layout placeholder geometry', () => {
    const project = createAuthoringProject({ id: 'world-composition-test' });
    const room = defaultRoomData('Composition Room');
    room.presentationSpace = {
      size: { width: 1000, height: 500 },
      bounds: null,
      edgePolicy: 'overscan',
      defaultView: { center: { x: 500, y: 250 }, zoom: 1, rotationDegrees: 0 },
      views: [],
    };
    room.placements = [
      {
        id: 'shared',
        bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        presentation: {
          label: null,
          layout: { $ref: { collection: 'layouts', id: 'speech-ui' } },
          layoutOrder: 7,
        },
      },
      {
        id: 'empty',
        bounds: { x: 0.75, y: 0.1, width: 0.1, height: 0.15 },
        presentation: { label: null, layout: null },
      },
    ];
    room.cast = [
      {
        id: 'hero-cast',
        character: { $ref: { collection: 'characters', id: 'hero' } },
        condition: { kind: 'always' },
        placementId: 'shared',
        profileId: 'stage',
        poseId: 'default',
        expressionId: 'neutral',
        appearanceId: null,
        idleId: null,
        visible: true,
        order: 20,
      },
    ];
    room.props = [
      {
        id: 'desk',
        condition: { kind: 'always' },
        placementId: 'shared',
        asset: { $ref: { collection: 'assets', id: 'desk-image' } },
        materialApplication: emptyMaterialApplication('world-material'),
        visible: true,
        order: 10,
      },
      {
        id: 'hidden-prop',
        condition: { kind: 'not', condition: { kind: 'always' } },
        placementId: 'empty',
        asset: { $ref: { collection: 'assets', id: 'desk-image' } },
        materialApplication: null,
        visible: true,
        order: 11,
      },
    ];
    room.interactables = [
      {
        id: 'terminal',
        interactable: { $ref: { registry: 'interactableInstances', id: 'terminal-instance' } },
        condition: { kind: 'always' },
        placementId: 'shared',
        visible: true,
        order: 30,
      },
    ];
    room.environments = [
      {
        id: 'back-fog',
        condition: { kind: 'always' },
        asset: { $ref: { collection: 'assets', id: 'fog-image' } },
        materialApplication: emptyMaterialApplication('world-material'),
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        plane: 'world-background',
        order: -5,
        clock: 'unscaled-presentation',
        scrollPerSecond: { x: 0, y: 0 },
        opacity: 0.5,
        visible: true,
      },
      {
        id: 'front-fog',
        condition: { kind: 'always' },
        asset: { $ref: { collection: 'assets', id: 'fog-image' } },
        materialApplication: emptyMaterialApplication('world-material'),
        bounds: { x: 0.6, y: 0.1, width: 0.2, height: 0.4 },
        plane: 'world-content',
        order: 15,
        clock: 'gameplay',
        scrollPerSecond: { x: 0, y: 0 },
        opacity: 1,
        visible: true,
      },
    ];
    project.rooms.room = { id: 'room', label: 'Room', data: room };
    project.layouts['speech-ui'] = {
      id: 'speech-ui',
      label: 'Speech UI',
      data: defaultLayoutData('Speech UI'),
    };
    project.materials['world-material'] = {
      id: 'world-material',
      label: 'World Material',
      data: defaultMaterialData('World Material', 'engine-2d'),
    };
    for (const [id, width, height] of [
      ['hero-image', 100, 200],
      ['desk-image', 300, 160],
      ['fog-image', 400, 200],
    ] as const) {
      project.assets[id] = {
        id,
        label: id,
        data: {
          kind: 'image',
          source: { type: 'project-file', path: `assets/${id}.png` },
          aliases: [],
          sampling: 'linear',
          byteSize: 1,
          contentHash: `sha256:${'a'.repeat(64)}`,
          imageMetadata: { width, height, hasAlpha: true, orientation: 1 },
        },
      };
    }

    const character = defaultCharacterData('Hero');
    character.initialWorldState = {
      location: { kind: 'room', room: { $ref: { collection: 'rooms', id: 'room' } } },
      enabled: true,
      visible: true,
    };
    project.characters.hero = {
      id: 'hero',
      label: 'Hero',
      localProperties: [
        {
          id: 'glow',
          label: 'Glow',
          type: 'number',
          nullable: false,
          value: 0.75,
        },
      ],
      data: character,
    };
    character.profiles[0]!.poses[0]!.layers[0] = {
      ...character.profiles[0]!.poses[0]!.layers[0]!,
      sprite: { $ref: { collection: 'assets', id: 'hero-image' } },
      materialApplication: emptyMaterialApplication('world-material'),
      offset: { x: 10, y: -20 },
      scale: 0.5,
      anchor: { x: 0.5, y: 1 },
    };
    project.characters.hero!.data = character;

    project.interactables.terminal = {
      id: 'terminal',
      label: 'Terminal',
      data: {
        ...defaultInteractableData('Terminal'),
        presentation: {
          ...defaultInteractableData('Terminal').presentation,
          sprite: { $ref: { collection: 'assets', id: 'desk-image' } },
          materialApplication: emptyMaterialApplication('world-material'),
        },
      },
    };
    project.interactableInstances['terminal-instance'] = defaultInteractableInstanceData(
      'terminal-instance',
      'terminal',
      { kind: 'room', room: { $ref: { collection: 'rooms', id: 'room' } } },
    );

    const projection = resolveRoomEditProjection({
      project,
      roomId: 'room',
      room,
      viewport: { width: 1000, height: 500 },
      backgroundImageSize: null,
    });

    expect(projection.placements.map((item) => item.id)).toEqual(['shared', 'empty']);
    expect(projection.props.map((item) => [item.occurrenceId, item.rect])).toEqual([
      ['desk', { x: 100, y: 100, width: 300, height: 200 }],
    ]);
    expect(
      projection.environments.map((item) => [item.occurrenceId, item.plane, item.rect]),
    ).toEqual([
      ['back-fog', 'world-background', { x: 0, y: 0, width: 1000, height: 500 }],
      ['front-fog', 'world-content', { x: 600, y: 50, width: 200, height: 200 }],
    ]);
    expect(projection.cast[0]).toMatchObject({
      occurrenceId: 'hero-cast',
      plane: 'world-content',
      order: 20,
      layers: [
        {
          layerId: 'body',
          rect: { x: 230, y: 190, width: 50, height: 100 },
          spriteAssetId: 'hero-image',
          propertyValues: { glow: 0.75 },
        },
      ],
    });
    expect(projection.layoutPlaceholders).toEqual([
      expect.objectContaining({
        placementId: 'shared',
        layoutId: 'speech-ui',
        label: 'Speech UI',
        order: 7,
        rect: { x: 100, y: 100, width: 300, height: 200 },
        hasRenderedOccupants: true,
      }),
    ]);
    expect(
      projection.worldDraws.map((item) => `${item.plane}:${item.kind}:${item.occurrenceId}`),
    ).toEqual([
      'world-background:environment:back-fog',
      'world-content:prop:desk',
      'world-content:environment:front-fog',
      'world-content:cast-layer:hero-cast:body',
      'world-content:interactable:terminal',
    ]);
  });

  it('projects placements and Interactable occurrences through the authored camera with independent stack order', () => {
    const project = createAuthoringProject({ id: 'projection-test' });
    const room = defaultRoomData('Projection Room');
    room.presentationSpace = {
      size: { width: 2000, height: 1000 },
      bounds: null,
      edgePolicy: 'overscan',
      defaultView: { center: { x: 1000, y: 500 }, zoom: 2, rotationDegrees: 15 },
      views: [],
    };
    room.placements = [
      {
        id: 'shared',
        bounds: { x: 0.25, y: 0.25, width: 0.2, height: 0.2 },
        presentation: { label: null, layout: null },
      },
      {
        id: 'empty',
        bounds: { x: 0.7, y: 0.1, width: 0.1, height: 0.3 },
        presentation: { label: null, layout: null },
      },
    ];
    room.interactables = [
      {
        id: 'rear',
        interactable: { $ref: { registry: 'interactableInstances', id: 'rear-instance' } },
        condition: { kind: 'always' },
        placementId: 'shared',
        visible: true,
        order: -20,
      },
      {
        id: 'front',
        interactable: { $ref: { registry: 'interactableInstances', id: 'front-instance' } },
        condition: { kind: 'always' },
        placementId: 'shared',
        visible: true,
        order: 40,
      },
    ];
    project.rooms.room = { id: 'room', label: 'Room', data: room };
    project.interactables.token = {
      id: 'token',
      label: 'Token',
      defaultProperties: [{ id: 'heat', type: 'number', nullable: false, defaultValue: 0.25 }],
      data: defaultInteractableData('Token'),
    };
    project.interactableInstances['rear-instance'] = defaultInteractableInstanceData(
      'rear-instance',
      'token',
      {
        kind: 'room',
        room: { $ref: { collection: 'rooms', id: 'room' } },
      },
    );
    project.interactableInstances['front-instance'] = defaultInteractableInstanceData(
      'front-instance',
      'token',
      {
        kind: 'room',
        room: { $ref: { collection: 'rooms', id: 'room' } },
      },
    );
    project.interactableInstances['front-instance']!.localProperties.push({
      id: 'heat',
      type: 'number',
      nullable: false,
      value: 0.75,
    });

    const projection = resolveRoomEditProjection({
      project,
      roomId: 'room',
      room,
      viewport: { width: 1000, height: 500 },
      backgroundImageSize: null,
    });

    expect(projection.placements[0]?.rect).toEqual({ x: 0, y: 0, width: 400, height: 200 });
    expect(projection.placements[0]?.rotationDegrees).toBe(-15);
    expect(projection.backgroundColor).toEqual({
      rect: { x: -500, y: -250, width: 2000, height: 1000 },
      rotationDegrees: -15,
    });
    expect(projection.placements.map((item) => item.id)).toEqual(['shared', 'empty']);
    expect(projection.interactables.map((item) => item.occurrenceId)).toEqual(['rear', 'front']);
    expect(projection.interactables.map((item) => item.rect)).toEqual([
      { x: 0, y: 0, width: 400, height: 200 },
      { x: 0, y: 0, width: 400, height: 200 },
    ]);
    expect(projection.interactables.map((item) => item.propertyValues.heat)).toEqual([0.25, 0.75]);
  });

  it('matches runtime Interactable tie-breaking by exact Instance identity', () => {
    const project = createAuthoringProject({ id: 'stack-tie-test' });
    const room = defaultRoomData('Stack Tie Room');
    room.placements = [
      {
        id: 'shared',
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        presentation: { label: null, layout: null },
      },
    ];
    room.interactables = [
      {
        id: 'occurrence-a',
        interactable: { $ref: { registry: 'interactableInstances', id: 'z-instance' } },
        condition: { kind: 'always' },
        placementId: 'shared',
        visible: true,
        order: 10,
      },
      {
        id: 'occurrence-z',
        interactable: { $ref: { registry: 'interactableInstances', id: 'a-instance' } },
        condition: { kind: 'always' },
        placementId: 'shared',
        visible: true,
        order: 10,
      },
    ];
    project.interactables.token = {
      id: 'token',
      label: 'Token',
      data: {
        ...defaultInteractableData('Token'),
        presentation: {
          ...defaultInteractableData('Token').presentation,
          materialApplication: emptyMaterialApplication('token-material'),
        },
      },
    };
    project.materials['token-material'] = {
      id: 'token-material',
      label: 'Token Material',
      data: defaultMaterialData('Token Material', 'engine-2d'),
    };
    project.interactableInstances['z-instance'] = defaultInteractableInstanceData(
      'z-instance',
      'token',
      { kind: 'room', room: { $ref: { collection: 'rooms', id: 'room' } } },
    );
    project.interactableInstances['a-instance'] = defaultInteractableInstanceData(
      'a-instance',
      'token',
      { kind: 'room', room: { $ref: { collection: 'rooms', id: 'room' } } },
    );

    const projection = resolveRoomEditProjection({
      project,
      roomId: 'room',
      room,
      viewport: { width: 1920, height: 1080 },
      backgroundImageSize: null,
    });

    expect(projection.interactables.map((item) => item.instanceId)).toEqual([
      'a-instance',
      'z-instance',
    ]);
    expect(
      projection.worldDraws
        .filter((item) => item.kind === 'interactable')
        .map((item) => item.instanceId),
    ).toEqual(['a-instance', 'z-instance']);
  });

  it('keeps unsupported conditions visible instead of silently treating them as false', () => {
    const project = createAuthoringProject({ id: 'condition-test' });
    const room = defaultRoomData('Condition Room');
    room.placements = [
      {
        id: 'slot',
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        presentation: { label: null, layout: null },
      },
    ];
    room.props = [
      {
        id: 'lua-true',
        condition: { kind: 'lua-predicate', source: 'return true' },
        placementId: 'slot',
        asset: null,
        materialApplication: null,
        visible: true,
        order: 1,
      },
      {
        id: 'not-lua',
        condition: {
          kind: 'not',
          condition: { kind: 'lua-predicate', source: 'return true' },
        },
        placementId: 'slot',
        asset: null,
        materialApplication: null,
        visible: true,
        order: 2,
      },
      {
        id: 'definitely-hidden',
        condition: { kind: 'not', condition: { kind: 'always' } },
        placementId: 'slot',
        asset: null,
        materialApplication: null,
        visible: true,
        order: 3,
      },
    ];
    project.rooms.room = { id: 'room', label: 'Room', data: room };

    const projection = resolveRoomEditProjection({
      project,
      roomId: 'room',
      room,
      viewport: { width: 1920, height: 1080 },
      backgroundImageSize: null,
    });

    expect(projection.props.map((item) => item.occurrenceId)).toEqual(['lua-true', 'not-lua']);
  });

  it('matches runtime contain camera clamping and background fit geometry', () => {
    const project = createAuthoringProject({ id: 'camera-test' });
    const room = defaultRoomData('Camera Room');
    room.presentationSpace = {
      size: { width: 1000, height: 500 },
      bounds: { x: 100, y: 50, width: 800, height: 400 },
      edgePolicy: 'contain',
      defaultView: { center: { x: 850, y: 425 }, zoom: 2, rotationDegrees: 0 },
      views: [],
    };
    project.rooms.room = { id: 'room', label: 'Room', data: room };

    const projection = resolveRoomEditProjection({
      project,
      roomId: 'room',
      room,
      viewport: { width: 1000, height: 500 },
      backgroundImageSize: { width: 400, height: 800 },
    });

    expect(projection.camera.center).toEqual({ x: 650, y: 325 });
    expect(projection.background.rect).toEqual({ x: -800, y: -400, width: 2000, height: 1000 });
    expect(projection.background.uv).toEqual({ x: 0, y: 0.375, width: 1, height: 0.25 });

    expect(
      fitRoomEditBackground({ width: 1000, height: 500 }, { width: 400, height: 800 }, 'contain'),
    ).toEqual({
      rect: { x: 375, y: 0, width: 250, height: 500 },
      uv: { x: 0, y: 0, width: 1, height: 1 },
    });
    expect(
      fitRoomEditBackground({ width: 1000, height: 500 }, { width: 400, height: 800 }, 'center'),
    ).toEqual({
      rect: { x: 300, y: -150, width: 400, height: 800 },
      uv: { x: 0, y: 0, width: 1, height: 1 },
    });
  });
});
