import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  defaultInteractableData,
  defaultInteractableInstanceData,
} from '../../shared/project-schema/authoring-interactables';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import {
  fitRoomEditBackground,
  resolveRoomEditProjection,
} from '@/editors/rooms/room-edit-projection';

describe('Room Edit spatial projection', () => {
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
    expect(projection.placements.map((item) => item.id)).toEqual(['shared', 'empty']);
    expect(projection.interactables.map((item) => item.occurrenceId)).toEqual(['rear', 'front']);
    expect(projection.interactables.map((item) => item.rect)).toEqual([
      { x: 0, y: 0, width: 400, height: 200 },
      { x: 0, y: 0, width: 400, height: 200 },
    ]);
    expect(projection.interactables.map((item) => item.propertyValues.heat)).toEqual([0.25, 0.75]);
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
