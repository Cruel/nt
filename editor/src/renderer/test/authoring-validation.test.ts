import { describe, expect, it } from 'vite-plus/test';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import {
  defaultInteractableData,
  defaultInteractableInstanceData,
} from '../../shared/project-schema/authoring-interactables';
import { defaultHotspotBehavior } from '../../shared/project-schema/authoring-hotspots';
import { validateHotspotAuthoringSemantics } from '../../shared/project-schema/authoring-hotspot-validation';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultArchetypeData } from '../../shared/project-schema/authoring-archetypes';
import { defaultSceneData } from '../../shared/project-schema/authoring-scenes';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { effectiveInteractableInstanceProperties } from '../../shared/project-schema/authoring-interactable-properties';
import {
  authoringValidationSucceeded,
  validateAuthoringProject,
} from '../../shared/project-schema/authoring-validation';

describe('authoring validation', () => {
  it('allows incomplete reusable Interactable Property contracts but requires concrete Instance Values', () => {
    const project = createAuthoringProject();
    project.interactables.key = {
      id: 'key',
      label: 'Key',
      defaultProperties: [
        { id: 'quality', type: 'string', nullable: false },
        { id: 'weight', type: 'number', nullable: false, defaultValue: 1.5 },
      ],
      data: defaultInteractableData('Key'),
    };

    expect(validateAuthoringProject(project)).not.toContainEqual(
      expect.objectContaining({ code: 'authoring.interactable.missing_property_value' }),
    );

    project.interactableInstances.key = defaultInteractableInstanceData('key', 'key');
    expect(validateAuthoringProject(project)).toContainEqual(
      expect.objectContaining({
        code: 'authoring.interactable.missing_property_value',
        path: '/interactableInstances/key/localProperties',
        message: expect.stringContaining("requires Property 'quality'"),
        ownerPaths: ['/interactables/key'],
        navigation: {
          kind: 'interactable-instance-property',
          instanceId: 'key',
          propertyId: 'quality',
        },
      }),
    );

    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    project.interactableInstances.key.location = {
      kind: 'room',
      room: { $ref: { collection: 'rooms', id: 'foyer' } },
    };
    expect(validateAuthoringProject(project)).toContainEqual(
      expect.objectContaining({
        code: 'authoring.interactable.missing_property_value',
        ownerPaths: ['/rooms/foyer'],
      }),
    );

    project.interactableInstances.key.localProperties.push({
      id: 'quality',
      type: 'string',
      nullable: false,
      value: 'polished',
    });
    expect(validateAuthoringProject(project)).not.toContainEqual(
      expect.objectContaining({ code: 'authoring.interactable.missing_property_value' }),
    );
  });

  it('keeps one missing-Value diagnostic per effective Interactable Instance Property', () => {
    const project = createAuthoringProject();
    project.interactables.key = {
      id: 'key',
      label: 'Key',
      defaultProperties: [
        { id: 'quality', type: 'string', nullable: false },
        { id: 'condition', type: 'string', nullable: false },
      ],
      data: defaultInteractableData('Key'),
    };
    project.interactableInstances.key = defaultInteractableInstanceData('key', 'key');

    const missing = validateAuthoringProject(project).filter(
      (item) => item.code === 'authoring.interactable.missing_property_value',
    );
    expect(missing).toHaveLength(2);
    expect(missing.map((item) => item.navigation)).toEqual([
      { kind: 'interactable-instance-property', instanceId: 'key', propertyId: 'condition' },
      { kind: 'interactable-instance-property', instanceId: 'key', propertyId: 'quality' },
    ]);
  });

  it('resolves exact Interactable Instance Properties by specificity and preserves local order', () => {
    const project = createAuthoringProject();
    project.traits.inspectable = {
      id: 'inspectable',
      label: 'Inspectable',
      ownerKinds: ['interactable'],
      properties: [
        {
          id: 'quality',
          type: 'string',
          nullable: false,
          defaultValue: 'trait',
        },
      ],
    };
    project.interactables.key = {
      id: 'key',
      label: 'Key',
      traits: ['inspectable'],
      defaultProperties: [
        {
          id: 'quality',
          type: 'string',
          nullable: false,
          defaultValue: 'definition',
        },
      ],
      data: defaultInteractableData('Key'),
    };
    const instance = defaultInteractableInstanceData('key', 'key');
    instance.localProperties.push(
      { id: 'quality', type: 'string', nullable: false, value: 'instance' },
      { id: 'first-local', type: 'boolean', nullable: false, value: true },
      { id: 'second-local', type: 'integer', nullable: false, value: 2 },
    );

    expect(effectiveInteractableInstanceProperties(project, instance)).toMatchObject([
      { id: 'quality', defaultValue: 'definition', value: 'instance', localOnly: false },
      { id: 'first-local', value: true, localOnly: true },
      { id: 'second-local', value: 2, localOnly: true },
    ]);

    instance.localProperties = instance.localProperties.filter(
      (property) => property.id !== 'quality',
    );
    expect(effectiveInteractableInstanceProperties(project, instance)[0]).toMatchObject({
      id: 'quality',
      value: 'definition',
    });

    project.interactables.key.defaultProperties![0] = {
      id: 'quality',
      type: 'string',
      nullable: false,
    };
    expect(effectiveInteractableInstanceProperties(project, instance)[0]).toMatchObject({
      id: 'quality',
      value: 'trait',
    });
  });

  it('removes Trait-only Property contributions when an exact Interactable Instance removes the Trait', () => {
    const project = createAuthoringProject();
    project.traits.inspectable = {
      id: 'inspectable',
      label: 'Inspectable',
      ownerKinds: ['interactable'],
      properties: [
        {
          id: 'examined',
          type: 'boolean',
          nullable: false,
          defaultValue: false,
        },
      ],
    };
    project.interactables.key = {
      id: 'key',
      label: 'Key',
      traits: ['inspectable'],
      data: defaultInteractableData('Key'),
    };
    const instance = defaultInteractableInstanceData('key', 'key');
    expect(effectiveInteractableInstanceProperties(project, instance).map((row) => row.id)).toEqual(
      ['examined'],
    );

    instance.traits.remove.push('inspectable');
    expect(effectiveInteractableInstanceProperties(project, instance)).toEqual([]);
  });

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

  it('keeps a new Interactable non-clickable until hotspot presentation is configured', () => {
    const project = createAuthoringProject();
    const data = defaultInteractableData('Key');
    project.interactables.key = { id: 'key', label: 'Key', data };

    expect(data.presentation.hotspots).toEqual({ kind: 'none' });
    expect(validateHotspotAuthoringSemantics(project)).not.toContainEqual(
      expect.objectContaining({ code: 'hotspot.authoring.source-image-required' }),
    );

    data.presentation.hotspots = {
      kind: 'sprite-alpha',
      hotspot: defaultHotspotBehavior('Key'),
    };
    expect(validateHotspotAuthoringSemantics(project)).toContainEqual(
      expect.objectContaining({
        code: 'hotspot.authoring.source-image-required',
        severity: 'error',
        path: '/interactables/key/data/presentation/hotspots/kind',
        message: expect.stringContaining('Alpha hotspot mode requires a sprite image'),
      }),
    );

    data.presentation.hotspots = { kind: 'custom', hotspots: [] };
    expect(validateHotspotAuthoringSemantics(project)).not.toContainEqual(
      expect.objectContaining({ code: 'hotspot.authoring.source-image-required' }),
    );
    data.presentation.hotspots = {
      kind: 'custom',
      hotspots: [
        {
          ...defaultHotspotBehavior('Key'),
          shape: { kind: 'rect', bounds: { x: 0, y: 0, width: 1, height: 1 } },
        },
      ],
    };
    expect(validateHotspotAuthoringSemantics(project)).toContainEqual(
      expect.objectContaining({
        code: 'hotspot.authoring.source-image-required',
        severity: 'error',
        path: '/interactables/key/data/presentation/hotspots/kind',
        message: expect.stringContaining('Custom hotspots require a sprite image'),
      }),
    );
  });

  it('warns when a visible Room Interactable has no sprite', () => {
    const project = createAuthoringProject();
    project.interactables.key = {
      id: 'key',
      label: 'Key',
      data: defaultInteractableData('Key'),
    };
    project.interactableInstances['key-instance'] = defaultInteractableInstanceData(
      'key-instance',
      'key',
      { kind: 'room', room: { $ref: { collection: 'rooms', id: 'start' } } },
    );
    const room = defaultRoomData('Start');
    room.placements.push({
      id: 'key-placement',
      bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      presentation: { label: null, layout: null },
    });
    room.interactables.push({
      id: 'key-instance',
      interactable: { $ref: { registry: 'interactableInstances', id: 'key-instance' } },
      condition: { kind: 'always' },
      placementId: 'key-placement',
      visible: true,
      order: 0,
    });
    project.rooms.start = { id: 'start', label: 'Start', data: room };

    expect(validateAuthoringProject(project)).toContainEqual(
      expect.objectContaining({
        code: 'room.interactable.sprite-missing',
        severity: 'warning',
        path: '/rooms/start/data/interactables/0/interactable/$ref',
        message: expect.stringContaining("Visible Interactable 'key-instance' has no sprite"),
      }),
    );

    room.interactables[0]!.visible = false;
    expect(validateAuthoringProject(project)).not.toContainEqual(
      expect.objectContaining({ code: 'room.interactable.sprite-missing' }),
    );

    room.interactables[0]!.visible = true;
    project.assets.sprite = {
      id: 'sprite',
      label: 'Sprite',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/sprite.png' },
        aliases: [],
        sampling: 'linear',
        byteSize: 1,
        contentHash: `sha256:${'a'.repeat(64)}`,
        imageMetadata: { width: 1, height: 1, hasAlpha: true, orientation: 1 },
      },
    };
    project.archetypes['sprite-prop'] = {
      id: 'sprite-prop',
      label: 'Sprite Prop',
      data: {
        ...defaultArchetypeData('interactable'),
        overrides: {
          '/data/presentation/sprite': { $ref: { collection: 'assets', id: 'sprite' } },
        },
      },
    };
    project.interactables.key!.archetype = {
      $ref: { collection: 'archetypes', id: 'sprite-prop' },
    };
    project.interactables.key!.archetypeOverrides = {};
    expect(validateAuthoringProject(project)).not.toContainEqual(
      expect.objectContaining({ code: 'room.interactable.sprite-missing' }),
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

  it('reports missing entrypoints and unsatisfied Trait Property requirements', () => {
    const project = createAuthoringProject();
    project.entrypoint = { kind: 'room', id: 'missing-room' };
    project.traits.inspectable = {
      id: 'inspectable',
      label: 'Inspectable',
      ownerKinds: ['room'],
      properties: [{ id: 'clue', type: 'string', nullable: false }],
    };
    project.rooms.a = {
      id: 'a',
      label: 'A',
      traits: ['inspectable'],
      data: defaultRoomData('A'),
    };
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
          severity: 'error',
          path: '/rooms/a/traits',
          message: expect.stringContaining("Trait 'inspectable' requires property 'clue'"),
        }),
      ]),
    );
  });

  it('rejects missing and owner-incompatible Trait attachments', () => {
    const project = createAuthoringProject();
    project.traits['room-state'] = {
      id: 'room-state',
      label: 'Room State',
      ownerKinds: ['room'],
      properties: [{ id: 'mood', type: 'string', nullable: false, defaultValue: 'tense' }],
    };
    project.rooms.a = {
      id: 'a',
      label: 'A',
      traits: ['missing-trait'],
      data: defaultRoomData('A'),
    };
    project.characters.person = {
      id: 'person',
      label: 'Person',
      traits: ['room-state'],
      data: defaultCharacterData('Person'),
    };
    const diagnostics = validateAuthoringProject(project);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/rooms/a/traits/0',
          message: "Trait 'missing-trait' is not declared.",
        }),
        expect.objectContaining({
          path: '/characters/person/traits/0',
          message: "Trait 'room-state' cannot be attached to character.",
        }),
      ]),
    );
  });

  it('accepts empty Traits and concrete owner Values for required Trait Properties', () => {
    const project = createAuthoringProject();
    project.traits.marker = {
      id: 'marker',
      label: 'Marker',
      ownerKinds: ['room'],
      properties: [],
    };
    project.traits.inspectable = {
      id: 'inspectable',
      label: 'Inspectable',
      ownerKinds: ['room'],
      properties: [{ id: 'clue', type: 'string', nullable: false }],
    };
    project.rooms.a = {
      id: 'a',
      label: 'A',
      traits: ['marker', 'inspectable'],
      localProperties: [
        {
          id: 'clue',
          type: 'string',
          nullable: false,
          value: 'portrait',
        },
      ],
      data: defaultRoomData('A'),
    };

    expect(validateAuthoringProject(project)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('requires property') }),
      ]),
    );
  });

  it('rejects incompatible same-key Trait schemas and conflicting Defaults', () => {
    const project = createAuthoringProject();
    project.traits.first = {
      id: 'first',
      label: 'First',
      ownerKinds: ['room'],
      properties: [
        {
          id: 'mood',
          type: 'enum',
          nullable: false,
          enumValues: ['calm', 'tense'],
          defaultValue: 'calm',
        },
        { id: 'light', type: 'number', nullable: false, defaultValue: 0.5 },
      ],
    };
    project.traits.second = {
      id: 'second',
      label: 'Second',
      ownerKinds: ['room'],
      properties: [
        {
          id: 'mood',
          label: 'Different display label is irrelevant',
          type: 'enum',
          nullable: false,
          enumValues: ['tense', 'calm'],
          defaultValue: 'calm',
        },
        { id: 'light', type: 'number', nullable: false, defaultValue: 0.75 },
      ],
    };
    project.rooms.a = {
      id: 'a',
      label: 'A',
      traits: ['first', 'second'],
      data: defaultRoomData('A'),
    };

    const diagnostics = validateAuthoringProject(project);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/rooms/a/traits/1',
          message: expect.stringContaining("property 'mood' with a schema incompatible"),
        }),
        expect.objectContaining({
          path: '/rooms/a/traits/1',
          message: expect.stringContaining("conflicting Default for property 'light'"),
        }),
      ]),
    );
  });

  it('allows compatible same-key Trait schemas when Defaults match exactly', () => {
    const project = createAuthoringProject();
    for (const traitId of ['first', 'second']) {
      project.traits[traitId] = {
        id: traitId,
        label: traitId,
        ownerKinds: ['room'],
        properties: [
          {
            id: 'mood',
            label: traitId === 'first' ? 'Mood' : 'Room Mood',
            description: traitId,
            type: 'enum',
            nullable: false,
            enumValues: ['calm', 'tense'],
            defaultValue: 'calm',
          },
        ],
      };
    }
    project.rooms.a = {
      id: 'a',
      label: 'A',
      traits: ['first', 'second'],
      data: defaultRoomData('A'),
    };

    const diagnostics = validateAuthoringProject(project);
    expect(diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('incompatible') }),
      ]),
    );
    expect(diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('conflicting Default') }),
      ]),
    );
  });

  it('lets one compatible Trait Default satisfy another Trait requirement on concrete owners and Features', () => {
    const project = createAuthoringProject();
    project.traits.required = {
      id: 'required',
      label: 'Required',
      ownerKinds: ['room', 'feature'],
      properties: [{ id: 'state', type: 'string', nullable: false }],
    };
    project.traits.configured = {
      id: 'configured',
      label: 'Configured',
      ownerKinds: ['room', 'feature'],
      properties: [{ id: 'state', type: 'string', nullable: false, defaultValue: 'ready' }],
    };
    const roomData = defaultRoomData('Room');
    roomData.features.push({
      id: 'feature',
      label: 'Feature',
      traits: ['required', 'configured'],
      localProperties: [],
      defaultProperties: [],
      inventories: [],
    });
    project.rooms.room = {
      id: 'room',
      label: 'Room',
      traits: ['required', 'configured'],
      data: roomData,
    };

    const diagnostics = validateAuthoringProject(project);
    expect(diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("requires property 'state'") }),
      ]),
    );
  });

  it('allows reusable Room Archetype Features to remain incomplete but blocks the concrete Room', () => {
    const project = createAuthoringProject();
    project.traits.configurable = {
      id: 'configurable',
      label: 'Configurable',
      ownerKinds: ['feature'],
      properties: [{ id: 'state', type: 'string', nullable: false }],
    };
    project.archetypes.base = {
      id: 'base',
      label: 'Base Room',
      data: {
        ...defaultArchetypeData('room'),
        overrides: {
          '/data/features': [
            {
              id: 'feature',
              label: 'Feature',
              traits: ['configurable'],
              localProperties: [],
              defaultProperties: [],
              inventories: [],
            },
          ],
        },
      },
    };

    expect(validateAuthoringProject(project)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringContaining('/archetypes/base/'),
          message: expect.stringContaining("requires property 'state'"),
        }),
      ]),
    );

    project.rooms.room = {
      id: 'room',
      label: 'Room',
      archetype: { $ref: { collection: 'archetypes', id: 'base' } },
      archetypeOverrides: {},
      data: defaultRoomData('Room'),
    };
    expect(validateAuthoringProject(project)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/rooms/room/data/features/0/traits',
          message: expect.stringContaining("requires property 'state'"),
        }),
      ]),
    );
  });

  it('rejects the obsolete top-level Property registry and invalid Trait owner kinds', () => {
    const project = createAuthoringProject();
    const diagnostics = validateAuthoringProject({
      ...project,
      properties: {
        'scene-state': {
          id: 'scene-state',
          label: 'Scene state',
          type: 'string',
          nullable: false,
          ownerKinds: ['scene'],
        },
      },
      traits: {
        'scene-trait': {
          id: 'scene-trait',
          label: 'Scene Trait',
          ownerKinds: ['scene'],
          properties: [{ id: 'scene-state', type: 'string', nullable: false }],
        },
      },
    });
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          message: expect.stringContaining('properties'),
        }),
        expect.objectContaining({ severity: 'error', path: '/traits/scene-trait/ownerKinds/0' }),
      ]),
    );
  });

  it('rejects Property and Trait fields on immutable program definitions', () => {
    const project = createAuthoringProject();
    const diagnostics = validateAuthoringProject({
      ...project,
      scenes: {
        opening: {
          id: 'opening',
          label: 'Opening',
          traits: [],
          properties: {},
          data: defaultSceneData('Opening'),
        },
      },
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'error', path: '/scenes/opening' }),
    );
  });

  it('validates owner-local Property schemas and Values', () => {
    const project = createAuthoringProject();
    project.rooms.room = {
      id: 'room',
      label: 'Room',
      localProperties: [
        {
          id: 'visit-count',
          label: 'Visit count',
          type: 'integer',
          nullable: false,
          value: 'wrong',
        },
      ],
      data: defaultRoomData(),
    };
    expect(validateAuthoringProject(project)).toContainEqual(
      expect.objectContaining({ path: '/rooms/room/localProperties/0/value' }),
    );
  });

  it('allows incomplete reusable Feature contracts but rejects them on an exact Interactable Instance', () => {
    const project = createAuthoringProject();
    project.traits['inspectable-feature'] = {
      id: 'inspectable-feature',
      label: 'Inspectable Feature',
      ownerKinds: ['feature'],
      properties: [{ id: 'clue', type: 'string', nullable: false }],
    };
    const data = defaultInteractableData('Cabinet');
    data.features.push({
      id: 'drawer',
      label: 'Drawer',
      traits: ['inspectable-feature'],
      localProperties: [],
      defaultProperties: [],
      inventories: [],
    });
    project.interactables.cabinet = {
      id: 'cabinet',
      label: 'Cabinet',
      traits: [],
      defaultProperties: [],
      data,
    };

    expect(validateAuthoringProject(project)).not.toContainEqual(
      expect.objectContaining({ code: 'authoring.interactable.feature.missing_property_value' }),
    );

    project.interactableInstances.cabinet = defaultInteractableInstanceData('cabinet', 'cabinet');
    expect(validateAuthoringProject(project)).toContainEqual(
      expect.objectContaining({
        code: 'authoring.interactable.feature.missing_property_value',
        message: expect.stringContaining("Feature 'drawer' Property 'clue'"),
      }),
    );

    data.features[0]!.defaultProperties.push({
      id: 'clue',
      type: 'string',
      nullable: false,
      defaultValue: 'scratch marks',
    });
    expect(validateAuthoringProject(project)).not.toContainEqual(
      expect.objectContaining({ code: 'authoring.interactable.feature.missing_property_value' }),
    );
  });
});
