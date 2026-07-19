import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultMapData, validateMapData } from '../../shared/project-schema/authoring-maps';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';

describe('authoring maps', () => {
  it('validates exit-backed topology', () => {
    const project = createAuthoringProject();
    project.rooms.a = {
      id: 'a',
      label: 'A',
      extends: null,
      properties: {},
      data: defaultRoomData('A'),
    };
    project.rooms.b = {
      id: 'b',
      label: 'B',
      extends: null,
      properties: {},
      data: defaultRoomData('B'),
    };
    project.rooms.a.data.exits.push({
      id: 'to-b',
      label: 'B',
      direction: 'east',
      target: { $ref: { collection: 'rooms', id: 'b' } },
      condition: { kind: 'always' },
    });
    const map = defaultMapData();
    map.locations.push({
      id: 'a-location',
      room: { $ref: { collection: 'rooms', id: 'a' } },
      position: { x: 0, y: 0 },
      shape: { kind: 'point' },
      label: null,
    });
    map.connections.push({
      id: 'broken',
      exit: { room: 'a', exit: 'to-b' },
      sourceLocation: 'a-location',
      targetLocation: 'missing',
    });

    expect(
      validateMapData(project, 'world', {
        id: 'world',
        label: 'World',
        extends: null,
        properties: {},
        data: map,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/maps/world/data/connections/0/targetLocation' }),
      ]),
    );
  });
});
