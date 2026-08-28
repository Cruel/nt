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
import {
  authoringValidationSucceeded,
  validateAuthoringProject,
} from '../../shared/project-schema/authoring-validation';

describe('authoring V2 validation', () => {
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
    project.properties.clue = {
      id: 'clue',
      label: 'Clue',
      type: 'string',
      nullable: false,
      ownerKinds: ['room'],
    };
    project.traits.inspectable = {
      id: 'inspectable',
      label: 'Inspectable',
      ownerKinds: ['room'],
      properties: [{ kind: 'required', propertyId: 'clue' }],
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
    project.properties.mood = {
      id: 'mood',
      label: 'Mood',
      type: 'string',
      nullable: false,
      defaultValue: 'calm',
      ownerKinds: ['room'],
    };
    project.traits['room-state'] = {
      id: 'room-state',
      label: 'Room State',
      ownerKinds: ['room'],
      properties: [{ kind: 'configured', propertyId: 'mood', value: 'tense' }],
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

  it('limits Property and Trait owner kinds to stateful Gameplay Instances', () => {
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
          properties: [{ kind: 'required', propertyId: 'scene-state' }],
        },
      },
    });
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          path: '/properties/scene-state/ownerKinds/0',
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

  it('validates declared property owner kinds and assignments', () => {
    const project = createAuthoringProject();
    project.properties['visit-count'] = {
      id: 'visit-count',
      label: 'Visit count',
      type: 'integer',
      nullable: false,
      defaultValue: 0,
      ownerKinds: ['room'],
    };
    project.rooms.room = {
      id: 'room',
      label: 'Room',
      properties: { 'visit-count': 'wrong' },
      data: defaultRoomData(),
    };
    expect(validateAuthoringProject(project)).toContainEqual(
      expect.objectContaining({ path: '/rooms/room/properties/visit-count' }),
    );
  });
});
