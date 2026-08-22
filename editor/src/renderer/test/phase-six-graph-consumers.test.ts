import { beforeEach, describe, expect, it } from 'vite-plus/test';
import type {
  AuthoringDependencyEdge,
  AuthoringDependencyGraphSnapshot,
} from '../../shared/authoring-dependency-contracts';
import {
  preflightGraphCommand,
  preflightRoomPlacementDeletion,
  semanticUsagesForTarget,
} from '../project/authoring-graph-consumers';
import {
  assetDeleteAssetCommand,
  entityRenameIdCommand,
  projectRemoveAtPathCommand,
} from '../commands/builtin-commands';
import { useCommandStore } from '../commands/command-store';
import { useProjectStore } from '../project/project-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import { toJsonValue } from '../project/json-value';
import {
  authoringRepairEdgesForTarget,
  generateAuthoringRepairPlan,
  recordTarget,
} from '../project/authoring-repair';
import {
  classifyAuthoringLiteralEvidence,
  nestedNodeKey,
  recordNodeKey,
  serializeAuthoringDependencyNodeKey,
} from '../../shared/authoring-dependency-graph';

function snapshot(edges: readonly AuthoringDependencyEdge[]): AuthoringDependencyGraphSnapshot {
  return {
    projectInstanceId: 'project:phase-six',
    projectRevision: 7,
    graphRevision: 3,
    graph: {
      nodesByKey: new Map(),
      edgesById: new Map(edges.map((edge) => [edge.id, edge])),
      outgoingEdgeIdsByNodeKey: new Map(),
      incomingEdgeIdsByNodeKey: new Map(),
      sourceNodeKeysByOwnedPath: new Map(),
      diagnostics: [],
    },
  };
}

function edge(
  id: string,
  role: AuthoringDependencyEdge['role'],
  target: AuthoringDependencyEdge['target'] = { kind: 'record', collection: 'rooms', id: 'hall' },
): AuthoringDependencyEdge {
  return {
    id,
    source: { kind: 'record', collection: 'scripts', id: 'startup' },
    target,
    sourcePath: '/scripts/startup/data/source',
    targetPath: '/rooms/hall',
    role,
    facets: role === 'lua-possible-reference' ? ['validation'] : ['tooling-reference'],
    targetImpactPaths: ['/rooms/hall'],
    repair:
      role === 'lua-possible-reference'
        ? { kind: 'warning-only', reason: 'Ambiguous lexical occurrence.' }
        : { kind: 'blocked', reason: 'Explicit Lua fallback.' },
    evidence:
      role === 'lua-possible-reference'
        ? [
            {
              kind: 'lua-occurrence',
              classification: 'possible-lexical',
              occurrence: {
                sourcePath: '/scripts/startup/data/source',
                sourceUrl: 'project:/scripts/startup.lua',
                sourceContentHash: `sha256:${'0'.repeat(64)}`,
                regionOrdinal: 0,
                regionStartUtf16: 0,
                regionEndUtf16: 20,
                line: 4,
                column: 12,
                rawLiteral: '"hall"',
                decodedValue: 'hall',
                literalKind: 'double-quoted',
                sourceKind: 'lua-field',
                confidence: 'lexical',
                candidateTargets: [target],
              },
            },
          ]
        : [
            {
              kind: 'explicit-lua-fallback',
              declarationPath: '/scripts/startup/data/dependencies',
            },
          ],
  };
}

function confirmedAssetEdge(): AuthoringDependencyEdge {
  return {
    id: 'asset:1',
    source: { kind: 'record', collection: 'rooms', id: 'foyer' },
    target: { kind: 'record', collection: 'assets', id: 'background' },
    sourcePath: '/rooms/foyer/data/background/asset/$ref',
    targetPath: '/assets/background',
    role: 'room-background',
    facets: ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
    targetImpactPaths: ['/rooms/foyer'],
    repair: { kind: 'set-null', path: '/rooms/foyer/data/background/asset' },
  };
}

describe('Phase 6 graph consumers and structural preflight', () => {
  beforeEach(() => {
    useProjectStore.getState().clearProject();
    useCommandStore.getState().resetCommandHistory();
  });

  it('recognizes Script Module imports and typed gameplay identity references as exact tooling edges', () => {
    const project = createAuthoringProject();
    project.scripts.shared = {
      id: 'shared',
      label: 'Shared',
      data: { kind: 'script-module', source: { kind: 'inline-lua', source: 'return {}' } },
    };
    project.rooms.hall = { id: 'hall', label: 'Hall', data: defaultRoomData('Hall') };
    const classify = (source: string, literal: string, decodedValue: string) => {
      const start = source.indexOf(literal);
      return classifyAuthoringLiteralEvidence(
        project,
        {
          sourcePath: '/scripts/bootstrap/data/source/source',
          sourceUrl: 'authoring:inline-lua',
          sourceContentHash: `sha256:${'1'.repeat(64)}`,
          regionOrdinal: 0,
          regionStartUtf16: start,
          regionEndUtf16: start + literal.length,
          line: 1,
          column: start + 1,
          rawLiteral: literal,
          decodedValue,
          literalKind: 'single-quoted',
          sourceKind: 'lua-field',
        },
        {
          semanticOwner: { kind: 'record', collection: 'scripts', id: 'bootstrap' },
          sourceKind: 'lua-field',
          sourcePath: '/scripts/bootstrap/data/source/source',
          sourceUrl: 'authoring:inline-lua',
          containerContentHash: `sha256:${'1'.repeat(64)}`,
          regionOrdinal: 0,
          containerLine: 1,
          containerColumn: 1,
          decodedSource: source,
        },
      );
    };

    expect(classify("import('shared')", "'shared'", 'shared')).toMatchObject({
      classification: 'exact-rewriteable',
      recognizedBy: 'noveltea.script-module-import',
      occurrence: {
        candidateTargets: [{ kind: 'record', collection: 'scripts', id: 'shared' }],
      },
    });
    expect(classify("noveltea.project.room('hall')", "'hall'", 'hall')).toMatchObject({
      classification: 'exact-rewriteable',
      recognizedBy: 'noveltea.gameplay-identity',
      occurrence: {
        candidateTargets: [{ kind: 'record', collection: 'rooms', id: 'hall' }],
      },
    });
  });

  it('fails closed when the graph is stale or unavailable', () => {
    expect(
      preflightGraphCommand({
        snapshot: null,
        projectInstanceId: 'project:phase-six',
        projectRevision: 7,
        target: { collection: 'rooms', id: 'hall' },
        operation: 'delete',
      }),
    ).toMatchObject({ kind: 'blocked' });
    expect(
      preflightGraphCommand({
        snapshot: snapshot([]),
        projectInstanceId: 'project:phase-six',
        projectRevision: 8,
        target: { collection: 'rooms', id: 'hall' },
        operation: 'rename',
      }),
    ).toMatchObject({ kind: 'blocked' });
  });

  it('warns for possible Lua references and preserves grouped source locations', () => {
    const current = snapshot([edge('possible:1', 'lua-possible-reference')]);
    const usages = semanticUsagesForTarget(current, { collection: 'rooms', id: 'hall' });
    expect(usages[0]).toMatchObject({
      label: 'Lua Possible Reference',
      sourceLocation: { line: 4, column: 12, endLine: 4, endColumn: 18 },
      ambiguousGroup: 'project:/scripts/startup.lua:/rooms/hall',
    });
    expect(
      preflightGraphCommand({
        snapshot: current,
        projectInstanceId: 'project:phase-six',
        projectRevision: 7,
        target: { collection: 'rooms', id: 'hall' },
        operation: 'rename',
      }),
    ).toMatchObject({ kind: 'ready', warnings: [{ role: 'lua-possible-reference' }] });
  });

  it('requires explicit rename confirmation and blocks ordinary deletion while preserving force', () => {
    const current = snapshot([edge('explicit:1', 'lua-explicit-reference')]);
    const base = {
      snapshot: current,
      projectInstanceId: 'project:phase-six',
      projectRevision: 7,
      target: { collection: 'rooms' as const, id: 'hall' },
    };
    expect(preflightGraphCommand({ ...base, operation: 'rename' })).toMatchObject({
      kind: 'blocked',
    });
    expect(
      preflightGraphCommand({
        ...base,
        operation: 'rename',
        confirmRenameWithoutLuaRewrite: true,
      }),
    ).toMatchObject({ kind: 'ready' });
    expect(preflightGraphCommand({ ...base, operation: 'delete' })).toMatchObject({
      kind: 'blocked',
    });
    expect(preflightGraphCommand({ ...base, operation: 'delete', force: true })).toMatchObject({
      kind: 'ready',
    });
  });

  it('rewrites only exact recognized source ranges during entity rename', () => {
    const project = createAuthoringProject();
    project.rooms.shared = {
      id: 'shared',
      label: 'Shared',
      data: defaultRoomData('Shared'),
    };
    project.scripts.bootstrap!.data = {
      kind: 'script-module',
      source: {
        kind: 'inline-lua',
        source: `future_ref('shared'); local note = 'shared'`,
      },
    };
    const target = { kind: 'record', collection: 'rooms', id: 'shared' } as const;
    const exact: AuthoringDependencyEdge = {
      ...edge('exact:1', 'lua-recognized-reference', target),
      source: { kind: 'record', collection: 'scripts', id: 'bootstrap' },
      sourcePath: '/scripts/bootstrap/data/source/source',
      repair: {
        kind: 'warning-only',
        reason: 'Recognized source reference is safely rewriteable.',
      },
      evidence: [
        {
          kind: 'lua-occurrence',
          classification: 'exact-rewriteable',
          recognizedBy: 'test.future-reference',
          rewriteRange: { startUtf16: 12, endUtf16: 18, expectedText: 'shared' },
          occurrence: {
            sourcePath: '/scripts/bootstrap/data/source/source',
            sourceUrl: 'authoring:inline-lua',
            sourceContentHash: `sha256:${'1'.repeat(64)}`,
            regionOrdinal: 0,
            regionStartUtf16: 11,
            regionEndUtf16: 19,
            line: 1,
            column: 12,
            rawLiteral: "'shared'",
            decodedValue: 'shared',
            literalKind: 'single-quoted',
            sourceKind: 'lua-field',
            confidence: 'api-context',
            candidateTargets: [target],
          },
        },
      ],
    };
    const possible: AuthoringDependencyEdge = {
      ...edge('possible:2', 'lua-possible-reference', target),
      source: { kind: 'record', collection: 'scripts', id: 'bootstrap' },
      sourcePath: '/scripts/bootstrap/data/source/source',
      evidence: [
        {
          kind: 'lua-occurrence',
          classification: 'possible-lexical',
          occurrence: {
            sourcePath: '/scripts/bootstrap/data/source/source',
            sourceUrl: 'authoring:inline-lua',
            sourceContentHash: `sha256:${'1'.repeat(64)}`,
            regionOrdinal: 0,
            regionStartUtf16: 34,
            regionEndUtf16: 42,
            line: 1,
            column: 35,
            rawLiteral: "'shared'",
            decodedValue: 'shared',
            literalKind: 'single-quoted',
            sourceKind: 'lua-field',
            confidence: 'lexical',
            candidateTargets: [target],
          },
        },
      ],
    };
    const result = entityRenameIdCommand({
      document: toJsonValue(project),
      savedDocument: null,
      payload: { collection: 'rooms', fromId: 'shared', toId: 'renamed' },
      request: {} as never,
      graphSnapshot: snapshot([exact, possible]),
      projectInstanceId: 'project:phase-six',
      projectRevision: 7,
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        message: expect.stringContaining('possible Lua'),
      }),
    ]);
    expect(result.patches).toContainEqual({
      op: 'replace',
      path: '/scripts/bootstrap/data/source/source',
      value: `future_ref('renamed'); local note = 'shared'`,
    });
    expect(
      preflightGraphCommand({
        snapshot: snapshot([exact]),
        projectInstanceId: 'project:phase-six',
        projectRevision: 7,
        target,
        operation: 'delete',
      }),
    ).toMatchObject({ kind: 'blocked' });
  });

  it('rewrites every exact occurrence collapsed into one graph edge', () => {
    const project = createAuthoringProject();
    project.rooms.shared = {
      id: 'shared',
      label: 'Shared',
      data: defaultRoomData('Shared'),
    };
    project.scripts.bootstrap!.data = {
      kind: 'script-module',
      source: { kind: 'inline-lua', source: `future_ref('shared'); future_ref('shared')` },
    };
    const target = { kind: 'record', collection: 'rooms', id: 'shared' } as const;
    const exact: AuthoringDependencyEdge = {
      ...edge('exact:collapsed', 'lua-recognized-reference', target),
      source: { kind: 'record', collection: 'scripts', id: 'bootstrap' },
      sourcePath: '/scripts/bootstrap/data/source/source',
      repair: {
        kind: 'warning-only',
        reason: 'Recognized source reference is safely rewriteable.',
      },
      evidence: [
        {
          kind: 'lua-occurrence',
          classification: 'exact-rewriteable',
          recognizedBy: 'test.future-reference',
          rewriteRange: { startUtf16: 12, endUtf16: 18, expectedText: 'shared' },
          occurrence: {
            sourcePath: '/scripts/bootstrap/data/source/source',
            sourceUrl: 'authoring:inline-lua',
            sourceContentHash: `sha256:${'1'.repeat(64)}`,
            regionOrdinal: 0,
            regionStartUtf16: 11,
            regionEndUtf16: 19,
            line: 1,
            column: 12,
            rawLiteral: "'shared'",
            decodedValue: 'shared',
            literalKind: 'single-quoted',
            sourceKind: 'lua-field',
            confidence: 'api-context',
            candidateTargets: [target],
          },
        },
        {
          kind: 'lua-occurrence',
          classification: 'exact-rewriteable',
          recognizedBy: 'test.future-reference',
          rewriteRange: { startUtf16: 34, endUtf16: 40, expectedText: 'shared' },
          occurrence: {
            sourcePath: '/scripts/bootstrap/data/source/source',
            sourceUrl: 'authoring:inline-lua',
            sourceContentHash: `sha256:${'1'.repeat(64)}`,
            regionOrdinal: 0,
            regionStartUtf16: 33,
            regionEndUtf16: 41,
            line: 1,
            column: 34,
            rawLiteral: "'shared'",
            decodedValue: 'shared',
            literalKind: 'single-quoted',
            sourceKind: 'lua-field',
            confidence: 'api-context',
            candidateTargets: [target],
          },
        },
      ],
    };
    const result = entityRenameIdCommand({
      document: toJsonValue(project),
      savedDocument: null,
      payload: { collection: 'rooms', fromId: 'shared', toId: 'renamed' },
      request: {} as never,
      graphSnapshot: snapshot([exact]),
      projectInstanceId: 'project:phase-six',
      projectRevision: 7,
    });
    expect(result.patches).toContainEqual({
      op: 'replace',
      path: '/scripts/bootstrap/data/source/source',
      value: `future_ref('renamed'); future_ref('renamed')`,
    });
  });

  it('fails closed when deleting a referenced Room placement', () => {
    const target = {
      kind: 'nested' as const,
      ownerCollection: 'rooms' as const,
      ownerId: 'hall',
      family: 'room-placement' as const,
      id: 'door',
    };
    const current = snapshot([edge('placement:1', 'explicit-ref', target)]);
    expect(
      preflightRoomPlacementDeletion({
        snapshot: current,
        projectInstanceId: 'project:phase-six',
        projectRevision: 7,
        roomId: 'hall',
        placementId: 'door',
      }),
    ).toMatchObject({ kind: 'blocked' });
  });

  it('does not rewrite semantic Room Location when deleting unrelated presentation placement', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Hall');
    room.placements = [
      {
        id: 'door',
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        presentation: { label: null, layout: null },
      },
    ];
    project.rooms.hall = { id: 'hall', label: 'Hall', data: room };
    const character = defaultCharacterData('Alice');
    character.initialWorldState.location = {
      kind: 'room',
      room: { $ref: { collection: 'rooms', id: 'hall' } },
    };
    project.characters.alice = { id: 'alice', label: 'Alice', data: character };
    const current = snapshot([]);
    const result = projectRemoveAtPathCommand({
      document: toJsonValue(project),
      savedDocument: null,
      graphSnapshot: current,
      projectInstanceId: current.projectInstanceId,
      projectRevision: current.projectRevision,
      payload: { path: '/rooms/hall/data/placements/0' },
      request: {
        type: 'project.removeAtPath',
        payload: { path: '/rooms/hall/data/placements/0' },
        originSaveUnitId: 'record:rooms:hall',
        persistencePolicy: 'manual-save',
      },
    });
    expect(result.patches).toEqual([{ op: 'remove', path: '/rooms/hall/data/placements/0' }]);
    expect(result.diagnostics).toBeUndefined();
  });

  it('plans selected replacements and Room-descendant placement repairs atomically', () => {
    const exitEdge: AuthoringDependencyEdge = {
      ...edge('exit:replacement', 'room-exit-target', recordTarget('rooms', 'hall')),
      source: { kind: 'record', collection: 'rooms', id: 'foyer' },
      sourcePath: '/rooms/foyer/data/exits/0/target/$ref',
      facets: ['reference-integrity', 'tooling-reference'],
      repair: {
        kind: 'replacement-required',
        path: '/rooms/foyer/data/exits/0/target/$ref',
        collection: 'rooms',
      },
    };
    const placementTarget = {
      kind: 'nested' as const,
      ownerCollection: 'rooms' as const,
      ownerId: 'hall',
      family: 'room-placement' as const,
      id: 'door',
    };
    const placementEdge: AuthoringDependencyEdge = {
      ...edge('placement:room-delete', 'explicit-ref', placementTarget),
      source: { kind: 'record', collection: 'interactions', id: 'unlock' },
      sourcePath: '/interactions/unlock/data/rules/0/context/placement',
      facets: ['reference-integrity', 'tooling-reference', 'preview-visual'],
      repair: {
        kind: 'blocked',
        reason: 'Room-placement context requires an explicit replacement.',
      },
    };
    const atticKey = recordNodeKey('rooms', 'attic');
    const atticKeyText = serializeAuthoringDependencyNodeKey(atticKey);
    const placementKey = nestedNodeKey('rooms', 'hall', 'room-placement', 'door');
    const placementKeyText = serializeAuthoringDependencyNodeKey(placementKey);
    const baseSnapshot = snapshot([exitEdge, placementEdge]);
    const current: AuthoringDependencyGraphSnapshot = {
      ...baseSnapshot,
      graph: {
        ...baseSnapshot.graph,
        nodesByKey: new Map([
          [
            atticKeyText,
            {
              key: atticKey,
              keyText: atticKeyText,
              owningPath: '/rooms/attic' as const,
              label: 'Attic',
            },
          ],
          [
            placementKeyText,
            {
              key: placementKey,
              keyText: placementKeyText,
              owningPath: '/rooms/hall/data/placements/0' as const,
              label: 'Door',
            },
          ],
        ]),
      },
    };
    const result = generateAuthoringRepairPlan({
      snapshot: current,
      projectInstanceId: current.projectInstanceId,
      projectRevision: current.projectRevision,
      target: recordTarget('rooms', 'hall'),
      deletePath: '/rooms/hall',
      replacements: { [exitEdge.id]: 'attic' },
    });
    expect(result).toMatchObject({
      status: 'blocked',
      reason: 'Room-placement context requires an explicit replacement.',
    });
    expect(
      authoringRepairEdgesForTarget(current, recordTarget('rooms', 'hall')).map((item) => item.id),
    ).toEqual(['exit:replacement', 'placement:room-delete']);
  });

  it('fails closed for replacement encodings that are not explicitly supported', () => {
    const unsupported: AuthoringDependencyEdge = {
      ...edge('variable:unsupported', 'variable-ref', recordTarget('variables', 'score')),
      source: { kind: 'record', collection: 'scenes', id: 'intro' },
      sourcePath: '/scenes/intro/data/condition/$var',
      repair: {
        kind: 'blocked',
        reason: 'This reference role has no safe automatic repair encoding.',
      },
    };
    const current = snapshot([unsupported]);
    expect(
      generateAuthoringRepairPlan({
        snapshot: current,
        projectInstanceId: current.projectInstanceId,
        projectRevision: current.projectRevision,
        target: recordTarget('variables', 'score'),
        deletePath: '/variables/score',
      }),
    ).toEqual({
      status: 'blocked',
      reason: 'This reference role has no safe automatic repair encoding.',
    });
  });

  it('cannot bypass rename/delete preflight before the graph service is started', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    expect(useProjectStore.getState().loadUnsavedProjectDocument(project)).toBe(true);

    const result = useCommandStore.getState().executeCommand({
      type: 'entity.deleteRecord',
      payload: { collection: 'rooms', entityId: 'foyer' },
      originSaveUnitId: 'record:rooms:foyer',
      persistencePolicy: 'manual-save',
    });
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        { message: 'The dependency graph is not ready for the current project revision.' },
      ],
    });
    expect(useProjectStore.getState().admittedProject?.rooms.foyer).toBeDefined();
  });

  it('cannot bypass structural preflight through generic patch commands', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'door',
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        presentation: { label: null, layout: null },
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    expect(useProjectStore.getState().loadUnsavedProjectDocument(project)).toBe(true);

    const removeRecord = useCommandStore.getState().executeCommand({
      type: 'project.removeAtPath',
      payload: { path: '/rooms/foyer' },
      originSaveUnitId: 'record:rooms:foyer',
      persistencePolicy: 'manual-save',
    });
    expect(removeRecord).toMatchObject({
      ok: false,
      diagnostics: [
        { message: 'The dependency graph is not ready for the current project revision.' },
      ],
    });

    const removePlacement = useCommandStore.getState().executeCommand({
      type: 'project.removeAtPath',
      payload: { path: '/rooms/foyer/data/placements/0' },
      originSaveUnitId: 'record:rooms:foyer',
      persistencePolicy: 'manual-save',
    });
    expect(removePlacement).toMatchObject({
      ok: false,
      diagnostics: [
        { message: 'The dependency graph is not ready for the current project revision.' },
      ],
    });

    const replaceRecord = useCommandStore.getState().executeCommand({
      type: 'entity.replaceRecord',
      payload: {
        collection: 'rooms',
        entityId: 'foyer',
        record: { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') },
      },
      originSaveUnitId: 'record:rooms:foyer',
      persistencePolicy: 'manual-save',
    });
    expect(replaceRecord).toMatchObject({
      ok: false,
      diagnostics: [
        { message: 'The dependency graph is not ready for the current project revision.' },
      ],
    });
    expect(useProjectStore.getState().admittedProject?.rooms.foyer?.data.placements).toHaveLength(
      1,
    );
  });

  it('fails closed for unsupported property-definition deletion', () => {
    const project = createAuthoringProject();
    project.properties.mood = {
      id: 'mood',
      label: 'Mood',
      type: 'string',
      nullable: false,
      ownerKinds: ['room'],
      defaultValue: 'neutral',
    };
    expect(useProjectStore.getState().loadUnsavedProjectDocument(project)).toBe(true);

    const result = useCommandStore.getState().executeCommand({
      type: 'project.removeAtPath',
      payload: { path: '/properties/mood' },
      originSaveUnitId: 'project-settings',
      persistencePolicy: 'manual-save',
    });
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        {
          message:
            'Property-definition deletion is not supported by the current graph-aware structural command path.',
        },
      ],
    });
    expect(useProjectStore.getState().admittedProject?.properties.mood).toBeDefined();
  });

  it('uses graph repair descriptors for Asset delete and preserves Force Delete', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    project.assets.background = {
      id: 'background',
      label: 'Background',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/images/background.png' },
        aliases: [],
        extension: '.png',
        imageMetadata: { width: 1920, height: 1080, hasAlpha: false, orientation: 1 },
      },
    };
    const current = snapshot([confirmedAssetEdge()]);
    const request = {
      type: 'asset.deleteAsset',
      originSaveUnitId: 'record:assets:background',
      persistencePolicy: 'manual-save' as const,
    };
    const base = {
      document: toJsonValue(project),
      savedDocument: null,
      graphSnapshot: current,
      projectInstanceId: current.projectInstanceId,
      projectRevision: current.projectRevision,
    };

    expect(
      assetDeleteAssetCommand({
        ...base,
        payload: { assetId: 'background' },
        request: { ...request, payload: { assetId: 'background' } },
      }),
    ).toMatchObject({
      patches: [
        { op: 'remove', path: '/assets/background' },
        { op: 'replace', path: '/rooms/foyer/data/background/asset', value: null },
      ],
    });
    expect(
      assetDeleteAssetCommand({
        ...base,
        payload: { assetId: 'background', force: true },
        request: { ...request, payload: { assetId: 'background', force: true } },
      }),
    ).toMatchObject({ patches: [{ op: 'remove', path: '/assets/background' }] });
  });
});
