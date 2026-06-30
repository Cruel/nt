import { describe, expect, it } from 'vitest';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { buildReferenceIndex, findUsages } from '@/project/reference-index';

describe('authoring reference index', () => {
  it('indexes entrypoint, parent, inheritance, and explicit data refs', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', tags: [], data: {} };
    project.rooms.hall = {
      id: 'hall',
      label: 'Hall',
      parent: { collection: 'rooms', id: 'foyer' },
      tags: [],
      data: {},
    };
    project.objects['base-lamp'] = { id: 'base-lamp', label: 'Base Lamp', tags: [], data: {} };
    project.objects.lamp = {
      id: 'lamp',
      label: 'Lamp',
      inherits: { collection: 'objects', id: 'base-lamp' },
      tags: [],
      data: { home: { $ref: { collection: 'rooms', id: 'foyer' } } },
    };
    project.layouts.main = { id: 'main', label: 'Main UI', tags: [], data: {} };
    project.settings.ui = { defaultLayout: { $ref: { collection: 'layouts', id: 'main' } } };
    project.entrypoint = { collection: 'rooms', id: 'foyer' };

    const index = buildReferenceIndex(project);

    expect(findUsages(index, { collection: 'rooms', id: 'foyer' })).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'entrypoint', path: '/entrypoint' }),
      expect.objectContaining({ kind: 'parent', path: '/rooms/hall/parent' }),
      expect.objectContaining({ kind: 'explicit-ref', path: '/objects/lamp/data/home/$ref' }),
    ]));
    expect(findUsages(index, { collection: 'objects', id: 'base-lamp' })).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'inherits', path: '/objects/lamp/inherits' }),
    ]));
    expect(findUsages(index, { collection: 'layouts', id: 'main' })).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceCollection: 'project', sourceId: 'settings', kind: 'explicit-ref', path: '/settings/ui/defaultLayout/$ref' }),
    ]));
  });

  it('returns no usages for unreferenced targets', () => {
    const index = buildReferenceIndex(createAuthoringProject());
    expect(findUsages(index, { collection: 'rooms', id: 'missing' })).toEqual([]);
  });
});
