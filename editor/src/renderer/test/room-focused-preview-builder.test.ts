import { describe, expect, it } from 'vite-plus/test';
import {
  buildAuthoringStructuralDependencyGraph,
  recordNodeKey,
  serializeAuthoringDependencyNodeKey,
} from '../../shared/authoring-dependency-graph';
import { DEFAULT_PREVIEW_DISPLAY_PREFERENCE } from '../../shared/preview-display';
import { PSEUDO_PREVIEW_LOCALE, pseudoLocalizeText } from '../../shared/pseudo-localization';
import { defaultArchetypeData } from '../../shared/project-schema/authoring-archetypes';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import {
  defaultInteractableData,
  defaultInteractableInstanceData,
} from '../../shared/project-schema/authoring-interactables';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { emptyMaterialApplication } from '../../shared/project-schema/authoring-material-applications';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { buildFocusedRoomPreview } from '../preview/room-focused-preview-builder';
import { testTranslation } from './fixtures/localization-workflow';

function fixture() {
  const project = createAuthoringProject({ id: 'focused-room', name: 'Focused Room' });
  const room = defaultRoomData('Bedroom');
  room.description = {
    markup: 'plain',
    source: { kind: 'localized', key: 'room.bedroom.description' },
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
  project.localization.messages['018f4f8c-9b5d-7ae2-9b36-4c8af613f040'] = {
    kind: 'named',
    key: 'room.bedroom.description',
    source: 'A quiet bedroom.',
  };

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
    activeShaderVariant: 'glsl-330',
  });
}

function fixtureWithRoomMaterial() {
  const project = fixture();
  project.materials.room = {
    id: 'room',
    label: 'Room Material',
    data: defaultMaterialData('Room Material', 'engine-2d'),
  };
  project.rooms.bedroom!.data.background.materialApplication = emptyMaterialApplication('room');
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

  it('admits Interactable definitions separately from Room instance identities', async () => {
    const project = fixture();
    project.assets.masha = {
      id: 'masha',
      label: 'Masha sprite',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/images/masha.png' },
        aliases: [],
        sampling: 'linear',
        byteSize: 3,
        contentHash: `sha256:${'b'.repeat(64)}`,
        imageMetadata: { width: 128, height: 256, hasAlpha: true, orientation: 1 },
      },
    };
    const masha = defaultInteractableData('Masha');
    masha.presentation.sprite = { $ref: { collection: 'assets', id: 'masha' } };
    masha.presentation.hotspots = {
      kind: 'sprite-alpha',
      hotspot: {
        id: 'primary',
        label: 'Masha',
        condition: { kind: 'always' },
        inputOrder: 0,
        highlight: { kind: 'default' },
        target: { kind: 'owner' },
      },
    };
    project.interactables.masha = { id: 'masha', label: 'Masha', data: masha };
    project.interactableInstances['masha-4'] = defaultInteractableInstanceData('masha-4', 'masha', {
      kind: 'room',
      room: { $ref: { collection: 'rooms', id: 'bedroom' } },
    });
    project.rooms.bedroom!.data.interactables[0]!.id = 'z-key';
    project.rooms.bedroom!.data.interactables.push({
      id: 'masha-4',
      interactable: { $ref: { registry: 'interactableInstances', id: 'masha-4' } },
      condition: { kind: 'always' },
      placementId: 'door',
      visible: true,
      order: 1,
    });

    const result = await build(project);
    expect(result.data.world.interactables.map((item) => item.occurrenceId)).toEqual([
      'masha-4',
      'z-key',
    ]);
    expect(result.data.world.interactables.map((item) => item.order)).toEqual([1, 0]);
    expect(result.data.luaAdmission.definitions).toContainEqual({
      collection: 'interactables',
      id: 'masha',
    });
    expect(result.data.luaAdmission.definitions).not.toContainEqual({
      collection: 'interactables',
      id: 'masha-4',
    });
    expect(result.data.luaAdmission.interactableLocationIds).toContain('masha-4');
    expect(result.data.queryState.interactableLocations).toContainEqual({
      interactableId: 'masha-4',
      location: project.interactableInstances['masha-4']!.location,
    });
    expect(result.resources).toContainEqual(
      expect.objectContaining({ resourceId: 'asset:masha', retainAlphaCoverage: true }),
    );
  });

  it('projects effective Room and Interactable Hotspot cursors for focused preview', async () => {
    const project = fixture();
    project.assets.pointer = {
      id: 'pointer',
      label: 'Pointer',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/images/pointer.png' },
        aliases: [],
        sampling: 'linear',
        byteSize: 4,
        contentHash: `sha256:${'c'.repeat(64)}`,
        imageMetadata: { width: 32, height: 32, hasAlpha: true, orientation: 1 },
      },
    };
    project.settings.cursors.defaults.hotspot = { kind: 'named', id: 'tea' };
    project.settings.cursors.named = [
      {
        id: 'tea',
        image: { $ref: { collection: 'assets', id: 'pointer' } },
        hotspotX: 2,
        hotspotY: 3,
      },
    ];
    project.rooms.bedroom!.data.background.asset = {
      $ref: { collection: 'assets', id: 'pointer' },
    };
    project.rooms.bedroom!.data.hotspots = [
      {
        id: 'room-hotspot',
        label: 'Room hotspot',
        condition: { kind: 'always' },
        inputOrder: 2,
        highlight: { kind: 'default' },
        shape: { kind: 'rect', bounds: { x: 0, y: 0, width: 0.25, height: 0.25 } },
        target: {
          kind: 'subject',
          subject: {
            kind: 'interactable',
            interactable: { $ref: { registry: 'interactableInstances', id: 'key' } },
          },
        },
      },
    ];

    const key = project.interactables.key!.data;
    key.presentation.sprite = { $ref: { collection: 'assets', id: 'pointer' } };
    key.presentation.cursor = { kind: 'system', cursor: 'crosshair' };
    key.presentation.hotspots = {
      kind: 'sprite-alpha',
      hotspot: {
        id: 'key-alpha',
        label: 'Key',
        condition: { kind: 'always' },
        inputOrder: 0,
        highlight: { kind: 'default' },
        target: { kind: 'owner' },
      },
    };

    const coin = defaultInteractableData('Coin');
    coin.presentation.sprite = { $ref: { collection: 'assets', id: 'pointer' } };
    coin.presentation.cursor = { kind: 'system', cursor: 'pointer' };
    coin.presentation.hotspots = {
      kind: 'custom',
      hotspots: [
        {
          id: 'coin-face',
          label: 'Coin face',
          condition: { kind: 'always' },
          inputOrder: 1,
          highlight: { kind: 'none' },
          cursor: { kind: 'none' },
          target: { kind: 'owner' },
          shape: { kind: 'rect', bounds: { x: 0, y: 0, width: 1, height: 1 } },
        },
      ],
    };
    project.interactables.coin = { id: 'coin', label: 'Coin', data: coin };
    project.interactableInstances.coin = defaultInteractableInstanceData('coin', 'coin', {
      kind: 'room',
      room: { $ref: { collection: 'rooms', id: 'bedroom' } },
    });
    project.rooms.bedroom!.data.interactables.push({
      id: 'coin',
      interactable: { $ref: { registry: 'interactableInstances', id: 'coin' } },
      condition: { kind: 'always' },
      placementId: 'door',
      visible: true,
      order: 1,
    });

    const result = await build(project);

    expect(result.data.cursors.hotspotCursor).toBe('tea');
    expect(result.data.world.hotspots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ownerKind: 'room', hotspotId: 'room-hotspot', cursor: 'tea' }),
        expect.objectContaining({
          ownerKind: 'interactable',
          ownerId: 'key',
          hotspotId: 'key-alpha',
          shape: { kind: 'alpha' },
          cursor: 'crosshair',
        }),
        expect.objectContaining({
          ownerKind: 'interactable',
          ownerId: 'coin',
          hotspotId: 'coin-face',
          cursor: 'none',
        }),
      ]),
    );
    expect(result.resources).toContainEqual(
      expect.objectContaining({ resourceId: 'asset:pointer', retainAlphaCoverage: true }),
    );
  });

  it('uses locale inheritance when the default locale lacks a Message translation', async () => {
    const project = fixture();
    const messageId = '018f4f8c-9b5d-7ae2-9b36-4c8af613f040';
    project.localization.defaultLocale = 'fr-CA';
    project.localization.locales = {
      en: { supported: true, parentLocale: null, fontStack: null },
      fr: { supported: false, parentLocale: null, fontStack: null },
      'fr-CA': { supported: true, parentLocale: 'fr', fontStack: null },
    };
    project.localization.translations.fr = {
      [messageId]: testTranslation('Une chambre calme.'),
    };

    const result = await build(project);

    expect(result.data.ui.description).toEqual({
      markup: 'plain',
      source: { kind: 'resolved', text: 'Une chambre calme.' },
    });
  });

  it('uses the editor-local Preview Locale without changing the Project Default locale', async () => {
    const project = fixture();
    const messageId = '018f4f8c-9b5d-7ae2-9b36-4c8af613f040';
    project.localization.locales.fr = { supported: true, parentLocale: null, fontStack: null };
    project.localization.translations.fr = {
      [messageId]: testTranslation('Une chambre calme.'),
    };
    project.editor.previewLocale = 'fr';

    const result = await build(project);

    expect(project.localization.defaultLocale).toBe('en');
    expect(result.data.ui.description).toEqual({
      markup: 'plain',
      source: { kind: 'resolved', text: 'Une chambre calme.' },
    });
  });

  it('uses generated pseudo-localization in focused Room preview without changing Project locales', async () => {
    const project = fixture();
    project.editor.previewLocale = PSEUDO_PREVIEW_LOCALE;

    const result = await build(project);

    expect(project.localization.defaultLocale).toBe('en');
    expect(Object.keys(project.localization.locales)).toEqual(['en']);
    expect(result.data.ui.description).toEqual({
      markup: 'plain',
      source: { kind: 'resolved', text: pseudoLocalizeText('A quiet bedroom.').text },
    });
  });

  it('pseudo-localizes authored RML mounted inside focused Room preview', async () => {
    const project = fixture();
    const overlay = defaultLayoutData('Overlay', 'document');
    overlay.target = 'room-overlay';
    overlay.rml.sourceText =
      '<rml><head></head><body><nt-tr>Open <em>door</em>.</nt-tr></body></rml>';
    project.layouts.overlay = { id: 'overlay', label: 'Overlay', data: overlay };
    project.rooms.bedroom!.data.overlays = [
      {
        id: 'status',
        layout: { $ref: { collection: 'layouts', id: 'overlay' } },
        condition: { kind: 'always' },
        visible: true,
        order: 3,
      },
    ];
    project.editor.previewLocale = PSEUDO_PREVIEW_LOCALE;

    const result = await build(project);
    const mounted = result.data.layouts.find((layout) => layout.layoutId === 'overlay');
    expect(mounted?.source.kind).toBe('authored');
    if (mounted?.source.kind !== 'authored' || mounted.source.rml.kind !== 'inline') return;
    expect(mounted.source.rml.text).toContain('<em>');
    expect(mounted.source.rml.text).toContain('</em>');
    expect(mounted.source.rml.text).toContain('⟦');
    expect(project.layouts.overlay.data.rml.sourceText).not.toContain('⟦');
  });

  it('prepares managed Lua Messages for focused preview without authored localization literals', async () => {
    const project = fixture();
    const messageId = '11111111-1111-4111-8111-111111111111';
    project.localization.messages[messageId] = {
      kind: 'named',
      key: 'ui.preview-message',
      source: 'Preview message',
    };
    project.localization.locales.fr = { supported: true, parentLocale: null, fontStack: null };
    project.localization.defaultLocale = 'fr';
    project.localization.translations.fr = {
      [messageId]: testTranslation('Message aperçu'),
    };
    project.rooms.bedroom!.data.description = {
      markup: 'plain',
      source: {
        kind: 'lua-expression',
        source: 'return Text.msg("ui.preview-message")',
      },
    };

    const result = await build(project);
    const source = result.data.ui.description.source;
    expect(source.kind).toBe('lua-expression');
    if (source.kind !== 'lua-expression') return;
    expect(source.source).toContain('local Text=setmetatable');
    expect(source.source).toContain('Text.__message(');
    expect(source.source).toContain('Message aperçu');
    expect(source.source).not.toContain('Preview message');
    expect(source.source).not.toContain('ui.preview-message');
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
        contract: null,
        scalePolicy: { ui: 'inherit', text: 'inherit' },
      },
    ]);
  });

  it('carries mounted Layout contracts into Room preview without standalone sample state', async () => {
    const project = fixture();
    const overlay = defaultLayoutData('Overlay', 'document');
    overlay.target = 'room-overlay';
    project.layouts.overlay = { id: 'overlay', label: 'Overlay', data: overlay };
    project.rooms.bedroom!.data.overlays = [
      {
        id: 'status',
        layout: { $ref: { collection: 'layouts', id: 'overlay' } },
        condition: { kind: 'always' },
        visible: true,
        order: 3,
      },
    ];

    const result = await build(project);
    const mounted = result.data.layouts.find((layout) => layout.layoutId === 'overlay');
    expect(mounted).toMatchObject({
      instanceId: 'room-overlay:status',
      mount: { kind: 'room-overlay', overlayId: 'status', order: 3, visible: true },
      contract: {
        inputs: [],
        signals: [],
        state: {
          type: 'object',
          nullable: false,
          hasDefault: true,
          defaultValue: { saved_count: 0 },
        },
      },
    });
    expect(mounted).not.toHaveProperty('sampleState');
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
        onRejected: [],
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
        activeShaderVariant: 'glsl-330',
      }),
    ).rejects.toThrow(/absent from the current dependency graph snapshot/);
  });

  it('projects preset-backed Materials without project Shader-record resources', async () => {
    const project = fixtureWithRoomMaterial();
    const preview = await build(project);
    expect(
      preview.resources.filter((resource) => resource.sourceKind === 'shader-compiled-output'),
    ).toEqual([]);
    expect(preview.data.shaderMaterials.materials.room).toMatchObject({
      role: 'engine-2d',
      shader: 'preset-engine-2d',
    });
    expect(preview.data.shaderMaterials.shaders['preset-engine-2d']).toMatchObject({
      roles: ['engine-2d'],
      stages: {
        vertex: {
          compiled: { 'glsl-330': { runtimePath: 'system:/shaders/bgfx/glsl-330/quad.vs.bin' } },
        },
        fragment: {
          compiled: { 'glsl-330': { runtimePath: 'system:/shaders/bgfx/glsl-330/quad.fs.bin' } },
        },
      },
    });
  });
});
