import { describe, expect, it } from 'vite-plus/test';
import type {
  AuthoringDependencyEdge,
  AuthoringDependencyGraphSnapshot,
} from '../../shared/authoring-dependency-contracts';
import {
  preflightGraphCommand,
  preflightRoomPlacementDeletion,
  semanticUsagesForTarget,
} from '../project/authoring-graph-consumers';

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
              occurrence: {
                sourcePath: '/scripts/startup/data/source',
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

describe('Phase 6 graph consumers and structural preflight', () => {
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
      ambiguousGroup: '/scripts/startup/data/source:/rooms/hall',
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

  it('fails closed when deleting a referenced Room placement', () => {
    const target = {
      kind: 'nested' as const,
      ownerCollection: 'rooms' as const,
      ownerId: 'hall',
      family: 'room-placement' as const,
      id: 'door',
    };
    const current = snapshot([edge('placement:1', 'character-room-placement', target)]);
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
});
