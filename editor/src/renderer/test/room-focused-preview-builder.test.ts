import { describe, expect, it } from 'vite-plus/test';
import {
  buildAuthoringStructuralDependencyGraph,
  recordNodeKey,
  serializeAuthoringDependencyNodeKey,
} from '../../shared/authoring-dependency-graph';
import { DEFAULT_PREVIEW_DISPLAY_PREFERENCE } from '../../shared/preview-display';
import { defaultArchetypeData } from '../../shared/project-schema/authoring-archetypes';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import {
  defaultInteractableData,
  defaultInteractableInstanceData,
} from '../../shared/project-schema/authoring-interactables';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import {
  defaultShaderData,
  shaderCompileInputFingerprint,
} from '../../shared/project-schema/authoring-shaders';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import { buildFocusedRoomPreview } from '../preview/room-focused-preview-builder';

function fixture() {
  const project = createAuthoringProject({ id: 'focused-room', name: 'Focused Room' });
  const room = defaultRoomData('Bedroom');
  room.description = {
    markup: 'plain',
    source: { kind: 'localized', key: 'bedroom-description' },
  };
  room.placements = [
    {
      id: 'door',
      bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      order: 4,
      presentation: {
        label: { markup: 'plain', source: { kind: 'inline', text: 'Door' } },
        layout: null,
      },
    },
  ];
  room.interactables = [
    {
      id: 'key',
      interactable: { $ref: { registry: 'interactableInstances', id: 'key' } },
      condition: { kind: 'always' },
      placementId: 'door',
      visible: true,
      order: 0,
    },
  ];
  project.rooms.bedroom = { id: 'bedroom', label: 'Bedroom record', data: room };
  project.localization.catalogs.en!['bedroom-description'] = 'A quiet bedroom.';

  const character = defaultCharacterData('Alice');
  character.initialWorldState.location = {
    kind: 'room',
    room: { $ref: { collection: 'rooms', id: 'bedroom' } },
  };
  project.characters.alice = { id: 'alice', label: 'Alice', data: character };

  const interactable = defaultInteractableData('Key');
  project.interactables.key = { id: 'key', label: 'Key', data: interactable };
  project.interactableInstances.key = defaultInteractableInstanceData('key', 'key', {
    kind: 'room',
    room: { $ref: { collection: 'rooms', id: 'bedroom' } },
  });
  return project;
}

async function build(project = fixture()) {
  const graph = buildAuthoringStructuralDependencyGraph(project);
  return buildFocusedRoomPreview({
    project,
    projectSessionId: '11111111-1111-4111-8111-111111111111',
    roomId: 'bedroom',
    inputs: { displayPreference: DEFAULT_PREVIEW_DISPLAY_PREFERENCE },
    graph: {
      projectInstanceId: 'project-instance',
      projectRevision: 1,
      graphRevision: 1,
      graph,
    },
    sourceAnalysis: [],
    activeShaderVariant: 'glsl-120',
  });
}

async function fixtureWithRoomMaterial() {
  const project = fixture();
  const shader = defaultShaderData('Room Shader');
  project.shaders.room = { id: 'room', label: 'Room Shader', data: shader };
  for (const [stageIndex, stage] of shader.stages.entries()) {
    stage.compiled['glsl-120'] = {
      path: `project:/shaders/bgfx/glsl-120/room.${stage.stage}.bin`,
      byteHash: `sha256:${String(stageIndex + 1).repeat(64)}` as `sha256:${string}`,
      byteSize: 16 + stageIndex,
      compileInputFingerprint: (await shaderCompileInputFingerprint(
        project,
        'room',
        stageIndex,
        'glsl-120',
      ))!,
    };
  }
  project.materials.room = {
    id: 'room',
    label: 'Room Material',
    data: defaultMaterialData('Room Material', 'room'),
  };
  project.rooms.bedroom!.data.background.material = {
    $ref: { collection: 'materials', id: 'room' },
  };
  return project;
}

describe('graph-driven Room builder', () => {
  it('uses the bounded Asset protocol for Room original-image resources', async () => {
    const project = fixture();
    project.assets.background = {
      id: 'background',
      label: 'Background',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/images/background.png' },
        aliases: [],
        sampling: 'linear',
        byteSize: 3,
        contentHash: `sha256:${'a'.repeat(64)}`,
        imageMetadata: { width: 1920, height: 1080, hasAlpha: false, orientation: 1 },
      },
    };
    project.rooms.bedroom!.data.background.asset = {
      $ref: { collection: 'assets', id: 'background' },
    };

    const result = await build(project);
    const resource = result.resources.find((entry) => entry.resourceId === 'asset:background');
    expect(resource).toMatchObject({
      assetId: 'background',
      fetchUrl: 'noveltea-asset://source/11111111-1111-4111-8111-111111111111/background',
      logicalPath: 'project:/assets/images/background.png',
    });
    expect(resource).not.toHaveProperty('fetchProjectRelativePath');
  });

  it('resolves attached Archetypes before building focused Room preview data', async () => {
    const project = fixture();
    const inheritedRoom = structuredClone(project.rooms.bedroom!.data);
    inheritedRoom.displayName = 'Inherited Bedroom';
    inheritedRoom.placements[0]!.bounds = { x: 0.4, y: 0.3, width: 0.2, height: 0.25 };
    project.archetypes['room-base'] = {
      id: 'room-base',
      label: 'Room Base',
      data: {
        ...defaultArchetypeData('room'),
        overrides: { '/data': inheritedRoom },
      },
    };
    project.rooms.bedroom!.archetype = {
      $ref: { collection: 'archetypes', id: 'room-base' },
    };
    project.rooms.bedroom!.archetypeOverrides = {};
    project.rooms.bedroom!.data.displayName = 'Stale local Bedroom';

    const result = await build(project);
    expect(result.data.room.displayName).toBe('Inherited Bedroom');
    expect(result.data.world.placements[0]?.bounds).toEqual({
      x: 0.4,
      y: 0.3,
      width: 0.2,
      height: 0.25,
    });
  });

  it('separates semantic Room presence from Character placement and Interactable occurrences', async () => {
    const result = await build();
    expect(result.data.room).toMatchObject({
      roomId: 'bedroom',
      recordLabel: 'Bedroom record',
      displayName: 'Bedroom',
    });
    expect(result.data.world.persistentCharacters).toEqual([]);
    expect(result.data.world.interactables.map((item) => item.interactableId)).toEqual(['key']);
    expect(result.data.ui.description).toEqual({
      markup: 'plain',
      source: { kind: 'resolved', text: 'A quiet bedroom.' },
    });
    expect(result.data.world.placements).toEqual([
      {
        id: 'door',
        bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        order: 4,
        label: { markup: 'plain', source: { kind: 'resolved', text: 'Door' } },
        layoutId: null,
      },
    ]);
    expect(result.data.layouts).toEqual([
      {
        instanceId: 'game-hud',
        layoutId: null,
        mount: { kind: 'game-hud' },
        source: { kind: 'builtin-game-hud' },
        scriptEnabled: false,
        containsDedicatedLuaSource: false,
        containsExecutableRmlLua: false,
        scalePolicy: { ui: 'inherit', text: 'inherit' },
      },
    ]);
  });

  it('is independent of unrelated collection insertion order', async () => {
    const left = fixture();
    const right = structuredClone(left);
    right.rooms = Object.fromEntries(Object.entries(right.rooms).reverse());
    right.characters = Object.fromEntries(Object.entries(right.characters).reverse());
    right.interactables = Object.fromEntries(Object.entries(right.interactables).reverse());
    expect(await build(right)).toEqual(await build(left));
  });

  it('does not pull target Room visual data through exits', async () => {
    const project = fixture();
    const hall = defaultRoomData('Hall');
    hall.description = { markup: 'plain', source: { kind: 'inline', text: 'Target-only text' } };
    project.rooms.hall = { id: 'hall', label: 'Hall', data: hall };
    const bedroom = defaultRoomData('Bedroom');
    bedroom.placements = structuredClone(project.rooms.bedroom!.data.placements);
    bedroom.exits = [
      {
        id: 'hall-exit',
        label: 'Hall',
        direction: 'east',
        target: { $ref: { collection: 'rooms', id: 'hall' } },
        condition: { kind: 'always' },
      },
    ];
    project.rooms.bedroom!.data = bedroom;
    const result = await build(project);
    expect(result.data.ui.exits[0]).toMatchObject({ targetRoomId: 'hall', label: 'Hall' });
    expect(JSON.stringify(result.data)).not.toContain('Target-only text');
  });

  it('fails closed when the current graph omits the requested Room root', async () => {
    const project = fixture();
    const graph = buildAuthoringStructuralDependencyGraph(project);
    const nodesByKey = new Map(graph.nodesByKey);
    nodesByKey.delete(serializeAuthoringDependencyNodeKey(recordNodeKey('rooms', 'bedroom')));
    await expect(
      buildFocusedRoomPreview({
        project,
        projectSessionId: '11111111-1111-4111-8111-111111111111',
        roomId: 'bedroom',
        inputs: { displayPreference: DEFAULT_PREVIEW_DISPLAY_PREFERENCE },
        graph: {
          projectInstanceId: 'project-instance',
          projectRevision: 1,
          graphRevision: 1,
          graph: { ...graph, nodesByKey },
        },
        sourceAnalysis: [],
        activeShaderVariant: 'glsl-120',
      }),
    ).rejects.toThrow(/absent from the current dependency graph snapshot/);
  });

  it('uses canonical shader fetch paths and rejects stale compiled outputs', async () => {
    const project = await fixtureWithRoomMaterial();
    const fresh = await build(project);
    expect(
      fresh.resources
        .filter((resource) => resource.sourceKind === 'shader-compiled-output')
        .map((resource) => ({
          fetchProjectRelativePath: resource.fetchProjectRelativePath,
          logicalPath: resource.logicalPath,
        })),
    ).toEqual([
      {
        fetchProjectRelativePath: '.noveltea/build/shaders/bgfx/glsl-120/room.fragment.bin',
        logicalPath: 'project:/shaders/bgfx/glsl-120/room.fragment.bin',
      },
      {
        fetchProjectRelativePath: '.noveltea/build/shaders/bgfx/glsl-120/room.vertex.bin',
        logicalPath: 'project:/shaders/bgfx/glsl-120/room.vertex.bin',
      },
    ]);

    project.shaders.room!.data.stages[1]!.sourceText = 'changed after compilation';
    const stale = await build(project);
    expect(stale.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining("fragment output for 'glsl-120' is stale"),
      }),
    );
  });
});
