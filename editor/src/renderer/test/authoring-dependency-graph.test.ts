import { describe, expect, it } from 'vite-plus/test';
import {
  AUTHORING_INTRINSIC_GRAPH_INPUTS,
  AUTHORING_STRUCTURAL_ADAPTER_DECLARATIONS,
  assembleAuthoringDependencyGraph,
  authoringDependencyForwardClosure,
  authoringDependencyReverseImpactClosure,
  buildAuthoringStructuralDependencyGraphContributionSet,
  buildAuthoringStructuralDependencyGraph,
  classifyAuthoringGraphInputPath,
  createAuthoringDependencyEdgeId,
  createAuthoringDependencyGraphContributionSet,
  findAuthoringDependencyOwnersByPath,
  findAuthoringDependencyUsages,
  findMissingAuthoringDependencyTargets,
  findNestedAuthoringDependencyTarget,
  findPreviewRootsImpactedByPathUnion,
  findPreviewRootsImpactedByPaths,
  localizationKeyNodeKey,
  nestedNodeKey,
  outgoingAuthoringDependencies,
  propertyDefinitionNodeKey,
  recordNodeKey,
  replaceAuthoringDependencyGraphContributions,
  serializeAuthoringDependencyDerivationDependency,
  serializeAuthoringDependencyNodeKey,
} from '../../shared/authoring-dependency-graph';
import { assertGraphInputRegistryComplete } from '../../shared/authoring-dependency-graph-audit';
import type {
  AuthoringDependencyEdge,
  AuthoringDependencyGraphContribution,
  AuthoringDependencyNode,
} from '../../shared/authoring-dependency-contracts';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import {
  createAuthoringProject,
  type AuthoringRecordBase,
} from '../../shared/project-schema/authoring-project';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import { authoringCollectionKeys } from '../../shared/project-schema/authoring-collections';
import { assertAuthoringGraphFieldMetadataComplete } from '../../shared/project-schema/authoring-graph-field-metadata';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import { defaultInteractableData } from '../../shared/project-schema/authoring-interactables';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { defaultShaderData } from '../../shared/project-schema/authoring-shaders';
import { defaultVariableData, variableRef } from '../../shared/project-schema/authoring-variables';
import { defaultInteractionData } from '../../shared/project-schema/authoring-interactions';
import { defaultVerbData } from '../../shared/project-schema/authoring-verbs';
import {
  buildReferenceIndex,
  buildReferenceIndexFromGraph,
} from '../../shared/project-schema/authoring-references';

function node(
  collection: 'rooms' | 'characters',
  id: string,
  owningPath = `/${collection}/${id}`,
): AuthoringDependencyNode {
  const key = recordNodeKey(collection, id);
  return { key, keyText: serializeAuthoringDependencyNodeKey(key), owningPath, label: id };
}

function edge(
  source: AuthoringDependencyNode['key'],
  target: AuthoringDependencyNode['key'],
  sourcePath: string,
  role: AuthoringDependencyEdge['role'] = 'explicit-ref',
  facets: AuthoringDependencyEdge['facets'] = ['reference-integrity'],
): AuthoringDependencyEdge {
  const partial = {
    source,
    target,
    sourcePath,
    targetPath: target.kind === 'record' ? `/${target.collection}/${target.id}` : '/target',
    role,
  };
  return {
    id: createAuthoringDependencyEdgeId(partial),
    ...partial,
    facets,
    targetImpactPaths: [partial.targetPath],
    repair: { kind: 'warning-only', reason: 'test' },
  };
}

function contribution(
  key: string,
  nodes: readonly AuthoringDependencyNode[],
  edges: readonly AuthoringDependencyEdge[] = [],
): AuthoringDependencyGraphContribution {
  return {
    key,
    ownerPath: nodes[0]?.owningPath ?? '',
    nodes,
    edges,
    diagnostics: [],
    derivationDependencies: [],
    literalOccurrences: [],
  };
}

function graphSnapshot(graph: ReturnType<typeof assembleAuthoringDependencyGraph>) {
  return {
    nodes: [...graph.nodesByKey],
    edges: [...graph.edgesById],
    outgoing: [...graph.outgoingEdgeIdsByNodeKey],
    incoming: [...graph.incomingEdgeIdsByNodeKey],
    owned: [...graph.sourceNodeKeysByOwnedPath],
    diagnostics: graph.diagnostics,
  };
}

describe('authoring dependency graph contribution assembly', () => {
  it('keeps every current schema field covered by reviewed graph metadata', () => {
    expect(() => assertAuthoringGraphFieldMetadataComplete()).not.toThrow();
  });

  it('assembles insertion-order-independent immutable graph indexes', () => {
    const room = node('rooms', 'foyer');
    const character = node('characters', 'alice');
    const relationship = edge(room.key, character.key, '/rooms/foyer/data/cast/0');
    const left = assembleAuthoringDependencyGraph([
      contribution('room', [room], [relationship]),
      contribution('character', [character]),
    ]);
    const right = assembleAuthoringDependencyGraph([
      contribution('character', [character]),
      contribution('room', [room], [relationship]),
    ]);

    expect(graphSnapshot(left)).toEqual(graphSnapshot(right));
    expect(Object.isFrozen(left)).toBe(true);
    expect(Object.isFrozen(left.diagnostics)).toBe(true);
    expect('set' in left.nodesByKey).toBe(false);
    expect(outgoingAuthoringDependencies(left, room.key)).toEqual([relationship]);
  });

  it('upgrades a generic relationship once and rejects conflicting ownership metadata', () => {
    const room = node('rooms', 'foyer');
    const character = node('characters', 'alice');
    const generic = edge(room.key, character.key, '/rooms/foyer/data/cast/0');
    const typed = {
      ...edge(room.key, character.key, '/rooms/foyer/data/cast/0', 'room-cast-character', [
        'reference-integrity',
        'preview-visual',
      ]),
      repair: { kind: 'set-null' as const, path: '/rooms/foyer/data/cast/0/character' },
      detail: { poseId: 'standing' },
    };
    const graph = assembleAuthoringDependencyGraph([
      contribution('room', [room, character], [generic, typed]),
    ]);
    expect([...graph.edgesById.values()]).toHaveLength(1);
    expect([...graph.edgesById.values()][0]).toMatchObject({
      role: 'room-cast-character',
      facets: ['preview-visual', 'reference-integrity'],
      repair: { kind: 'set-null', path: '/rooms/foyer/data/cast/0/character' },
      detail: { poseId: 'standing' },
    });

    expect(() =>
      assembleAuthoringDependencyGraph([
        contribution('character', [room, character], [typed]),
        contribution(
          'layout',
          [],
          [edge(room.key, character.key, '/rooms/foyer/data/cast/0', 'room-overlay-layout')],
        ),
      ]),
    ).toThrow(/Conflicting graph edge ownership/);

    expect(() =>
      assembleAuthoringDependencyGraph([
        contribution(
          'room',
          [room, character],
          [typed, edge(room.key, character.key, '/rooms/foyer/data/cast/0', 'room-overlay-layout')],
        ),
      ]),
    ).toThrow(/Conflicting graph edge roles/);

    expect(() =>
      assembleAuthoringDependencyGraph([
        contribution('left', [room]),
        contribution('right', [room]),
      ]),
    ).toThrow(/Conflicting graph node ownership/);
  });

  it('builds deterministic reverse derivation and decoded-literal indexes', () => {
    const base = contribution('room', [node('rooms', 'foyer')]);
    const occurrence = {
      sourcePath: '/rooms/foyer/data/composeLua',
      sourceContentHash: `sha256:${'0'.repeat(64)}` as const,
      regionOrdinal: 0,
      regionStartUtf16: 0,
      regionEndUtf16: 7,
      line: 1,
      column: 1,
      rawLiteral: '"alice"',
      decodedValue: 'alice',
      literalKind: 'double-quoted' as const,
      sourceKind: 'lua-field' as const,
    };
    const set = createAuthoringDependencyGraphContributionSet([
      {
        ...base,
        derivationDependencies: [
          { kind: 'project-field', path: '/localization/defaultLocale' },
          { kind: 'source-asset', assetId: 'room-script' },
        ],
        literalOccurrences: [occurrence],
      },
    ]);

    expect(
      set.contributionKeysByDerivationKey.get(
        serializeAuthoringDependencyDerivationDependency({
          kind: 'source-asset',
          assetId: 'room-script',
        }),
      ),
    ).toEqual(['room']);
    expect(set.contributionKeysByDecodedLiteral.get('alice')).toEqual(['room']);
  });

  it('replaces one contribution without retaining stale reverse indexes', () => {
    const room = node('rooms', 'foyer');
    const first = createAuthoringDependencyGraphContributionSet([
      {
        ...contribution('room', [room]),
        derivationDependencies: [{ kind: 'source-asset', assetId: 'old-script' }],
      },
    ]);
    const replacement = replaceAuthoringDependencyGraphContributions(first, [
      {
        ...contribution('room', [room]),
        derivationDependencies: [{ kind: 'source-asset', assetId: 'new-script' }],
      },
    ]);

    expect(
      first.contributionKeysByDerivationKey.get(
        serializeAuthoringDependencyDerivationDependency({
          kind: 'source-asset',
          assetId: 'old-script',
        }),
      ),
    ).toEqual(['room']);
    expect(
      replacement.contributionKeysByDerivationKey.has(
        serializeAuthoringDependencyDerivationDependency({
          kind: 'source-asset',
          assetId: 'old-script',
        }),
      ),
    ).toBe(false);
  });
});

describe('authoring structural dependency graph and queries', () => {
  it('tracks each Room hotspot source image through its owning Room background', () => {
    const project = createAuthoringProject();
    project.assets.background = {
      id: 'background',
      label: 'Background',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/background.png' },
        aliases: [],
        imageMetadata: { width: 1920, height: 1080, hasAlpha: false, orientation: 1 },
      },
    };
    const room = defaultRoomData('Room');
    room.background.asset = { $ref: { collection: 'assets', id: 'background' } };
    room.hotspots.push({
      id: 'door',
      label: 'Door',
      condition: { kind: 'always' },
      inputOrder: 0,
      highlight: { kind: 'none' },
      shape: { kind: 'rect', bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
      activation: { kind: 'exit', exitId: 'north' },
    });
    room.exits.push({
      id: 'north',
      label: 'North',
      direction: 'north',
      target: { $ref: { collection: 'rooms', id: 'room' } },
      condition: { kind: 'always' },
    });
    project.rooms.room = { id: 'room', label: 'Room', data: room };

    const graph = buildAuthoringStructuralDependencyGraph(project);
    const hotspot = nestedNodeKey('rooms', 'room', 'room-hotspot', 'door');
    expect(
      outgoingAuthoringDependencies(graph, hotspot).some(
        (edge) =>
          edge.role === 'hotspot-source-image' &&
          serializeAuthoringDependencyNodeKey(edge.target) ===
            serializeAuthoringDependencyNodeKey(recordNodeKey('assets', 'background')),
      ),
    ).toBe(true);
  });

  it('tracks Interactable hotspot source images across rename, deletion, replacement, and mode switches', () => {
    const project = createAuthoringProject();
    project.assets.sprite = {
      id: 'sprite',
      label: 'Sprite',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/sprite.png' },
        aliases: [],
        imageMetadata: { width: 64, height: 64, hasAlpha: true, orientation: 1 },
      },
    };
    const item = defaultInteractableData('Item');
    item.presentation.sprite = { $ref: { collection: 'assets', id: 'sprite' } };
    project.interactables.item = { id: 'item', label: 'Item', data: item };
    const verb = defaultVerbData('Use');
    verb.arity = 1;
    verb.operandRoles = ['target'];
    project.verbs.use = { id: 'use', label: 'Use', data: verb };
    const interaction = defaultInteractionData();
    interaction.rules.push({
      id: 'rule',
      verb: { $ref: { collection: 'verbs', id: 'use' } },
      operands: [{ kind: 'any-interactable' }],
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

    let graph = buildAuthoringStructuralDependencyGraph(project);
    const primary = nestedNodeKey('interactables', 'item', 'interactable-hotspot', 'primary');
    expect(
      outgoingAuthoringDependencies(graph, primary).some(
        (edge) =>
          edge.role === 'hotspot-source-image' &&
          serializeAuthoringDependencyNodeKey(edge.target) ===
            serializeAuthoringDependencyNodeKey(recordNodeKey('assets', 'sprite')),
      ),
    ).toBe(true);
    expect(findAuthoringDependencyUsages(graph, primary).map((edge) => edge.role)).toEqual(
      expect.arrayContaining(['explicit-ref', 'hotspot-context']),
    );

    if (item.presentation.hotspots.kind !== 'sprite-alpha')
      throw new Error('Expected sprite alpha');
    item.presentation.hotspots.hotspot.id = 'renamed';
    graph = buildAuthoringStructuralDependencyGraph(project);
    const renamed = nestedNodeKey('interactables', 'item', 'interactable-hotspot', 'renamed');
    expect(
      findNestedAuthoringDependencyTarget(
        graph,
        'interactables',
        'item',
        'interactable-hotspot',
        'primary',
      ),
    ).toBeUndefined();
    expect(
      findNestedAuthoringDependencyTarget(
        graph,
        'interactables',
        'item',
        'interactable-hotspot',
        'renamed',
      ),
    ).toBeDefined();
    expect(findMissingAuthoringDependencyTargets(graph)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/interactions/actions/data/rules/0/context/hotspot',
        }),
      ]),
    );

    const context = interaction.rules[0]!.context;
    if (context.kind !== 'hotspot' || context.hotspot.kind !== 'interactable-hotspot')
      throw new Error('Expected Interactable hotspot context');
    context.hotspot.hotspotId = 'renamed';
    graph = buildAuthoringStructuralDependencyGraph(project);
    expect(findAuthoringDependencyUsages(graph, renamed).map((edge) => edge.role)).toEqual(
      expect.arrayContaining(['explicit-ref', 'hotspot-context']),
    );
    expect(findMissingAuthoringDependencyTargets(graph)).toEqual([]);

    item.presentation.hotspots = { kind: 'custom', hotspots: [] };
    graph = buildAuthoringStructuralDependencyGraph(project);
    expect(
      findNestedAuthoringDependencyTarget(
        graph,
        'interactables',
        'item',
        'interactable-hotspot',
        'renamed',
      ),
    ).toBeUndefined();
    expect(findMissingAuthoringDependencyTargets(graph)).toHaveLength(1);
  });
  it('builds record/project-field contributions and reports missing structural targets', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData() };
    project.rooms.hall = {
      id: 'hall',
      label: 'Hall',
      extends: 'foyer',
      data: defaultRoomData(),
    };
    project.rooms.hall.data.background.asset = {
      $ref: { collection: 'assets', id: 'missing-background' },
    };
    project.entrypoint = { kind: 'room', id: 'foyer' };

    const graph = buildAuthoringStructuralDependencyGraph(project);
    const foyerUsages = findAuthoringDependencyUsages(graph, recordNodeKey('rooms', 'foyer'));
    expect(foyerUsages.map((usage) => usage.role)).toEqual(['entrypoint', 'extends']);
    expect(findMissingAuthoringDependencyTargets(graph)).toEqual([
      expect.objectContaining({
        code: 'authoring_dependency.missing_target',
        path: '/rooms/hall/data/background/asset/$ref',
      }),
    ]);
    expect(findAuthoringDependencyOwnersByPath(graph, '/rooms/hall/data/name')).toEqual([
      expect.objectContaining({ label: 'Hall' }),
    ]);
  });

  it('performs deterministic cycle-safe closures, nested lookup, and preview impact', () => {
    const roomA = node('rooms', 'a');
    const roomB = node('rooms', 'b');
    const character = node('characters', 'alice');
    const placementKey = nestedNodeKey('rooms', 'a', 'room-placement', 'alice-main');
    const placement: AuthoringDependencyNode = {
      key: placementKey,
      keyText: serializeAuthoringDependencyNodeKey(placementKey),
      owningPath: '/rooms/a/data/placements/alice-main',
      label: 'Alice main',
    };
    const graph = assembleAuthoringDependencyGraph([
      contribution(
        'a',
        [roomA, placement],
        [
          edge(roomA.key, roomB.key, '/rooms/a/data/next', 'explicit-ref', ['preview-visual']),
          edge(roomA.key, character.key, '/rooms/a/data/cast/0', 'room-cast-character', [
            'preview-visual',
          ]),
        ],
      ),
      contribution(
        'b',
        [roomB],
        [edge(roomB.key, roomA.key, '/rooms/b/data/next', 'explicit-ref', ['preview-visual'])],
      ),
      contribution('character', [character]),
    ]);

    expect(
      authoringDependencyForwardClosure(graph, [roomA.key]).map((item) => item.keyText),
    ).toEqual([roomA, roomB, character].map((item) => item.keyText).sort());
    expect(
      authoringDependencyReverseImpactClosure(graph, [character.key]).map((item) => item.keyText),
    ).toEqual([roomA.keyText, roomB.keyText, character.keyText].sort());
    expect(
      findNestedAuthoringDependencyTarget(graph, 'rooms', 'a', 'room-placement', 'alice-main'),
    ).toEqual(placement);
    expect(
      findPreviewRootsImpactedByPaths(graph, [roomA.key, roomB.key], ['/characters/alice/data']),
    ).toEqual([roomA, roomB]);
  });

  it('derives semantic collection adapters, nested Room targets, and project-field owners', () => {
    const project = createAuthoringProject();
    project.assets.background = {
      id: 'background',
      label: 'Background',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'images/background.png' },
        aliases: [],
        imageMetadata: { width: 1920, height: 1080, hasAlpha: false, orientation: 1 },
      },
    };
    project.materials.base = {
      id: 'base',
      label: 'Base',
      data: defaultMaterialData(),
    };
    project.materials.derived = {
      id: 'derived',
      label: 'Derived',
      data: { ...defaultMaterialData(), baseMaterialId: 'base' },
    };
    project.characters.alice = {
      id: 'alice',
      label: 'Alice',
      data: defaultCharacterData('Alice'),
    };
    const interactable = defaultInteractableData('Door');
    interactable.presentation.sprite = { $ref: { collection: 'assets', id: 'background' } };
    project.interactables.door = { id: 'door', label: 'Door', data: interactable };
    const shader = defaultShaderData('Room shader');
    shader.stages[0] = {
      ...shader.stages[0]!,
      sourceMode: 'asset',
      sourceAsset: { $ref: { collection: 'assets', id: 'background' } },
    };
    project.shaders.room = { id: 'room', label: 'Room shader', data: shader };
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData() };
    project.rooms.foyer.data.placements.push({
      id: 'door',
      bounds: { x: 0, y: 0, width: 0.2, height: 0.2 },
      presentation: { label: null, layout: null },
    });
    project.rooms.foyer.data.cast.push({
      id: 'alice-main',
      character: { $ref: { collection: 'characters', id: 'alice' } },
      condition: { kind: 'always' },
      placementId: 'door',
      poseId: 'standing',
      expressionId: 'smile',
      idleId: 'breathe',
      visible: true,
      order: 0,
    });
    project.rooms.foyer.data.exits.push({
      id: 'north',
      label: 'North',
      direction: 'north',
      target: { $ref: { collection: 'rooms', id: 'foyer' } },
      condition: { kind: 'always' },
    });
    project.rooms.foyer.data.background.asset = {
      $ref: { collection: 'assets', id: 'background' },
    };
    project.settings.text.defaultFont = {
      $ref: { collection: 'assets', id: 'background' },
    };
    project.layouts.hud = { id: 'hud', label: 'HUD', data: defaultLayoutData('HUD') };
    project.settings.ui.systemLayouts['game-hud'] = {
      $ref: { collection: 'layouts', id: 'hud' },
    };

    const graph = buildAuthoringStructuralDependencyGraph(project);
    expect(
      findAuthoringDependencyUsages(graph, recordNodeKey('assets', 'background')).map(
        (usage) => usage.role,
      ),
    ).toEqual(
      expect.arrayContaining([
        'default-font',
        'interactable-sprite',
        'room-background',
        'shader-source',
      ]),
    );
    expect(
      findAuthoringDependencyUsages(graph, recordNodeKey('materials', 'base')).map(
        (usage) => usage.role,
      ),
    ).toEqual(['material-base']);
    expect(
      findNestedAuthoringDependencyTarget(graph, 'rooms', 'foyer', 'room-placement', 'door'),
    ).toBeDefined();
    expect(
      findNestedAuthoringDependencyTarget(graph, 'rooms', 'foyer', 'room-exit', 'north'),
    ).toBeDefined();
    expect(
      graph.nodesByKey.has(
        serializeAuthoringDependencyNodeKey({ kind: 'project-field', path: '/startupHook' }),
      ),
    ).toBe(true);
    expect(findAuthoringDependencyUsages(graph, recordNodeKey('layouts', 'hud'))).toContainEqual(
      expect.objectContaining({ role: 'system-layout', detail: { systemRole: 'game-hud' } }),
    );
    expect(
      findAuthoringDependencyUsages(graph, recordNodeKey('characters', 'alice')),
    ).toContainEqual(
      expect.objectContaining({
        role: 'room-cast-character',
        detail: {
          id: 'alice-main',
          placementId: 'door',
          poseId: 'standing',
          expressionId: 'smile',
          idleId: 'breathe',
        },
      }),
    );
  });

  it('retains tolerant nested nodes and owner-local diagnostics for admitted invalid input', () => {
    const project = createAuthoringProject();
    const data = defaultRoomData();
    data.placements.push({
      id: 'door',
      bounds: { x: 0, y: 0, width: 0.2, height: 0.2 },
      presentation: { label: null, layout: null },
    });
    data.cast.push({
      id: 'alice',
      character: { $ref: { collection: 'characters', id: 'alice' } },
      condition: { kind: 'always' },
      placementId: 'missing-placement',
      poseId: null,
      expressionId: null,
      idleId: null,
      visible: true,
      order: 0,
    });
    (data.background as unknown as { fit: string }).fit = 'invalid-but-admitted';
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data };

    const graph = buildAuthoringStructuralDependencyGraph(project);
    expect(
      findNestedAuthoringDependencyTarget(graph, 'rooms', 'foyer', 'room-placement', 'door'),
    ).toBeDefined();
    expect(graph.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'authoring_dependency.missing_owner_local_target',
        path: '/rooms/foyer/data/cast/0/placementId',
      }),
    );
  });

  it('derives one structural contribution for every current collection', () => {
    const project = createAuthoringProject();
    project.assets.target = {
      id: 'target',
      label: 'Target',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'images/target.png' },
        aliases: [],
        imageMetadata: { width: 64, height: 64, hasAlpha: true, orientation: 1 },
      },
    };
    for (const collection of authoringCollectionKeys) {
      const id = `source-${collection}`;
      const records = project[collection] as Record<string, AuthoringRecordBase>;
      records[id] = {
        id,
        label: collection,
        data: { dependency: { $ref: { collection: 'assets', id: 'target' } } },
      };
    }

    const graph = buildAuthoringStructuralDependencyGraph(project);
    for (const collection of authoringCollectionKeys) {
      const source = recordNodeKey(collection, `source-${collection}`);
      expect(graph.nodesByKey.has(serializeAuthoringDependencyNodeKey(source))).toBe(true);
      expect(outgoingAuthoringDependencies(graph, source)).toContainEqual(
        expect.objectContaining({ target: recordNodeKey('assets', 'target') }),
      );
    }
  });

  it('derives exact property-definition and localization fallback relationships', () => {
    const project = createAuthoringProject();
    project.properties.mood = {
      id: 'mood',
      label: 'Mood',
      type: 'string',
      nullable: false,
      defaultValue: 'neutral',
      ownerKinds: ['room'],
      persistence: 'Save',
    };
    project.localization.defaultLocale = 'en';
    project.localization.fallbackLocale = 'fr';
    project.localization.catalogs = { en: {}, fr: { 'room.foyer': 'Foyer' } };
    const data = defaultRoomData();
    data.description = {
      source: { kind: 'localized', key: 'room.foyer' },
      markup: 'plain',
    };
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      properties: { mood: 'calm' },
      data,
    };

    const fallbackGraph = buildAuthoringStructuralDependencyGraph(project);
    expect(
      findAuthoringDependencyUsages(fallbackGraph, propertyDefinitionNodeKey('mood')),
    ).toContainEqual(expect.objectContaining({ role: 'property-assignment' }));
    expect(
      findAuthoringDependencyUsages(fallbackGraph, localizationKeyNodeKey('en', 'room.foyer')),
    ).toContainEqual(expect.objectContaining({ role: 'localization-text' }));
    expect(
      findAuthoringDependencyUsages(fallbackGraph, localizationKeyNodeKey('fr', 'room.foyer')),
    ).toContainEqual(expect.objectContaining({ role: 'localization-text' }));

    project.localization.catalogs.en!['room.foyer'] = 'Foyer';
    const defaultGraph = buildAuthoringStructuralDependencyGraph(project);
    expect(
      findAuthoringDependencyUsages(defaultGraph, localizationKeyNodeKey('fr', 'room.foyer')),
    ).toEqual([]);
  });

  it('uses exact target-impact paths instead of invalidating on every target field', () => {
    const project = createAuthoringProject();
    project.assets.background = {
      id: 'background',
      label: 'Background',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'images/background.png' },
        aliases: [],
        imageMetadata: { width: 1920, height: 1080, hasAlpha: false, orientation: 1 },
      },
    };
    const roomData = defaultRoomData();
    roomData.background.asset = { $ref: { collection: 'assets', id: 'background' } };
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: roomData };
    project.settings.text.defaultFont = {
      $ref: { collection: 'assets', id: 'background' },
    };
    const graph = buildAuthoringStructuralDependencyGraph(project);
    const room = recordNodeKey('rooms', 'foyer');

    expect(
      findPreviewRootsImpactedByPaths(graph, [room], ['/assets/background/data/source/path']),
    ).toHaveLength(1);
    expect(
      findPreviewRootsImpactedByPaths(graph, [room], ['/assets/background/data/preview/width']),
    ).toEqual([]);
    expect(findPreviewRootsImpactedByPaths(graph, [room], ['/assets/background'])).toHaveLength(1);
    expect(
      findPreviewRootsImpactedByPaths(graph, [room], ['/assets/backgrounds/data/source/path']),
    ).toEqual([]);
    expect(
      findPreviewRootsImpactedByPaths(
        graph,
        [room],
        ['/settings/display/referenceResolution/width'],
      ),
    ).toHaveLength(1);
    expect(
      findPreviewRootsImpactedByPaths(graph, [room], ['/settings/accessibility/textScale']),
    ).toHaveLength(1);
    expect(
      findPreviewRootsImpactedByPaths(graph, [room], ['/settings/ui/systemLayouts/game-hud']),
    ).toHaveLength(1);
    expect(findPreviewRootsImpactedByPaths(graph, [room], ['/settings/audio'])).toEqual([]);
  });

  it('uses segment-aware path impact and unions old/new dependency closures', () => {
    const roomA = node('rooms', 'a');
    const roomAb = node('rooms', 'ab');
    const character = node('characters', 'alice');
    const previous = assembleAuthoringDependencyGraph([
      contribution(
        'a',
        [roomA],
        [
          edge(roomA.key, character.key, '/rooms/a/data/cast/0', 'room-cast-character', [
            'preview-visual',
          ]),
        ],
      ),
      contribution('ab', [roomAb]),
      contribution('character', [character]),
    ]);
    const current = assembleAuthoringDependencyGraph([
      contribution('a', [roomA]),
      contribution(
        'ab',
        [roomAb],
        [
          edge(roomAb.key, character.key, '/rooms/ab/data/cast/0', 'room-cast-character', [
            'preview-visual',
          ]),
        ],
      ),
      contribution('character', [character]),
    ]);

    expect(findAuthoringDependencyOwnersByPath(previous, '/rooms/a/data/name')).toEqual([roomA]);
    expect(findAuthoringDependencyOwnersByPath(previous, '/rooms/ab/data/name')).toEqual([roomAb]);
    expect(
      findPreviewRootsImpactedByPathUnion(
        previous,
        current,
        [roomA.key, roomAb.key],
        ['/characters/alice/data/poses'],
      ).map((item) => item.keyText),
    ).toEqual([roomA.keyText, roomAb.keyText].sort());
  });

  it('keeps structural compatibility projection identical to the public reference index', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData() };
    project.rooms.hall = {
      id: 'hall',
      label: 'Hall',
      extends: 'foyer',
      data: defaultRoomData(),
    };
    const graph = buildAuthoringStructuralDependencyGraph(project);
    expect(buildReferenceIndexFromGraph(project, graph)).toEqual(buildReferenceIndex(project));
  });

  it('fails closed for string-shaped generic replacement roles', () => {
    const project = createAuthoringProject();
    project.rooms.base = { id: 'base', label: 'Base', data: defaultRoomData() };
    project.rooms.child = {
      id: 'child',
      label: 'Child',
      extends: 'base',
      data: defaultRoomData(),
    };
    project.variables.score = {
      id: 'score',
      label: 'Score',
      data: defaultVariableData('integer'),
    };
    project.scenes.intro = {
      id: 'intro',
      label: 'Intro',
      data: { condition: variableRef('score') } as never,
    };

    const graph = buildAuthoringStructuralDependencyGraph(project);
    const repairs = [...graph.edgesById.values()]
      .filter((edge) => edge.role === 'extends' || edge.role === 'variable-ref')
      .map((edge) => [edge.role, edge.repair]);
    expect(repairs).toEqual([
      [
        'extends',
        {
          kind: 'blocked',
          reason: 'This reference role has no safe automatic repair encoding.',
        },
      ],
      [
        'variable-ref',
        {
          kind: 'blocked',
          reason: 'This reference role has no safe automatic repair encoding.',
        },
      ],
    ]);
  });

  it('declares every collection adapter and generates fail-closed field classifications', () => {
    expect(AUTHORING_STRUCTURAL_ADAPTER_DECLARATIONS.map((item) => item.collection)).toEqual(
      authoringCollectionKeys,
    );
    expect(AUTHORING_INTRINSIC_GRAPH_INPUTS.length).toBeGreaterThan(100);
    for (const declaration of AUTHORING_STRUCTURAL_ADAPTER_DECLARATIONS) {
      expect(declaration.consumedPathPatterns.length).toBeGreaterThan(0);
      expect(
        declaration.consumedPathPatterns.every((path) =>
          path.startsWith(`/${declaration.collection}/*/`),
        ),
      ).toBe(true);
    }
    expect(classifyAuthoringGraphInputPath('/rooms/foyer/data/background/fit')).toEqual({
      path: '/rooms/foyer/data/background/fit',
      effect: { kind: 'none' },
    });
    expect(classifyAuthoringGraphInputPath('/rooms/foyer/data/background/asset/$ref/id')).toEqual({
      path: '/rooms/foyer/data/background/asset/$ref/id',
      effect: { kind: 'owner-contribution' },
    });
    expect(classifyAuthoringGraphInputPath('/rooms/foyer/data/background')).toEqual({
      path: '/rooms/foyer/data/background',
      effect: { kind: 'structural' },
    });
    expect(classifyAuthoringGraphInputPath('/not-an-authoring-field')).toBeUndefined();
    expect(
      classifyAuthoringGraphInputPath('/rooms/foyer/data/background/fit/unexpected-child'),
    ).toBeUndefined();
  });

  it('audits representative stable and structural graph inputs against fresh full builds', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData() };
    project.assets.background = {
      id: 'background',
      label: 'Background',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'images/background.png' },
        aliases: [],
        imageMetadata: { width: 1920, height: 1080, hasAlpha: false, orientation: 1 },
      },
    };
    const results = assertGraphInputRegistryComplete(project, [
      {
        name: 'room background fit remains graph stable',
        path: '/rooms/foyer/data/background/fit',
        mutate(current) {
          const data = current.rooms.foyer!.data as ReturnType<typeof defaultRoomData>;
          data.background.fit = 'contain';
        },
        expectedGraphChange: false,
      },
      {
        name: 'structural Room asset reference changes its contribution',
        path: '/rooms/foyer/data/background/asset/$ref/id',
        mutate(current) {
          const data = current.rooms.foyer!.data as ReturnType<typeof defaultRoomData>;
          data.background.asset = { $ref: { collection: 'assets', id: 'background' } };
        },
        expectedGraphChange: true,
      },
      {
        name: 'entrypoint relationship changes graph',
        path: '/entrypoint',
        mutate(current) {
          current.entrypoint = { kind: 'room', id: 'foyer' };
        },
        expectedGraphChange: true,
      },
    ]);
    expect(results.map((item) => item.graphChanged)).toEqual([false, true, true]);
    expect(results.map((item) => item.incrementallyReplacedContributionKeys.length)).toEqual([
      0, 1, 1,
    ]);
    expect(
      graphSnapshot(
        assembleAuthoringDependencyGraph(
          buildAuthoringStructuralDependencyGraphContributionSet(project),
        ),
      ),
    ).toEqual(graphSnapshot(buildAuthoringStructuralDependencyGraph(project)));
  });

  it('builds a representative large structural project deterministically', () => {
    const project = createAuthoringProject();
    project.assets.background = {
      id: 'background',
      label: 'Background',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'images/background.png' },
        aliases: [],
        imageMetadata: { width: 1920, height: 1080, hasAlpha: false, orientation: 1 },
      },
    };
    for (let index = 0; index < 500; index += 1) {
      const id = `room-${index.toString().padStart(4, '0')}`;
      const data = defaultRoomData(id);
      data.background.asset = { $ref: { collection: 'assets', id: 'background' } };
      project.rooms[id] = { id, label: id, data };
    }

    const startedAt = performance.now();
    const first = buildAuthoringStructuralDependencyGraph(project);
    const elapsedMs = performance.now() - startedAt;
    const second = buildAuthoringStructuralDependencyGraph(project);
    expect(graphSnapshot(first)).toEqual(graphSnapshot(second));
    expect(first.nodesByKey.size).toBeGreaterThanOrEqual(501);
    expect(first.edgesById.size).toBeGreaterThanOrEqual(500);
    console.info(
      `AUTHORING_STRUCTURAL_GRAPH_BENCHMARK rooms=500 nodes=${first.nodesByKey.size} edges=${first.edgesById.size} elapsedMs=${elapsedMs.toFixed(2)}`,
    );
  });
});
