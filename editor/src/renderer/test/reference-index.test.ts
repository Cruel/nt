import { describe, expect, it } from 'vitest';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { buildReferenceIndex, findUsages } from '../../shared/project-schema/authoring-references';

describe('authoring reference index', () => {
  it('indexes typed entrypoint and same-type extends references', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData() };
    project.rooms.hall = { id: 'hall', label: 'Hall', extends: 'foyer', data: defaultRoomData() };
    project.entrypoint = { kind: 'room', id: 'foyer' };
    const usages = findUsages(buildReferenceIndex(project), { collection: 'rooms', id: 'foyer' });
    expect(usages).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'entrypoint', path: '/entrypoint' }),
      expect.objectContaining({ kind: 'extends', path: '/rooms/hall/extends' }),
    ]));
  });
});
