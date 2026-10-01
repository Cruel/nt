import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { roomEditVisibilityKey } from '@/editors/rooms/room-edit-visibility';

describe('Room Edit visibility authority', () => {
  it('retains its semantic key across geometry and ordering edits', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'door',
        bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        presentation: { label: null, layout: null },
      },
    ];
    room.props = [
      {
        id: 'sign',
        condition: { kind: 'lua-predicate', source: 'return true' },
        placementId: 'door',
        asset: null,
        materialApplication: null,
        visible: true,
        order: 4,
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    const before = roomEditVisibilityKey(project, 'foyer', room);

    const geometryOnly = structuredClone(room);
    geometryOnly.placements[0]!.bounds = { x: 0.5, y: 0.1, width: 0.2, height: 0.25 };
    geometryOnly.props[0]!.placementId = 'door';
    geometryOnly.props[0]!.order = 999;

    expect(roomEditVisibilityKey(project, 'foyer', geometryOnly)).toBe(before);
  });

  it('invalidates its semantic key when visibility-affecting inputs change', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.props = [
      {
        id: 'sign',
        condition: { kind: 'lua-predicate', source: 'return true' },
        placementId: 'default',
        asset: null,
        materialApplication: null,
        visible: true,
        order: 0,
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    const before = roomEditVisibilityKey(project, 'foyer', room);

    const conditionChanged = structuredClone(room);
    conditionChanged.props[0]!.condition = { kind: 'lua-predicate', source: 'return false' };
    expect(roomEditVisibilityKey(project, 'foyer', conditionChanged)).not.toBe(before);

    const visibilityChanged = structuredClone(room);
    visibilityChanged.props[0]!.visible = false;
    expect(roomEditVisibilityKey(project, 'foyer', visibilityChanged)).not.toBe(before);
  });
});
