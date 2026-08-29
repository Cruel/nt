import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultMapData, validateMapData } from '../../shared/project-schema/authoring-maps';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';

function addRoom(project: ReturnType<typeof createAuthoringProject>, id: string) {
  project.rooms[id] = {
    id,
    label: id,
    traits: [],
    data: defaultRoomData(id),
  };
}

function addLocation(map: ReturnType<typeof defaultMapData>, id: string, room: string, order = 0) {
  map.locations.push({
    id,
    room: { $ref: { collection: 'rooms', id: room } },
    regions: [
      {
        points: [
          { x: 0.1, y: 0.1 },
          { x: 0.2, y: 0.1 },
          { x: 0.2, y: 0.2 },
        ],
      },
    ],
    label: null,
    icon: null,
    style: null,
    labelAnchor: null,
    connectionAnchor: null,
    visibility: { kind: 'always' },
    pickOrder: order,
    logicalOrder: order,
  });
}

describe('authoring maps', () => {
  it('accepts normalized multi-region locations and derives connection topology from one exit', () => {
    const project = createAuthoringProject();
    addRoom(project, 'a');
    addRoom(project, 'b');
    project.rooms.a.data.exits.push({
      id: 'to-b',
      label: 'B',
      direction: 'east',
      target: { $ref: { collection: 'rooms', id: 'b' } },
      condition: { kind: 'always' },
      onRejected: [],
    });
    const map = defaultMapData();
    addLocation(map, 'a-location', 'a');
    addLocation(map, 'b-location', 'b', 1);
    map.locations[0].regions.push({
      points: [
        { x: 0.4, y: 0.4 },
        { x: 0.5, y: 0.4 },
        { x: 0.5, y: 0.5 },
      ],
    });
    map.connections.push({
      id: 'a-b',
      exits: [{ room: 'a', exit: 'to-b' }],
      label: null,
      icon: null,
      style: null,
      visibility: { kind: 'always' },
      logicalOrder: 0,
      path: [],
      hitRegions: [],
    });

    expect(
      validateMapData(project, 'world', {
        id: 'world',
        label: 'World',
        traits: [],
        data: map,
      }),
    ).toEqual([]);
  });

  it('rejects duplicate Room projection and non-reciprocal paired exits', () => {
    const project = createAuthoringProject();
    addRoom(project, 'a');
    addRoom(project, 'b');
    addRoom(project, 'c');
    project.rooms.a.data.exits.push({
      id: 'to-b',
      label: 'B',
      direction: 'east',
      target: { $ref: { collection: 'rooms', id: 'b' } },
      condition: { kind: 'always' },
      onRejected: [],
    });
    project.rooms.c.data.exits.push({
      id: 'to-b',
      label: 'B',
      direction: 'west',
      target: { $ref: { collection: 'rooms', id: 'b' } },
      condition: { kind: 'always' },
      onRejected: [],
    });
    const map = defaultMapData();
    addLocation(map, 'a-location', 'a');
    addLocation(map, 'a-location-2', 'a');
    addLocation(map, 'b-location', 'b');
    addLocation(map, 'c-location', 'c');
    map.connections.push({
      id: 'broken',
      exits: [
        { room: 'a', exit: 'to-b' },
        { room: 'c', exit: 'to-b' },
      ],
      label: null,
      icon: null,
      style: null,
      visibility: { kind: 'always' },
      logicalOrder: 0,
      path: [],
      hitRegions: [],
    });

    expect(
      validateMapData(project, 'world', {
        id: 'world',
        label: 'World',
        traits: [],
        data: map,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/maps/world/data/locations/1/room/$ref',
          message: expect.stringContaining('already has a Map Location'),
        }),
        expect.objectContaining({
          path: '/maps/world/data/connections/0/exits',
          message: expect.stringContaining('reciprocal exits'),
        }),
      ]),
    );
  });

  it('rejects coordinates outside the normalized canvas', () => {
    const map = defaultMapData();
    const project = createAuthoringProject();
    addRoom(project, 'a');
    addLocation(map, 'a-location', 'a');
    map.locations[0].regions[0].points[0].x = 1.1;

    expect(
      validateMapData(project, 'world', {
        id: 'world',
        label: 'World',
        traits: [],
        data: map,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/maps/world/data/locations/0/regions/0/points/0/x' }),
      ]),
    );
  });
});
