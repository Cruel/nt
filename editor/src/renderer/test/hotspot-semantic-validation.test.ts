import { describe, expect, it } from 'vite-plus/test';
import {
  defaultInteractableData,
  defaultInteractableInstanceData,
} from '../../shared/project-schema/authoring-interactables';
import { defaultHotspotBehavior } from '../../shared/project-schema/authoring-hotspots';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';

function imageAsset(overrides: Partial<{ hasAlpha: boolean; orientation: 1 | 6 }> = {}) {
  return {
    kind: 'image' as const,
    source: { type: 'project-file' as const, path: 'assets/image.png' },
    aliases: [],
    imageMetadata: {
      width: 640,
      height: 480,
      hasAlpha: overrides.hasAlpha ?? true,
      orientation: overrides.orientation ?? 1,
    },
  };
}

function codes(project: ReturnType<typeof createAuthoringProject>) {
  return validateAuthoringProject(project)
    .map((item) => item.code)
    .filter(Boolean);
}

function primaryHotspot(item: ReturnType<typeof defaultInteractableData>) {
  if (item.presentation.hotspots.kind !== 'sprite-alpha')
    item.presentation.hotspots = {
      kind: 'sprite-alpha',
      hotspot: defaultHotspotBehavior(item.displayName),
    };
  return item.presentation.hotspots.hotspot;
}

describe('hotspot semantic validation', () => {
  it('validates geometry independently from semantic Feature and Exit targets', () => {
    const project = createAuthoringProject();
    project.assets.image = { id: 'image', label: 'Image', data: imageAsset({ hasAlpha: false }) };
    const room = defaultRoomData('Room');
    room.background.asset = { $ref: { collection: 'assets', id: 'image' } };
    room.features.push({
      id: 'door',
      label: 'Door',
      traits: [],
      localProperties: [],
      defaultProperties: [],
      inventories: [],
    });
    room.hotspots.push({
      id: 'door-region',
      label: 'Door geometry',
      condition: { kind: 'always' },
      inputOrder: 0,
      highlight: { kind: 'default' },
      shape: { kind: 'rect', bounds: { x: 0, y: 0, width: 1, height: 1 } },
      target: { kind: 'owner-feature', featureId: 'missing' },
    });
    room.hotspots.push({
      id: 'exit-region',
      label: 'Exit geometry',
      condition: { kind: 'always' },
      inputOrder: 1,
      highlight: { kind: 'none' },
      shape: { kind: 'rect', bounds: { x: 0, y: 0, width: 0.5, height: 0.5 } },
      target: { kind: 'exit', exitId: 'foreign-exit' },
    });
    project.rooms.room = { id: 'room', label: 'Room', data: room };

    const item = defaultInteractableData('Item');
    item.presentation.sprite = { $ref: { collection: 'assets', id: 'image' } };
    item.features.push({
      id: 'handle',
      label: 'Handle',
      traits: [],
      localProperties: [],
      defaultProperties: [],
      inventories: [],
    });
    primaryHotspot(item).target = { kind: 'owner-feature', featureId: 'missing' };
    project.interactables.item = { id: 'item', label: 'Item', data: item };

    expect(codes(project)).toEqual(
      expect.arrayContaining([
        'hotspot.authoring.target.feature-missing',
        'hotspot.authoring.exit.foreign',
        'hotspot.authoring.alpha.opaque-image',
      ]),
    );
  });

  it('allows multiple geometry regions to publish the same owner-qualified Feature target', () => {
    const project = createAuthoringProject();
    project.assets.image = { id: 'image', label: 'Image', data: imageAsset({ orientation: 6 }) };
    const item = defaultInteractableData('Coin');
    item.presentation.sprite = { $ref: { collection: 'assets', id: 'image' } };
    item.features.push({
      id: 'face',
      label: 'Coin Face',
      traits: [],
      localProperties: [],
      defaultProperties: [],
      inventories: [],
    });
    const primary = primaryHotspot(item);
    item.presentation.hotspots = {
      kind: 'custom',
      hotspots: [
        {
          ...primary,
          id: 'front',
          target: { kind: 'owner-feature', featureId: 'face' },
          shape: { kind: 'rect', bounds: { x: 0, y: 0, width: 1, height: 1 } },
        },
        {
          ...primary,
          id: 'center',
          target: { kind: 'owner-feature', featureId: 'face' },
          shape: { kind: 'rect', bounds: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } },
        },
      ],
    };
    project.interactables.coin = { id: 'coin', label: 'Coin', data: item };

    expect(codes(project)).not.toContain('hotspot.authoring.target.feature-missing');
    expect(codes(project)).toContain('hotspot.authoring.image-orientation');
  });

  it('validates cross-owner Feature subject targets by owner and local Feature identity', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Room');
    room.features.push({
      id: 'desk',
      label: 'Desk',
      traits: [],
      localProperties: [],
      defaultProperties: [],
      inventories: [],
    });
    room.hotspots.push({
      id: 'desk-region',
      label: 'Desk geometry',
      condition: { kind: 'always' },
      inputOrder: 0,
      highlight: { kind: 'none' },
      shape: { kind: 'rect', bounds: { x: 0, y: 0, width: 1, height: 1 } },
      target: {
        kind: 'subject',
        subject: {
          kind: 'feature',
          feature: {
            ownerKind: 'interactable',
            interactable: { $ref: { registry: 'interactableInstances', id: 'box-instance' } },
            featureId: 'lid',
          },
        },
      },
    });
    project.rooms.room = { id: 'room', label: 'Room', data: room };
    expect(codes(project)).toContain('hotspot.authoring.target.feature-owner-missing');

    const box = defaultInteractableData('Box');
    box.features.push({
      id: 'lid',
      label: 'Lid',
      traits: [],
      localProperties: [],
      defaultProperties: [],
      inventories: [],
    });
    project.interactables.box = { id: 'box', label: 'Box', data: box };
    project.interactableInstances['box-instance'] = defaultInteractableInstanceData(
      'box-instance',
      'box',
    );
    expect(codes(project)).not.toContain('hotspot.authoring.target.feature-owner-missing');
    expect(codes(project)).not.toContain('hotspot.authoring.target.feature-missing');
  });

  it('validates hotspot highlight compatibility from the authoritative Material preset contract', () => {
    const project = createAuthoringProject();
    project.assets.image = { id: 'image', label: 'Image', data: imageAsset() };
    project.materials.hotspot = {
      id: 'hotspot',
      label: 'Hotspot',
      data: defaultMaterialData('Hotspot', 'hotspot-overlay-custom'),
    };
    const item = defaultInteractableData('Item');
    item.presentation.sprite = { $ref: { collection: 'assets', id: 'image' } };
    primaryHotspot(item).highlight = {
      kind: 'material',
      material: { $ref: { collection: 'materials', id: 'hotspot' } },
    };
    project.interactables.item = { id: 'item', label: 'Item', data: item };

    expect(codes(project)).toContain('hotspot.authoring.highlight.sampler-interface');
    project.materials.hotspot.data = defaultMaterialData('Hotspot', 'hotspot-overlay-alpha');
    expect(codes(project)).not.toContain('hotspot.authoring.highlight.sampler-interface');
    expect(codes(project)).not.toContain('hotspot.authoring.highlight.uniform-interface');
    project.materials.hotspot.data = defaultMaterialData('Hotspot', 'engine-2d');
    expect(codes(project)).toContain('hotspot.authoring.highlight.material-role');
  });
});
