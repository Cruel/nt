import { describe, expect, it } from 'vite-plus/test';
import { defaultInteractableData } from '../../shared/project-schema/authoring-interactables';
import { defaultInteractionData } from '../../shared/project-schema/authoring-interactions';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultShaderData } from '../../shared/project-schema/authoring-shaders';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import { defaultVerbData } from '../../shared/project-schema/authoring-verbs';

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
  expect(item.presentation.hotspots.kind).toBe('sprite-alpha');
  if (item.presentation.hotspots.kind !== 'sprite-alpha') throw new Error('Expected sprite alpha');
  return item.presentation.hotspots.hotspot;
}

describe('hotspot Phase 2 semantic validation', () => {
  it('validates IDs, source images, orientation, alpha behavior, exits, and Verb arity', () => {
    const project = createAuthoringProject();
    project.assets.image = { id: 'image', label: 'Image', data: imageAsset({ hasAlpha: false }) };
    const roomVerb = defaultVerbData('Open');
    roomVerb.arity = 1;
    roomVerb.operandRoles = ['target'];
    project.verbs.open = { id: 'open', label: 'Open', data: roomVerb };
    const room = defaultRoomData('Room');
    room.background.asset = { $ref: { collection: 'assets', id: 'image' } };
    room.hotspots.push({
      id: 'door',
      label: 'Door',
      condition: { kind: 'always' },
      inputOrder: 0,
      highlight: { kind: 'default' },
      shape: { kind: 'rect', bounds: { x: 0, y: 0, width: 1, height: 1 } },
      activation: { kind: 'exit', exitId: 'foreign-exit' },
    });
    project.rooms.room = { id: 'room', label: 'Room', data: room };

    const item = defaultInteractableData('Item');
    item.presentation.sprite = { $ref: { collection: 'assets', id: 'image' } };
    const primary = primaryHotspot(item);
    primary.activation.verb = {
      $ref: { collection: 'verbs', id: 'open' },
    };
    project.interactables.item = { id: 'item', label: 'Item', data: item };

    expect(codes(project)).toEqual(
      expect.arrayContaining([
        'hotspot.authoring.exit.foreign',
        'hotspot.authoring.alpha.opaque-image',
      ]),
    );
    expect(codes(project)).not.toContain('hotspot.authoring.verb.arity');

    project.assets.image.data = imageAsset({ orientation: 6 });
    item.presentation.hotspots = {
      kind: 'custom',
      hotspots: [
        {
          ...primary,
          id: 'same',
          activation: { kind: 'verb', verb: { $ref: { collection: 'verbs', id: 'open' } } },
          shape: { kind: 'rect', bounds: { x: 0, y: 0, width: 1, height: 1 } },
        },
        {
          ...primary,
          id: 'same',
          activation: { kind: 'verb', verb: { $ref: { collection: 'verbs', id: 'open' } } },
          shape: { kind: 'rect', bounds: { x: 0, y: 0, width: 1, height: 1 } },
        },
      ],
    };
    expect(codes(project)).toEqual(
      expect.arrayContaining([
        'hotspot.authoring.id.duplicate',
        'hotspot.authoring.image-orientation',
      ]),
    );
  });

  it('validates highlight Material role and exact hotspot Shader interfaces', () => {
    const project = createAuthoringProject();
    project.assets.image = { id: 'image', label: 'Image', data: imageAsset() };
    const verb = defaultVerbData('Use');
    verb.arity = 1;
    verb.operandRoles = ['target'];
    project.verbs.use = { id: 'use', label: 'Use', data: verb };
    project.shaders.hotspot = { id: 'hotspot', label: 'Hotspot', data: hotspotShader() };
    const material = defaultMaterialData('Hotspot');
    material.role = 'hotspot-overlay';
    material.shader = { $ref: { collection: 'shaders', id: 'hotspot' } };
    project.materials.hotspot = { id: 'hotspot', label: 'Hotspot', data: material };
    const item = defaultInteractableData('Item');
    item.presentation.sprite = { $ref: { collection: 'assets', id: 'image' } };
    const primary = primaryHotspot(item);
    primary.activation.verb = {
      $ref: { collection: 'verbs', id: 'use' },
    };
    primary.highlight = {
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

  it('validates exact hotspot owner, identity, Verb, and operand compatibility', () => {
    const project = createAuthoringProject();
    project.assets.image = { id: 'image', label: 'Image', data: imageAsset() };
    const use = defaultVerbData('Use');
    use.arity = 1;
    use.operandRoles = ['target'];
    project.verbs.use = { id: 'use', label: 'Use', data: use };
    const item = defaultInteractableData('Item');
    item.presentation.sprite = { $ref: { collection: 'assets', id: 'image' } };
    primaryHotspot(item).activation.verb = {
      $ref: { collection: 'verbs', id: 'use' },
    };
    project.interactables.item = { id: 'item', label: 'Item', data: item };
    const interaction = defaultInteractionData();
    interaction.rules.push({
      id: 'rule',
      verb: { $ref: { collection: 'verbs', id: 'use' } },
      operands: [{ kind: 'any-character' }],
      context: {
        kind: 'hotspot',
        hotspot: {
          kind: 'interactable-hotspot',
          interactable: { $ref: { collection: 'interactables', id: 'item' } },
          hotspotId: 'primary',
        },
      },
      program: { instructions: [], completion: { kind: 'end' }, outcome: 'handled' },
    });
    project.interactions.actions = { id: 'actions', label: 'Actions', data: interaction };

    const messages = validateAuthoringProject(project).map((item) => item.message);
    expect(messages).toContain(
      "Interactable hotspot rules require exactly one compatible operand for 'item'.",
    );
    interaction.rules[0]!.context = {
      kind: 'hotspot',
      hotspot: {
        kind: 'interactable-hotspot',
        interactable: { $ref: { collection: 'interactables', id: 'item' } },
        hotspotId: 'missing',
      },
    };
    expect(validateAuthoringProject(project).map((item) => item.message)).toContain(
      "Missing Interactable hotspot 'missing'.",
    );
  });
});
