import { describe, expect, it } from 'vitest';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { assetDataFromImportMetadata } from '../../shared/project-schema/authoring-assets';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import {
  defaultRoomData,
  roomAssetRef,
  roomMaterialRef,

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
      description: { markup: 'active-text', source: { kind: 'inline', text: '' } },
      lifecycle: { canEnter: { kind: 'always' }, canLeave: { kind: 'always' }, beforeEnter: [], afterEnter: [], beforeLeave: [], afterLeave: [] },
      exits: [],
      placements: [],
    });
  });

  it('validates room dependencies and subrecord IDs', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    const data = defaultRoomData('Foyer');
    data.background.asset = roomAssetRef('missing-bg');
    data.exits = [
      { id: 'exit', label: 'Exit', direction: 'north', target: roomRoomRef('missing-room'), condition: { kind: 'always' }},
      { id: 'exit', label: 'Duplicate', direction: 'south', target: roomRoomRef('missing-room'), condition: { kind: 'always' }},
    ];
    data.placements = [
      { id: 'lamp', bounds: { x: 0, y: 0, width: 0.1, height: 0.1 }, presentation: { label: null, layout: null } },
      { id: 'lamp', bounds: { x: 0, y: 0, width: 0.1, height: 0.1 }, presentation: { label: null, layout: null } },
    ];
    project.rooms.foyer.data = data;

    expect(validateRoomData(project, 'foyer', project.rooms.foyer)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/rooms/foyer/data/background/asset/$ref', severity: 'error' }),
      expect.objectContaining({ path: '/rooms/foyer/data/exits/1/id', severity: 'error' }),
      expect.objectContaining({ path: '/rooms/foyer/data/exits/0/target/$ref', severity: 'error' }),
      expect.objectContaining({ path: '/rooms/foyer/data/placements/1/id', severity: 'error' }),
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
      expect.objectContaining({ category: 'Rooms', path: '/rooms/foyer/data/background/asset/$ref', severity: 'warning' }),
      expect.objectContaining({ category: 'Rooms', path: '/rooms/foyer/data/description', severity: 'warning' }),
    ]));
  });

  it('builds room preview documents with dependency revisions', () => {
    const project = createAuthoringProject();
    project.assets.foyer = { id: 'foyer', label: 'Foyer BG', data: imageAsset() };
    project.materials.glow = { id: 'glow', label: 'Glow', data: defaultMaterialData('Glow') };
    project.interactables.lamp = { id: 'lamp', label: 'Lamp', data: {} as never };
    project.rooms.hall = { id: 'hall', label: 'Hall', data: defaultRoomData('Hall') };
    const data = defaultRoomData('Foyer');
    data.description.source = { kind: 'inline', text: 'Welcome.' };
    data.background.asset = roomAssetRef('foyer');
    data.background.material = roomMaterialRef('glow');
    data.exits = [{ id: 'north', label: 'North', direction: 'north', target: roomRoomRef('hall'), condition: { kind: 'always' }}];
    data.placements = [{ id: 'lamp', bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, presentation: { label: null, layout: null } }];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data };

    expect(roomPreviewRevision(project, 'foyer')).toContain('hash-image');
    expect(buildRoomPreviewDocumentData(project, 'foyer')).toMatchObject({
      schema: 'noveltea.room-preview.v1',
      roomId: 'foyer',
      backgroundAsset: { id: 'foyer', kind: 'image', contentHash: 'hash-image' },
      exits: [expect.objectContaining({ targetLabel: 'Hall' })],
      placements: [expect.objectContaining({ id: 'lamp', bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } })],
    });
  });

  it('validates Room cast pose/expression and composition resources', () => {
    const project = createAuthoringProject();
    project.characters.guard = { id: 'guard', label: 'Guard', data: defaultCharacterData('Guard') };
    const data = defaultRoomData('Foyer');
    data.placements = [{ id: 'doorway', bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.4 }, presentation: { label: null, layout: null } }];
    data.cast = [{ id: 'guard', character: { $ref: { collection: 'characters', id: 'guard' } }, condition: { kind: 'always' }, placementId: 'doorway', poseId: 'missing-pose', expressionId: 'missing-expression', idleId: null, visible: true, order: 0 }];
    data.compose = { script: { $ref: { collection: 'scripts', id: 'missing-compose' } } };
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data };

    expect(validateRoomData(project, 'foyer', project.rooms.foyer)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/rooms/foyer/data/cast/0/poseId', severity: 'error' }),
      expect.objectContaining({ path: '/rooms/foyer/data/cast/0/expressionId', severity: 'error' }),
      expect.objectContaining({ path: '/rooms/foyer/data/compose/script/$ref', severity: 'error' }),
    ]));
  });
});
