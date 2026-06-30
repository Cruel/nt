import { describe, expect, it } from 'vitest';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { buildReferenceIndex, findUsages } from '@/project/reference-index';
import { characterAssetRef, characterMaterialRef, defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';

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

  it('indexes character sprite and material refs', () => {
    const project = createAuthoringProject();
    project.assets.iris = { id: 'iris', label: 'Iris Sprite', tags: [], data: {} };
    project.materials.glow = { id: 'glow', label: 'Glow', tags: [], data: defaultMaterialData('Glow') };
    const data = defaultCharacterData('Iris');
    data.poses[0]!.sprite = characterAssetRef('iris');
    data.expressions[0]!.material = characterMaterialRef('glow');
    project.characters.iris = { id: 'iris', label: 'Iris', tags: [], data };

    const index = buildReferenceIndex(project);

    expect(findUsages(index, { collection: 'assets', id: 'iris' })).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceCollection: 'characters', sourceId: 'iris', path: '/characters/iris/data/poses/0/sprite/$ref' }),
    ]));
    expect(findUsages(index, { collection: 'materials', id: 'glow' })).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceCollection: 'characters', sourceId: 'iris', path: '/characters/iris/data/expressions/0/material/$ref' }),
    ]));
  });

  it('returns no usages for unreferenced targets', () => {
    const index = buildReferenceIndex(createAuthoringProject());
    expect(findUsages(index, { collection: 'rooms', id: 'missing' })).toEqual([]);
  });
});
