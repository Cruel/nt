import { describe, expect, it } from 'vitest';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { assetDataFromImportMetadata } from '../../shared/project-schema/authoring-assets';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import {
  defaultRoomData,
  roomAssetRef,
  roomMaterialRef,
  roomInteractableRef,
  roomRoomRef,
  validateRoomData,
} from '../../shared/project-schema/authoring-rooms';
import { buildRoomPreviewDocumentData, roomPreviewRevision } from '../../shared/project-schema/room-project';

function imageAsset(path = 'assets/images/room.png', hash = 'hash-image') {
  return assetDataFromImportMetadata({
    kind: 'image',
    projectRelativePath: path,
    extension: '.png',
    byteSize: 12,
    contentHash: hash,
    importedAt: '2026-01-01T00:00:00.000Z',
    originalName: 'room.png',
    originalPath: '/tmp/room.png',
  });
}

describe('authoring rooms schema', () => {
  it('provides typed room defaults', () => {
    expect(defaultRoomData('Foyer')).toMatchObject({
      kind: 'room',
      displayName: 'Foyer',
      background: { asset: null, material: null, fit: 'cover' },
      description: { format: 'active-text', source: '' },
      scripts: { beforeEnter: '', afterEnter: '', beforeLeave: '', afterLeave: '' },
      paths: [],
      hotspots: [],
    });
  });

  it('validates room dependencies and subrecord IDs', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    const data = defaultRoomData('Foyer');
    data.background.asset = roomAssetRef('missing-bg');
    data.paths = [
      { id: 'exit', label: 'Exit', direction: 'north', target: roomRoomRef('missing-room'), enabled: true, condition: '', order: 0 },
      { id: 'exit', label: 'Duplicate', direction: 'south', target: null, enabled: true, condition: '', order: 1 },
    ];
    data.hotspots = [
      { id: 'lamp', label: 'Lamp', object: roomInteractableRef('missing-object'), bounds: { x: 0, y: 0, width: 0.1, height: 0.1 }, placeInRoom: true, description: '', script: '' },
      { id: 'lamp', label: 'Duplicate', object: null, bounds: { x: 0, y: 0, width: 0, height: 0.1 }, placeInRoom: true, description: '', script: '' },
    ];
    project.rooms.foyer.data = data;

    expect(validateRoomData(project, 'foyer', project.rooms.foyer)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/rooms/foyer/data/background/asset/$ref', severity: 'error' }),
      expect.objectContaining({ path: '/rooms/foyer/data/paths/1/id', severity: 'error' }),
      expect.objectContaining({ path: '/rooms/foyer/data/paths/0/target/$ref', severity: 'error' }),
      expect.objectContaining({ path: '/rooms/foyer/data/hotspots/1/id', severity: 'error' }),
      expect.objectContaining({ path: '/rooms/foyer/data/hotspots/0/object/$ref', severity: 'error' }),
      expect.objectContaining({ path: '/rooms/foyer/data/hotspots/1/bounds', severity: 'error' }),
    ]));
  });

  it('warns for non-image background assets and empty descriptions through project validation', () => {
    const project = createAuthoringProject();
    project.assets.theme = {
      id: 'theme',
      label: 'Theme',
            data: assetDataFromImportMetadata({
        kind: 'audio',
        projectRelativePath: 'assets/audio/theme.mp3',
        extension: '.mp3',
        byteSize: 10,
        contentHash: 'hash-audio',
        importedAt: '2026-01-01T00:00:00.000Z',
        originalName: 'theme.mp3',
        originalPath: '/tmp/theme.mp3',
      }),
    };
    const data = defaultRoomData('Foyer');
    data.background.asset = roomAssetRef('theme');
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data };

    expect(validateAuthoringProject(project)).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'authoring-rooms', path: '/rooms/foyer/data/background/asset/$ref', severity: 'warning' }),
      expect.objectContaining({ category: 'authoring-rooms', path: '/rooms/foyer/data/description/source', severity: 'warning' }),
    ]));
  });

  it('builds room preview documents with dependency revisions', () => {
    const project = createAuthoringProject();
    project.assets.foyer = { id: 'foyer', label: 'Foyer BG', data: imageAsset() };
    project.materials.glow = { id: 'glow', label: 'Glow', data: defaultMaterialData('Glow') };
    project.interactables.lamp = { id: 'lamp', label: 'Lamp', data: {} as never };
    project.rooms.hall = { id: 'hall', label: 'Hall', data: defaultRoomData('Hall') };
    const data = defaultRoomData('Foyer');
    data.description.source = 'Welcome.';
    data.background.asset = roomAssetRef('foyer');
    data.background.material = roomMaterialRef('glow');
    data.paths = [{ id: 'north', label: 'North', direction: 'north', target: roomRoomRef('hall'), enabled: true, condition: '', order: 0 }];
    data.hotspots = [{ id: 'lamp', label: 'Lamp', object: roomInteractableRef('lamp'), bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, placeInRoom: true, description: '', script: '' }];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data };

    expect(roomPreviewRevision(project, 'foyer')).toContain('hash-image');
    expect(buildRoomPreviewDocumentData(project, 'foyer')).toMatchObject({
      schema: 'noveltea.room-preview.v1',
      roomId: 'foyer',
      backgroundAsset: { id: 'foyer', kind: 'image', contentHash: 'hash-image' },
      paths: [expect.objectContaining({ targetLabel: 'Hall' })],
      hotspots: [expect.objectContaining({ objectMetadata: { id: 'lamp', label: 'Lamp' } })],
    });
  });
});
