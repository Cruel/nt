import { describe, expect, it } from 'vite-plus/test';
import {
  AUTHORING_INTRINSIC_GRAPH_INPUTS,
  AUTHORING_STRUCTURAL_ADAPTER_DECLARATIONS,
  assembleAuthoringDependencyGraph,
  authoringDependencyForwardClosure,
  authoringDependencyReverseImpactClosure,
  buildAuthoringStructuralDependencyGraph,
  createAuthoringDependencyEdgeId,
  createAuthoringDependencyGraphContributionSet,
  findAuthoringDependencyOwnersByPath,
  findAuthoringDependencyUsages,
  findMissingAuthoringDependencyTargets,
  findNestedAuthoringDependencyTarget,
  findPreviewRootsImpactedByPathUnion,
  findPreviewRootsImpactedByPaths,
  nestedNodeKey,
  outgoingAuthoringDependencies,
  recordNodeKey,
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
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import { authoringCollectionKeys } from '../../shared/project-schema/authoring-collections';
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
  };
  return {
    id: createAuthoringDependencyEdgeId(partial),
    ...partial,
    role,
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
    const typed = edge(room.key, character.key, '/rooms/foyer/data/cast/0', 'room-cast-character', [
      'reference-integrity',
      'preview-visual',
    ]);
    const graph = assembleAuthoringDependencyGraph([
      contribution('generic', [room], [generic]),
      contribution('typed', [room, character], [typed]),
    ]);
    expect([...graph.edgesById.values()]).toHaveLength(1);
    expect([...graph.edgesById.values()][0]).toMatchObject({
      role: 'room-cast-character',
      facets: ['preview-visual', 'reference-integrity'],
    });

    expect(() =>
      assembleAuthoringDependencyGraph([
        contribution('left', [room]),
        contribution('right', [{ ...room, label: 'Different' }]),
      ]),
    ).toThrow(/Conflicting graph node ownership or metadata/);
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
    const replacement = createAuthoringDependencyGraphContributionSet([
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
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData() };
    project.rooms.foyer.data.placements.push({
      id: 'door',
      bounds: { x: 0, y: 0, width: 0.2, height: 0.2 },
      presentation: { label: null, layout: null },
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

    const graph = buildAuthoringStructuralDependencyGraph(project);
    expect(
      findAuthoringDependencyUsages(graph, recordNodeKey('assets', 'background')).map(
        (usage) => usage.role,
      ),
    ).toEqual(['default-font', 'room-background']);
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

  it('declares every collection adapter and intrinsic collection graph input', () => {
    expect(AUTHORING_STRUCTURAL_ADAPTER_DECLARATIONS.map((item) => item.collection)).toEqual(
      authoringCollectionKeys,
    );
    for (const collection of authoringCollectionKeys) {
      expect(AUTHORING_INTRINSIC_GRAPH_INPUTS).toContainEqual({
        path: `/${collection}`,
        effect: { kind: 'structural' },
      });
    }
    expect(AUTHORING_INTRINSIC_GRAPH_INPUTS).toEqual(
      expect.arrayContaining([
        { path: '/startupHook', effect: { kind: 'source-analysis' } },
        { path: '/properties', effect: { kind: 'structural' } },
        { path: '/localization/catalogs', effect: { kind: 'structural' } },
        { path: '/settings/text/defaultFont', effect: { kind: 'owner-contribution' } },
      ]),
    );
  });

  it('audits representative stable and structural graph inputs against fresh full builds', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData() };
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
        name: 'entrypoint relationship changes graph',
        path: '/entrypoint',
        mutate(current) {
          current.entrypoint = { kind: 'room', id: 'foyer' };
        },
        expectedGraphChange: true,
      },
    ]);
    expect(results.map((item) => item.graphChanged)).toEqual([false, true]);
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
