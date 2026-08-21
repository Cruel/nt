import { describe, expect, it } from 'vite-plus/test';
import { defaultInteractableData } from '../../shared/project-schema/authoring-interactables';
import { validateHotspotAuthoringSemantics } from '../../shared/project-schema/authoring-hotspot-validation';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  authoringValidationSucceeded,
  validateAuthoringProject,
} from '../../shared/project-schema/authoring-validation';

describe('authoring V2 validation', () => {
  it('allows an empty new project with entrypoint guidance only', () => {
    const diagnostics = validateAuthoringProject(createAuthoringProject());
    expect(authoringValidationSucceeded(diagnostics)).toBe(true);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'authoring.entrypoint.missing',
        severity: 'warning',
        path: '/entrypoint',
        ownerPaths: ['/entrypoint'],
        boundaries: ['authoring', 'runtime-package', 'platform-export'],
      }),
    );
  });

  it('treats an unconfigured hotspot Verb as incomplete authoring rather than a hard error', () => {
    const project = createAuthoringProject();
    project.interactables.key = {
      id: 'key',
      label: 'Key',
      data: defaultInteractableData('Key'),
    };
    expect(validateHotspotAuthoringSemantics(project)).toContainEqual(
      expect.objectContaining({
        code: 'hotspot.authoring.verb.required',
        severity: 'warning',
        path: '/interactables/key/data/presentation/hotspots/hotspot/activation/verb',
      }),
    );
  });

  it('rejects strict unknown fields', () => {
    const project = createAuthoringProject();
    project.rooms.room = { id: 'room', label: 'Room', data: defaultRoomData() };
    expect(
      validateAuthoringProject({
        ...project,
        rooms: { room: { ...project.rooms.room, parent: null } },
      }),
    ).toContainEqual(expect.objectContaining({ severity: 'error', path: '/rooms/room' }));
  });

  it('reports missing entrypoints and same-type extends cycles', () => {
    const project = createAuthoringProject();
    project.entrypoint = { kind: 'room', id: 'missing-room' };
    project.rooms.a = { id: 'a', label: 'A', extends: 'b', data: defaultRoomData('A') };
    project.rooms.b = { id: 'b', label: 'B', extends: 'a', data: defaultRoomData('B') };
    const diagnostics = validateAuthoringProject(project);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'authoring.entrypoint.target-missing',
          severity: 'error',
          path: '/entrypoint',
          ownerPaths: ['/entrypoint'],
          boundaries: ['authoring', 'runtime-package', 'platform-export'],
        }),
        expect.objectContaining({
          code: 'authoring.project.validation.rooms.record.extends',
          severity: 'error',
          path: '/rooms/a/extends',
          ownerPaths: ['/rooms/a/extends'],
          boundaries: ['authoring', 'runtime-package', 'platform-export'],
        }),
      ]),
    );
  });

  it('validates declared property owner kinds and assignments', () => {
    const project = createAuthoringProject();
    project.properties['visit-count'] = {
      id: 'visit-count',
      label: 'Visit count',
      type: 'integer',
      nullable: false,
      defaultValue: 0,
      ownerKinds: ['room'],
      persistence: 'Save',
    };
    project.rooms.room = {
      id: 'room',
      label: 'Room',
      properties: { 'visit-count': 'wrong' },
      data: defaultRoomData(),
    };
    expect(validateAuthoringProject(project)).toContainEqual(
      expect.objectContaining({ path: '/rooms/room/properties/visit-count' }),
    );
  });
});
