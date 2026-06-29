import { describe, expect, it } from 'vitest';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { authoringValidationSucceeded, validateAuthoringProject } from '../../shared/project-schema/authoring-validation';

describe('authoring validation', () => {
  it('allows an empty new project with entrypoint guidance only', () => {
    const diagnostics = validateAuthoringProject(createAuthoringProject());

    expect(authoringValidationSucceeded(diagnostics)).toBe(true);
    expect(diagnostics).toContainEqual(expect.objectContaining({ severity: 'warning', path: '/entrypoint' }));
  });

  it('reports invalid ids and record key mismatches', () => {
    const project = createAuthoringProject();
    project.rooms['Bad ID'] = { id: 'different-id', label: 'Room', tags: [], data: {} };

    const diagnostics = validateAuthoringProject(project);

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'error', path: '/rooms/Bad ID' }),
      expect.objectContaining({ severity: 'error', path: '/rooms/Bad ID/id' }),
    ]));
  });

  it('reports missing reference targets', () => {
    const project = createAuthoringProject();
    project.entrypoint = { collection: 'rooms', id: 'missing-room' };
    project.rooms.child = {
      id: 'child',
      label: 'Child',
      parent: { collection: 'rooms', id: 'missing-parent' },
      tags: [],
      data: {},
    };

    const diagnostics = validateAuthoringProject(project);

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'error', path: '/entrypoint' }),
      expect.objectContaining({ severity: 'error', path: '/rooms/child/parent' }),
    ]));
  });

  it('reports parent and inheritance cycles', () => {
    const project = createAuthoringProject();
    project.rooms.a = { id: 'a', label: 'A', parent: { collection: 'rooms', id: 'b' }, tags: [], data: {} };
    project.rooms.b = { id: 'b', label: 'B', parent: { collection: 'rooms', id: 'a' }, tags: [], data: {} };
    project.objects.a = { id: 'a', label: 'A', inherits: { collection: 'objects', id: 'b' }, tags: [], data: {} };
    project.objects.b = { id: 'b', label: 'B', inherits: { collection: 'objects', id: 'a' }, tags: [], data: {} };

    const diagnostics = validateAuthoringProject(project);

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'error', path: '/rooms/a/parent' }),
      expect.objectContaining({ severity: 'error', path: '/objects/a/inherits' }),
    ]));
  });
});
