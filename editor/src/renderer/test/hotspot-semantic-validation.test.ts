import { describe, expect, it } from 'vite-plus/test';
import { defaultInteractableData } from '../../shared/project-schema/authoring-interactables';
import { defaultHotspotBehavior } from '../../shared/project-schema/authoring-hotspots';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultShaderData } from '../../shared/project-schema/authoring-shaders';
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

function hotspotShader() {
  const shader = defaultShaderData('Hotspot');
  shader.roles = ['hotspot-overlay'];
  shader.uniforms = [
    { name: 'u_bounds', type: 'vec4', binding: 'engine.hotspot_bounds' },
    { name: 'u_hovered', type: 'bool', binding: 'engine.hotspot_hovered' },
    { name: 'u_pressed', type: 'bool', binding: 'engine.hotspot_pressed' },
    { name: 'u_image_size', type: 'vec2', binding: 'engine.hotspot_image_dimensions' },
    { name: 'u_mask_size', type: 'vec2', binding: 'engine.hotspot_mask_dimensions' },
  ];
  shader.samplers = [
    { name: 's_image', type: 'texture2d', binding: 'engine.hotspot_image' },
    { name: 's_mask', type: 'texture2d', binding: 'engine.hotspot_mask' },
  ];
  return shader;
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
    room.features.push({ id: 'door', label: 'Door', traits: [], properties: {}, inventories: [] });
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
      properties: {},
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
      properties: {},
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
    room.features.push({ id: 'desk', label: 'Desk', traits: [], properties: {}, inventories: [] });
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
            interactable: { $ref: { collection: 'interactables', id: 'box' } },
            featureId: 'lid',
          },
        },
      },
    });
    project.rooms.room = { id: 'room', label: 'Room', data: room };
    expect(codes(project)).toContain('hotspot.authoring.target.feature-owner-missing');

    const box = defaultInteractableData('Box');
    box.features.push({ id: 'lid', label: 'Lid', traits: [], properties: {}, inventories: [] });
    project.interactables.box = { id: 'box', label: 'Box', data: box };
    expect(codes(project)).not.toContain('hotspot.authoring.target.feature-owner-missing');
    expect(codes(project)).not.toContain('hotspot.authoring.target.feature-missing');
  });

  it('validates highlight Material role and exact hotspot Shader interfaces', () => {
    const project = createAuthoringProject();
    project.assets.image = { id: 'image', label: 'Image', data: imageAsset() };
    project.shaders.hotspot = { id: 'hotspot', label: 'Hotspot', data: hotspotShader() };
    const material = defaultMaterialData('Hotspot');
    material.role = 'hotspot-overlay';
    material.shader = { $ref: { collection: 'shaders', id: 'hotspot' } };
    project.materials.hotspot = { id: 'hotspot', label: 'Hotspot', data: material };
    const item = defaultInteractableData('Item');
    item.presentation.sprite = { $ref: { collection: 'assets', id: 'image' } };
    primaryHotspot(item).highlight = {
      kind: 'material',
      material: { $ref: { collection: 'materials', id: 'hotspot' } },
    };
    project.interactables.item = { id: 'item', label: 'Item', data: item };

    expect(codes(project)).toContain('hotspot.authoring.highlight.sampler-interface');
    project.shaders.hotspot.data.samplers = project.shaders.hotspot.data.samplers.filter(
      (sampler) => sampler.binding !== 'engine.hotspot_mask',
    );
    expect(codes(project)).not.toContain('hotspot.authoring.highlight.sampler-interface');
    project.shaders.hotspot.data.uniforms = project.shaders.hotspot.data.uniforms.filter(
      (uniform) => uniform.binding !== 'engine.hotspot_pressed',
    );
    expect(codes(project)).toContain('hotspot.authoring.highlight.uniform-interface');
    project.materials.hotspot.data.role = 'engine-2d';
    expect(codes(project)).toContain('hotspot.authoring.highlight.material-role');
  });
});
