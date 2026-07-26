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
import { assetDeleteAssetCommand } from '../commands/builtin-commands';
import { useCommandStore } from '../commands/command-store';
import { useProjectStore } from '../project/project-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { toJsonValue } from '../project/json-value';

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
    repair: { kind: 'clear-field', path: '/rooms/foyer/data/background/asset' },
  };
}

describe('Phase 6 graph consumers and structural preflight', () => {
  beforeEach(() => {
    useProjectStore.getState().clearProject();
    useCommandStore.getState().resetCommandHistory();
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
    expect(useProjectStore.getState().admittedProject?.rooms.foyer?.data.placements).toHaveLength(1);
  });

  it('fails closed for unsupported property-definition deletion', () => {
    const project = createAuthoringProject();
    project.properties.mood = {
      id: 'mood',
      label: 'Mood',
      type: 'string',
      nullable: false,
      persistence: 'Save',
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

  it('uses the current graph compatibility projection for Asset delete and preserves force delete', () => {
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
    ).toMatchObject({ patches: [], diagnostics: [{ severity: 'error' }] });
    expect(
      assetDeleteAssetCommand({
        ...base,
        payload: { assetId: 'background', force: true },
        request: { ...request, payload: { assetId: 'background', force: true } },
      }),
    ).toMatchObject({ patches: [{ op: 'remove', path: '/assets/background' }] });
  });
});
