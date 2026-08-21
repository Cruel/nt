import { describe, expect, it } from 'vite-plus/test';
import { applyJsonPatch } from '@/project/json-patch';
import { toJsonValue } from '@/project/json-value';
import {
  clearGameplayInstanceArchetypeOverridesPatches,
  setGameplayInstanceArchetypePatches,
} from '@/project/archetype-operations';
import { renameHotspot, setInteractableHotspotMode } from '@/project/hotspot-operations';
import { setRoomPlacementBoundsPatches } from '@/project/room-placement-operations';
import { lowerSharedAuthoringProject } from '../../shared/authoring-compiler-shared-lowering';
import {
  buildCharacterPreviewDocumentData,
  characterPreviewRevision,
} from '../../shared/project-schema/character-project';
import {
  defaultArchetypeData,
  resolveArchetypeConfiguration,
  resolveGameplayInstanceRecord,
  type ArchetypeData,
  type GameplayInstanceKind,
} from '../../shared/project-schema/authoring-archetypes';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import { defaultInteractableData } from '../../shared/project-schema/authoring-interactables';
import {
  authoringProjectSchema,
  createAuthoringProject,
  type AuthoringProject,
} from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { buildReferenceIndex, findUsages } from '../../shared/project-schema/authoring-references';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';

function addArchetype(
  project: AuthoringProject,
  id: string,
  instanceKind: GameplayInstanceKind,
  options: { base?: string; overrides?: ArchetypeData['overrides'] } = {},
) {
  const data: ArchetypeData = {
    ...defaultArchetypeData(instanceKind),
    base: options.base ? { $ref: { collection: 'archetypes', id: options.base } } : null,
    overrides: options.overrides ?? {},
  };
  project.archetypes[id] = { id, label: id, data };
}

function parsedProject(value: unknown): AuthoringProject {
  return authoringProjectSchema.parse(value);
}

function applyResult(
  project: AuthoringProject,
  patches: ReturnType<typeof setGameplayInstanceArchetypePatches>['patches'],
) {
  return parsedProject(applyJsonPatch(toJsonValue(project), patches).document);
}

describe('Archetype authoring semantics', () => {
  it('resolves one same-kind Archetype chain and overlays only explicit instance overrides', () => {
    const project = createAuthoringProject();
    addArchetype(project, 'room-base', 'room', {
      overrides: {
        '/data/displayName': 'Inherited Room',
        '/data/background/fit': 'contain',
      },
    });
    addArchetype(project, 'room-child', 'room', {
      base: 'room-base',
      overrides: { '/data/background/color': '#102030' },
    });
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Stale local snapshot'),
      archetype: { $ref: { collection: 'archetypes', id: 'room-child' } },
      archetypeOverrides: { '/data/displayName': 'Authored Foyer' },
      traits: [],
      properties: {},
    };

    const archetype = resolveArchetypeConfiguration(project, 'room-child');
    const effective = resolveGameplayInstanceRecord(project, 'room', project.rooms.foyer!);

    expect(archetype?.data).toMatchObject({
      displayName: 'Inherited Room',
      background: { fit: 'contain', color: '#102030' },
    });
    expect(effective?.data).toMatchObject({
      displayName: 'Authored Foyer',
      background: { fit: 'contain', color: '#102030' },
    });
  });

  it('keeps Character Location/state and Interactable initial state independent from Archetypes', () => {
    const project = createAuthoringProject();
    addArchetype(project, 'hero-base', 'character', {
      overrides: { '/data/displayName': 'Inherited Hero' },
    });
    addArchetype(project, 'prop-base', 'interactable', {
      overrides: { '/data/displayName': 'Inherited Prop' },
    });
    const character = defaultCharacterData('Local Hero');
    character.initialWorldState = {
      location: { kind: 'room-placement', placement: { room: 'foyer', placement: 'hero-slot' } },
      enabled: false,
      visible: false,
    };
    project.characters.hero = {
      id: 'hero',
      label: 'Hero',
      data: character,
      archetype: { $ref: { collection: 'archetypes', id: 'hero-base' } },
      archetypeOverrides: {},
      traits: [],
      properties: {},
    };
    const interactable = defaultInteractableData('Local Prop');
    interactable.initialState = { enabled: false, visible: false };
    project.interactables.prop = {
      id: 'prop',
      label: 'Prop',
      data: interactable,
      archetype: { $ref: { collection: 'archetypes', id: 'prop-base' } },
      archetypeOverrides: {},
      traits: [],
      properties: {},
    };

    const effectiveCharacter = resolveGameplayInstanceRecord(
      project,
      'character',
      project.characters.hero!,
    );
    const effectiveInteractable = resolveGameplayInstanceRecord(
      project,
      'interactable',
      project.interactables.prop!,
    );

    expect(effectiveCharacter?.data).toMatchObject({
      displayName: 'Inherited Hero',
      initialWorldState: character.initialWorldState,
    });
    expect(effectiveInteractable?.data).toMatchObject({
      displayName: 'Inherited Prop',
      initialState: interactable.initialState,
    });
  });

  it('rejects cycles, cross-kind bases/attachments, multiple-base shapes, and state override paths', () => {
    const cyclic = createAuthoringProject();
    addArchetype(cyclic, 'one', 'room', { base: 'two' });
    addArchetype(cyclic, 'two', 'room', { base: 'one' });
    expect(validateAuthoringProject(cyclic).some((item) => item.message.includes('cyclic'))).toBe(
      true,
    );

    const crossKindBase = createAuthoringProject();
    addArchetype(crossKindBase, 'room-base', 'room');
    addArchetype(crossKindBase, 'character-child', 'character', { base: 'room-base' });
    expect(
      validateAuthoringProject(crossKindBase).some((item) =>
        item.message.includes('same gameplay-instance kind'),
      ),
    ).toBe(true);

    const crossKindAttachment = createAuthoringProject();
    addArchetype(crossKindAttachment, 'character-base', 'character');
    crossKindAttachment.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
      archetype: { $ref: { collection: 'archetypes', id: 'character-base' } },
      archetypeOverrides: {},
      traits: [],
      properties: {},
    };
    expect(
      validateAuthoringProject(crossKindAttachment).some((item) =>
        item.message.includes('not a room Archetype'),
      ),
    ).toBe(true);

    const invalidState = createAuthoringProject();
    addArchetype(invalidState, 'hero-base', 'character', {
      overrides: { '/data/initialWorldState/enabled': false },
    });
    expect(resolveArchetypeConfiguration(invalidState, 'hero-base')).toBeNull();
    expect(
      validateAuthoringProject(invalidState).some((item) =>
        item.message.includes('cannot be inherited by a character Archetype'),
      ),
    ).toBe(true);

    const invalidMultipleBase = createAuthoringProject() as unknown as Record<string, unknown>;
    const archetypes = (invalidMultipleBase.archetypes ?? {}) as Record<string, unknown>;
    archetypes.invalid = {
      id: 'invalid',
      label: 'Invalid',
      data: {
        kind: 'archetype',
        instanceKind: 'room',
        base: null,
        bases: [],
        overrides: {},
      },
    };
    invalidMultipleBase.archetypes = archetypes;
    expect(authoringProjectSchema.safeParse(invalidMultipleBase).success).toBe(false);
  });

  it('clearing overrides reveals the Archetype and detaching materializes the effective configuration', () => {
    let project = createAuthoringProject();
    addArchetype(project, 'room-base', 'room', {
      overrides: { '/data/displayName': 'Inherited Room' },
    });
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Stale local snapshot'),
      archetype: { $ref: { collection: 'archetypes', id: 'room-base' } },
      archetypeOverrides: { '/data/displayName': 'Local Room' },
      traits: [],
      properties: {},
    };

    const cleared = clearGameplayInstanceArchetypeOverridesPatches(project, {
      collection: 'rooms',
      entityId: 'foyer',
    });
    expect(cleared.diagnostics).toBeUndefined();
    project = parsedProject(applyJsonPatch(toJsonValue(project), cleared.patches).document);
    expect(
      resolveGameplayInstanceRecord(project, 'room', project.rooms.foyer!)?.data,
    ).toMatchObject({
      displayName: 'Inherited Room',
    });

    project.rooms.foyer!.archetypeOverrides = { '/data/displayName': 'Local Room' };
    const detached = setGameplayInstanceArchetypePatches(project, {
      collection: 'rooms',
      entityId: 'foyer',
      archetypeId: null,
    });
    expect(detached.diagnostics).toBeUndefined();
    project = applyResult(project, detached.patches);
    expect(project.rooms.foyer).toMatchObject({
      archetype: null,
      archetypeOverrides: {},
      data: { displayName: 'Local Room' },
    });

    const base = project.archetypes['room-base']!.data as ArchetypeData;
    base.overrides['/data/displayName'] = 'Changed after detach';
    expect(
      resolveGameplayInstanceRecord(project, 'room', project.rooms.foyer!)?.data,
    ).toMatchObject({
      displayName: 'Local Room',
    });
  });

  it('uses effective Character configuration in preview data and revision tracking', () => {
    const project = createAuthoringProject();
    addArchetype(project, 'hero-base', 'character', {
      overrides: { '/data/displayName': 'Inherited Hero' },
    });
    project.characters.hero = {
      id: 'hero',
      label: 'Hero',
      data: defaultCharacterData('Stale local snapshot'),
      archetype: { $ref: { collection: 'archetypes', id: 'hero-base' } },
      archetypeOverrides: {},
      traits: [],
      properties: {},
    };

    const before = characterPreviewRevision(project, 'hero');
    expect(buildCharacterPreviewDocumentData(project, 'hero')).toMatchObject({
      displayName: 'Inherited Hero',
    });

    const archetype = project.archetypes['hero-base']!.data as ArchetypeData;
    archetype.overrides['/data/displayName'] = 'Updated Archetype Hero';
    expect(characterPreviewRevision(project, 'hero')).not.toBe(before);
    expect(buildCharacterPreviewDocumentData(project, 'hero')).toMatchObject({
      displayName: 'Updated Archetype Hero',
    });
  });

  it('indexes instance and chain references to Archetypes for structural operations', () => {
    const project = createAuthoringProject();
    addArchetype(project, 'room-base', 'room');
    addArchetype(project, 'room-child', 'room', { base: 'room-base' });
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
      archetype: { $ref: { collection: 'archetypes', id: 'room-child' } },
      archetypeOverrides: {},
      traits: [],
      properties: {},
    };

    const index = buildReferenceIndex(project);
    expect(findUsages(index, { collection: 'archetypes', id: 'room-base' })).toEqual([
      expect.objectContaining({
        sourceCollection: 'archetypes',
        sourceId: 'room-child',
        kind: 'explicit-ref',
      }),
    ]);
    expect(findUsages(index, { collection: 'archetypes', id: 'room-child' })).toEqual([
      expect.objectContaining({
        sourceCollection: 'rooms',
        sourceId: 'foyer',
        kind: 'explicit-ref',
      }),
    ]);
  });

  it('validates properties and Traits on unused Archetype configurations', () => {
    const project = createAuthoringProject();
    project.properties.locked = {
      id: 'locked',
      label: 'Locked',
      type: 'boolean',
      nullable: false,
      ownerKinds: ['room'],
    };
    addArchetype(project, 'invalid-room', 'room', {
      overrides: { '/properties/locked': 'not-a-boolean' },
    });

    expect(
      validateAuthoringProject(project).some((item) =>
        item.message.includes("Assignment does not match property 'locked'"),
      ),
    ).toBe(true);
  });

  it('routes hotspot and placement edits through effective Archetype configuration', () => {
    let project = createAuthoringProject();
    addArchetype(project, 'room-base', 'room', {
      overrides: {
        '/data/features': [
          { id: 'desk-surface', label: 'Desk surface', traits: [], properties: {} },
        ],
        '/data/hotspots': [
          {
            id: 'desk',
            label: 'Desk',
            condition: { kind: 'always' },
            inputOrder: 0,
            highlight: { kind: 'default' },
            shape: {
              kind: 'rect',
              bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
            },
            target: { kind: 'owner-feature', featureId: 'desk-surface' },
          },
        ],
        '/data/placements': [
          {
            id: 'desk-slot',
            bounds: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
            order: 0,
            presentation: { label: null, layout: null },
          },
        ],
      },
    });
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Stale room snapshot'),
      archetype: { $ref: { collection: 'archetypes', id: 'room-base' } },
      archetypeOverrides: {},
      traits: [],
      properties: {},
    };

    const renamed = renameHotspot(project, 'room', 'foyer', 'desk', 'writing-desk');
    expect(renamed.diagnostics).toBeUndefined();
    project = parsedProject(applyJsonPatch(toJsonValue(project), renamed.patches).document);
    expect(
      resolveGameplayInstanceRecord(project, 'room', project.rooms.foyer!)?.data,
    ).toMatchObject({ hotspots: [{ id: 'writing-desk' }] });
    expect(resolveArchetypeConfiguration(project, 'room-base')?.data).toMatchObject({
      hotspots: [{ id: 'desk' }],
    });

    const moved = setRoomPlacementBoundsPatches(project, {
      roomId: 'foyer',
      placementId: 'desk-slot',
      bounds: { x: 0.4, y: 0.3, width: 0.2, height: 0.2 },
    });
    expect(moved.diagnostics).toBeUndefined();
    project = parsedProject(applyJsonPatch(toJsonValue(project), moved.patches).document);
    expect(
      resolveGameplayInstanceRecord(project, 'room', project.rooms.foyer!)?.data,
    ).toMatchObject({ placements: [{ id: 'desk-slot', bounds: { x: 0.4, y: 0.3 } }] });

    addArchetype(project, 'prop-base', 'interactable', {
      overrides: {
        '/data/presentation/hotspots': {
          kind: 'sprite-alpha',
          hotspot: {
            id: 'primary',
            label: 'Prop',
            condition: { kind: 'always' },
            inputOrder: 0,
            highlight: { kind: 'default' },
            target: { kind: 'owner' },
          },
        },
      },
    });
    project.interactables.prop = {
      id: 'prop',
      label: 'Prop',
      data: defaultInteractableData('Stale prop snapshot'),
      archetype: { $ref: { collection: 'archetypes', id: 'prop-base' } },
      archetypeOverrides: {},
      traits: [],
      properties: {},
    };
    const mode = setInteractableHotspotMode(project, 'prop', 'custom');
    expect(mode.diagnostics).toBeUndefined();
    project = parsedProject(applyJsonPatch(toJsonValue(project), mode.patches).document);
    expect(
      resolveGameplayInstanceRecord(project, 'interactable', project.interactables.prop!)?.data,
    ).toMatchObject({ presentation: { hotspots: { kind: 'custom', hotspots: [] } } });
    expect(resolveArchetypeConfiguration(project, 'prop-base')?.data).toMatchObject({
      presentation: { hotspots: { kind: 'sprite-alpha' } },
    });
  });

  it('fully flattens effective Archetype configuration into compiled V4 definitions', () => {
    const project = createAuthoringProject({ id: 'archetype-compile', name: 'Archetype Compile' });
    addArchetype(project, 'room-base', 'room', {
      overrides: {
        '/data/displayName': 'Compiled inherited room',
        '/data/background/fit': 'contain',
      },
    });
    project.rooms.start = {
      id: 'start',
      label: 'Start',
      data: defaultRoomData('Stale local snapshot'),
      archetype: { $ref: { collection: 'archetypes', id: 'room-base' } },
      archetypeOverrides: { '/data/background/color': '#123456' },
      traits: [],
      properties: {},
    };
    project.entrypoint = { kind: 'room', id: 'start' };

    const lowered = lowerSharedAuthoringProject(project);
    expect(lowered.diagnostics).toEqual([]);
    const room = lowered.draft?.definitions.rooms.find((candidate) => candidate.id === 'start');
    expect(room).toMatchObject({
      id: 'start',
      displayName: 'Compiled inherited room',
      background: { fit: 'contain', color: '#123456' },
    });
    expect(lowered.draft).not.toHaveProperty('archetypes');
    expect(lowered.draft?.definitions).not.toHaveProperty('archetypes');
  });
});
