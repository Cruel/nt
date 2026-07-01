import { describe, expect, it } from 'vitest';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { assetDataFromImportMetadata } from '../../shared/project-schema/authoring-assets';
import { defaultExportProfile } from '../../shared/project-schema/authoring-export';
import { buildAuthoringRuntimeExport } from '../../shared/project-schema/authoring-runtime-export';
import { defaultRoomData, roomAssetRef, roomRoomRef } from '../../shared/project-schema/authoring-rooms';
import { defaultTestData } from '../../shared/project-schema/authoring-tests';

function roomProject() {
  const project = createAuthoringProject({ name: 'Export Demo', version: '2.0.0', author: 'NovelTea' });
  project.assets.foyer = {
    id: 'foyer',
    label: 'Foyer BG',
    tags: [],
    data: assetDataFromImportMetadata({ kind: 'image', projectRelativePath: 'assets/images/foyer.png', extension: '.png' }),
  };
  const foyer = defaultRoomData('Foyer');
  foyer.description.source = 'A quiet foyer.';
  foyer.background.asset = roomAssetRef('foyer');
  foyer.paths = [{ id: 'north', label: 'North', direction: 'north', target: roomRoomRef('kitchen'), enabled: true, condition: '', order: 0 }];
  const kitchen = defaultRoomData('Kitchen');
  kitchen.description.source = 'A bright kitchen.';
  project.rooms.foyer = { id: 'foyer', label: 'Foyer', tags: [], data: foyer };
  project.rooms.kitchen = { id: 'kitchen', label: 'Kitchen', tags: [], data: kitchen };
  project.entrypoint = { collection: 'rooms', id: 'foyer' };
  project.tests.smoke = { id: 'smoke', label: 'Smoke', tags: [], data: defaultTestData('Smoke') };
  return project;
}

describe('authoring runtime export builder', () => {
  it('builds a runtime-shaped package input from a simple room project', () => {
    const profile = { ...defaultExportProfile(), compileShadersBeforeExport: false };
    const result = buildAuthoringRuntimeExport(roomProject(), { projectRoot: '/project', profile });

    expect(result.ok).toBe(true);
    expect(result.runtimeProject).toMatchObject({
      name: 'Export Demo',
      version: '2.0.0',
      author: 'NovelTea',
      entrypoint: [3, 'foyer'],
      room: {
        foyer: expect.arrayContaining(['foyer', 'A quiet foyer.', 'Foyer']),
        kitchen: expect.arrayContaining(['kitchen', 'A bright kitchen.', 'Kitchen']),
      },
    });
    expect(result.runtimeProject).not.toHaveProperty('editor');
    expect(result.runtimeProject).not.toHaveProperty('tests');
    expect(result.fileEntries).toEqual([
      expect.objectContaining({ source: '/project/assets/images/foyer.png', packagePath: 'textures/foyer.png', assetId: 'foyer' }),
    ]);
    expect(result.packageOptions.fileEntries).toEqual([{ source: '/project/assets/images/foyer.png', packagePath: 'textures/foyer.png' }]);
    expect(result.manifestPreview).toMatchObject({ projectName: 'Export Demo', assetCount: 1 });
  });

  it('blocks unsupported entrypoints with precise diagnostics', () => {
    const project = roomProject();
    project.scenes.opening = { id: 'opening', label: 'Opening', tags: [], data: {} };
    project.entrypoint = { collection: 'scenes', id: 'opening' };
    const result = buildAuthoringRuntimeExport(project, { projectRoot: '/project', profile: defaultExportProfile(project) });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'error', path: '/entrypoint', message: expect.stringContaining('scenes') }),
      expect.objectContaining({ severity: 'warning', path: '/scenes/opening' }),
    ]));
  });
});
