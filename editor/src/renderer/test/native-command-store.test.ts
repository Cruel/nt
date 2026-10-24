import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { useProjectStore } from '../project/project-store';
import { toJsonValue, type JsonValue } from '../project/json-value';
import { applyJsonPatch } from '../project/json-patch';
import { getJsonAtPointer, hasJsonAtPointer } from '../project/json-pointer';
import { nativeLocalizationFragmentPatches, useCommandStore } from '../commands/command-store';
import {
  confirmNativeCommand,
  nativeLocalizationTarget,
} from '../commands/native-command-execution';
import { createInitialCommandBusState, executeCommand } from '../commands/command-bus';
import { resolveProjectComments } from '../project/project-comment-confirmation';
import { startAuthoringDependencyGraphService } from '../project/authoring-dependency-graph-runtime';
import { nativeRendererGraphService } from '../project/native-authoring-graph-runtime';

const sessionId = '5b33af83-d804-444c-b0dc-e8f10e4d03a0';
const newSessionId = 'ed60bb33-e19e-4569-bf3c-08ab72bef3c4';

function projectName() {
  return (useProjectStore.getState().document as { project: { name: string } }).project.name;
}

function setProject(name = 'Saved Project', id = sessionId) {
  const project = toJsonValue(createAuthoringProject({ id: 'native-command', name }));
  expect(
    useProjectStore.getState().loadProjectDocument({
      document: project,
      savedDocument: project,
      projectPath: '/fixture/native-command',
      projectFilePath: '/fixture/native-command/project.yaml',
      projectSessionId: id,
      scriptSourcePaths: {},
    }),
  ).toBe(true);
  useCommandStore.getState().resetCommandHistory();
}

function request(name: string) {
  return {
    type: 'project.replaceAtPath',
    payload: { path: '/project/name', value: name },
    originSaveUnitId: 'project:settings',
    persistencePolicy: 'manual-save' as const,
  };
}

function nativeAck(name: string, revision: number, accepted = true) {
  return {
    accepted,
    error: accepted ? '' : 'Native record mutation rejected',
    snapshot: {
      workingRevision: revision,
      diskSourceRevision: 'sha256:' + '0'.repeat(64),
      source: { project: { name } },
      normalized: { project: { name } },
      dirty: true,
      valid: true,
      diagnostics: [],
      inventory: [],
    },
    affectedRecords: ['project'],
    diagnosticsAdded: [],
    diagnosticsRemoved: [],
  };
}

describe('native-backed renderer commands', () => {
  it('expands a whole translation collection into one batch of per-locale source patches', () => {
    const previous = { localization: { translations: { fr: { a: { text: 'Old' } }, de: {} } } };
    const proposed = { localization: { translations: { fr: { a: { text: 'New' } }, es: {} } } };
    expect(
      nativeLocalizationFragmentPatches(
        [
          {
            op: 'replace',
            path: '/localization/translations',
            value: proposed.localization.translations,
          },
        ],
        previous,
        proposed,
      ),
    ).toEqual([
      { op: 'remove', path: '/localization/translations/de' },
      { op: 'add', path: '/localization/translations/es', value: {} },
      { op: 'replace', path: '/localization/translations/fr', value: { a: { text: 'New' } } },
    ]);
    expect(nativeLocalizationTarget('/localization/translations/es')).toEqual({
      owner: 'i18n/locales/es.yaml',
      relative: '/',
    });
    expect(nativeLocalizationTarget('/localization/assets/es')).toEqual({
      owner: 'i18n/assets/es.yaml',
      relative: '/',
    });
  });
  it('journals copied Asset trash on undo and restores its exact native move on redo', async () => {
    const asset = {
      originalPath: '/tmp/logo.png',
      originalName: 'logo.png',
      projectRelativePath: 'assets/images/logo.png',
      kind: 'image' as const,
      extension: '.png',
      mimeType: 'image/png',
      byteSize: 4,
      contentHash: `sha256:${'0'.repeat(64)}`,
      importedAt: '2026-07-19T00:00:00.000Z',
      imageMetadata: { width: 256, height: 256, hasAlpha: true, orientation: 1 },
    };
    const move = {
      projectRelativePath: asset.projectRelativePath,
      trashRelativePath: '.noveltea/trash/assets/native-test/assets/images/logo.png',
    };
    let nativeDocument: JsonValue = useProjectStore.getState().document!;
    let revision = 0;
    let affected = '';
    const ack = () => ({
      ...nativeAck('Saved Project', revision),
      affectedRecords: [affected],
      snapshot: {
        ...nativeAck('Saved Project', revision).snapshot,
        source: nativeDocument,
        recordSnapshots: hasJsonAtPointer(nativeDocument, '/assets/logo')
          ? { [affected]: { source: getJsonAtPointer(nativeDocument, '/assets/logo') } }
          : {},
      },
    });
    const patch = vi.fn(
      async (_session: string, expected: number, patches: Parameters<typeof applyJsonPatch>[1]) => {
        expect(expected).toBe(revision);
        nativeDocument = applyJsonPatch(nativeDocument, patches).document;
        revision++;
        affected = 'assets/logo';
        return ack();
      },
    );
    const save = vi.fn(
      async (
        _session: string,
        expected: number,
        _ids: string[],
        options: {
          assetTransition?: {
            kind: string;
            projectRelativePaths?: string[];
            moves?: (typeof move)[];
          };
        },
      ) => {
        expect(expected).toBe(revision);
        revision++;
        return {
          ...ack(),
          ...(options.assetTransition?.kind === 'trash' ? { assetTrashMoves: [move] } : {}),
        };
      },
    );
    Object.defineProperty(window.noveltea, 'nativeProjectPatch', {
      configurable: true,
      value: patch,
    });
    Object.defineProperty(window.noveltea, 'nativeProjectSaveUnit', {
      configurable: true,
      value: save,
    });
    const imported = await useCommandStore.getState().executeCommandAsync({
      type: 'asset.importFiles',
      label: 'Import native Asset',
      payload: { assets: [asset], fileOrigin: 'copied-by-import' },
      originSaveUnitId: 'workflow:asset-import',
      persistencePolicy: 'auto-commit',
    });
    expect(imported.ok, JSON.stringify(imported.diagnostics)).toBe(true);
    expect(save.mock.calls[0]?.[3].assetTransition).toEqual({
      kind: 'publish',
      projectRelativePaths: [asset.projectRelativePath],
    });
    expect((await useCommandStore.getState().undoAsync()).ok).toBe(true);
    expect(save.mock.calls[1]?.[3].assetTransition).toEqual({
      kind: 'trash',
      projectRelativePaths: [asset.projectRelativePath],
    });
    expect((await useCommandStore.getState().redoAsync()).ok).toBe(true);
    expect(save.mock.calls[2]?.[3].assetTransition).toEqual({ kind: 'restore', moves: [move] });
    expect(useProjectStore.getState().savedDocument).toMatchObject({ assets: { logo: {} } });
  });

  it('auto-commits structural creation, undo, and redo only after a native scoped Save', async () => {
    const createdId = 'native-structural-room';
    let nativeDocument: JsonValue = useProjectStore.getState().document!;
    let nativeRevision = 0;
    let requireDeleteCommentApproval = false;
    let lastAffected: string[] = [];
    const ack = () => ({
      ...nativeAck('Saved Project', nativeRevision),
      snapshot: {
        ...nativeAck('Saved Project', nativeRevision).snapshot,
        source: nativeDocument,
        recordSnapshots: Object.fromEntries(
          lastAffected.flatMap((owner) =>
            owner === 'i18n/messages.yaml'
              ? [
                  [
                    owner,
                    {
                      source: {
                        messages: getJsonAtPointer(nativeDocument, '/localization/messages'),
                        structuredMessageIds: getJsonAtPointer(
                          nativeDocument,
                          '/localization/structuredMessageIds',
                        ),
                      },
                      diskSourceRevision: 'sha256:' + '1'.repeat(64),
                      dirty: true,
                    },
                  ],
                ]
              : owner !== 'project' && hasJsonAtPointer(nativeDocument, `/${owner}`)
                ? [
                    [
                      owner,
                      {
                        source: getJsonAtPointer(nativeDocument, `/${owner}`),
                        diskSourceRevision: 'sha256:' + '1'.repeat(64),
                        dirty: true,
                      },
                    ],
                  ]
                : [],
          ),
        ),
      },
      affectedRecords: [...lastAffected],
    });
    const patch = vi.fn(
      async (_session: string, expected: number, patches: Parameters<typeof applyJsonPatch>[1]) => {
        expect(expected).toBe(nativeRevision);
        nativeDocument = applyJsonPatch(nativeDocument, patches).document;
        nativeRevision++;
        lastAffected = [
          ...new Set(
            patches.map(({ path }) => {
              const parts = path.split('/');
              if (parts[1] === 'localization')
                return nativeLocalizationTarget(path)?.owner ?? 'project';
              return parts[1] === 'editor'
                ? 'editor'
                : ['rooms', 'variables', 'assets'].includes(parts[1]!)
                  ? `${parts[1]}/${parts[2]}`
                  : 'project';
            }),
          ),
        ].sort();
        return ack();
      },
    );
    const save = vi.fn(
      async (
        _session: string,
        expected: number,
        ids: string[],
        options: {
          structuralPathsByOwner?: Record<string, string[]>;
          comments?: string;
        },
      ) => {
        expect(expected).toBe(nativeRevision);
        expect(ids).toEqual([]);
        expect(
          Object.entries(options.structuralPathsByOwner ?? {}).some(
            ([owner, paths]) => owner.startsWith('rooms/') && paths.includes('/'),
          ),
        ).toBe(true);
        if (requireDeleteCommentApproval && options.comments === 'keep')
          return {
            ...ack(),
            accepted: false,
            error: 'Deleting commented records requires explicit Remove Comments approval.',
            commentImpacts: [
              {
                file: `records/rooms/${createdId}.yaml`,
                path: '/label',
                comment: 'Review this note',
                kind: 'deleted' as const,
              },
            ],
          };
        nativeRevision++;
        return ack();
      },
    );
    Object.defineProperty(window.noveltea, 'nativeProjectPatch', {
      configurable: true,
      value: patch,
    });
    Object.defineProperty(window.noveltea, 'nativeProjectSaveUnit', {
      configurable: true,
      value: save,
    });
    const nativeGraph = vi.fn(async (_session: string, expected: number) => {
      expect(expected).toBe(nativeRevision);
      const rooms = (nativeDocument as unknown as { rooms: Record<string, unknown> }).rooms;
      return {
        projectSessionId: sessionId,
        generation: 1,
        workingRevision: nativeRevision,
        sourceRevisions: { 'project.yaml': 'sha256:' + '0'.repeat(64) },
        textSourceRevisions: {},
        complete: true,
        incompleteOwners: [],
        nodes: Object.keys(rooms).map((id) => {
          const key = { kind: 'record' as const, collection: 'rooms', id };
          return { key, keyText: JSON.stringify(key), owningPath: `/rooms/${id}`, label: id };
        }),
        edges: [],
        occurrences: [],
        diagnostics: [],
      };
    });
    Object.defineProperty(window.noveltea, 'nativeProjectSemanticGraph', {
      configurable: true,
      value: nativeGraph,
    });
    const created = await useCommandStore.getState().executeCommandAsync({
      type: 'entity.createRecord',
      label: 'Create native structural room',
      payload: { collection: 'rooms', entityId: createdId, label: 'Native Structural Room' },
      originSaveUnitId: 'workflow:new-entity',
      persistencePolicy: 'auto-commit',
    });
    expect(created.ok, JSON.stringify(created.diagnostics)).toBe(true);
    expect(useProjectStore.getState().savedDocument).toMatchObject({
      rooms: { [createdId]: { id: createdId } },
    });
    expect((await useCommandStore.getState().undoAsync()).ok).toBe(true);
    expect(
      (useProjectStore.getState().savedDocument as { rooms: Record<string, unknown> }).rooms[
        createdId
      ],
    ).toBeUndefined();
    expect((await useCommandStore.getState().redoAsync()).ok).toBe(true);
    expect(useProjectStore.getState().savedDocument).toMatchObject({
      rooms: { [createdId]: { id: createdId } },
    });
    expect(save).toHaveBeenCalledTimes(3);
    expect(useCommandStore.getState().nativeWorkingRevision).toBe(6);
    const stopGraph = startAuthoringDependencyGraphService();
    try {
      await nativeRendererGraphService.refresh();
      expect(
        nativeRendererGraphService.currentSnapshot(),
        JSON.stringify({
          graphError: nativeRendererGraphService.error(),
          commands: useCommandStore.getState().nativeWorkingRevision,
          projectionRevision: useCommandStore.getState().nativeProjectionRevision,
          currentRevision: useProjectStore.getState().projectRevision,
          requested: nativeGraph.mock.calls,
        }),
      ).not.toBeNull();
      const renamedId = 'renamed-native-structural-room';
      const renamed = await useCommandStore.getState().executeCommandAsync({
        type: 'entity.renameId',
        label: 'Rename native room',
        payload: { collection: 'rooms', fromId: createdId, toId: renamedId },
        originSaveUnitId: 'structure:rooms',
        persistencePolicy: 'auto-commit',
      });
      expect(renamed.ok, JSON.stringify(renamed.diagnostics)).toBe(true);
      expect(useProjectStore.getState().savedDocument).toMatchObject({
        rooms: { [renamedId]: { id: renamedId } },
      });
      expect(
        (useProjectStore.getState().savedDocument as { rooms: Record<string, unknown> }).rooms[
          createdId
        ],
      ).toBeUndefined();
      expect((await useCommandStore.getState().undoAsync()).ok).toBe(true);
      expect(useProjectStore.getState().savedDocument).toMatchObject({
        rooms: { [createdId]: { id: createdId } },
      });
      expect(save).toHaveBeenCalledTimes(5);
      await nativeRendererGraphService.refresh();
      requireDeleteCommentApproval = true;
      const deleting = useCommandStore.getState().executeCommandAsync({
        type: 'entity.deleteRecord',
        label: 'Delete native room',
        payload: { collection: 'rooms', entityId: createdId, force: true },
        originSaveUnitId: 'structure:rooms',
        persistencePolicy: 'auto-commit',
      });
      let earlyResult: Awaited<typeof deleting> | undefined;
      void deleting.then((result) => {
        earlyResult = result;
      });
      await vi.waitFor(() =>
        expect(save.mock.calls.length, JSON.stringify(earlyResult?.diagnostics)).toBe(6),
      );
      resolveProjectComments('delete');
      expect((await deleting).ok).toBe(true);
      expect(save).toHaveBeenCalledTimes(7);
      expect(save.mock.calls[6]?.[3].comments).toBe('remove');
      expect(
        (useProjectStore.getState().savedDocument as { rooms: Record<string, unknown> }).rooms[
          createdId
        ],
      ).toBeUndefined();
    } finally {
      stopGraph();
    }
  });
  it('rolls back a rejected native structural Save without publishing document or history', async () => {
    const id = 'rejected-native-room';
    const initial = useProjectStore.getState().document!;
    const saved = useProjectStore.getState().savedDocument;
    let working: JsonValue = initial;
    let revision = 0;
    const patch = vi.fn(
      async (_session: string, expected: number, patches: Parameters<typeof applyJsonPatch>[1]) => {
        expect(expected).toBe(revision);
        working = applyJsonPatch(working, patches).document;
        revision++;
        const recordOwner = `rooms/${id}`;
        return {
          ...nativeAck('Saved Project', revision),
          affectedRecords: [recordOwner],
          snapshot: {
            ...nativeAck('Saved Project', revision).snapshot,
            source: working,
            recordSnapshots: hasJsonAtPointer(working, `/${recordOwner}`)
              ? { [recordOwner]: { source: getJsonAtPointer(working, `/${recordOwner}`) } }
              : {},
          },
        };
      },
    );
    const save = vi.fn(async () => ({
      ...nativeAck('Saved Project', 1, false),
      error: 'WORKSPACE_REVISION_CONFLICT',
    }));
    Object.defineProperty(window.noveltea, 'nativeProjectPatch', {
      configurable: true,
      value: patch,
    });
    Object.defineProperty(window.noveltea, 'nativeProjectSaveUnit', {
      configurable: true,
      value: save,
    });
    const result = await useCommandStore.getState().executeCommandAsync({
      type: 'entity.createRecord',
      label: 'Create rejected native room',
      payload: { collection: 'rooms', entityId: id, label: 'Rejection Test' },
      originSaveUnitId: 'workflow:new-entity',
      persistencePolicy: 'auto-commit',
    });
    expect(result.ok).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledTimes(2);
    expect(working).toEqual(initial);
    expect(useProjectStore.getState().document).toEqual(initial);
    expect(useProjectStore.getState().savedDocument).toEqual(saved);
    expect(useCommandStore.getState().history.entries).toHaveLength(0);
    expect(useCommandStore.getState().nativeMutationFailure).toBeNull();
    expect(useCommandStore.getState().nativeWorkingRevision).toBe(2);
  });
  it('does not attempt a structural Save after the native patch itself is rejected', async () => {
    const patch = vi.fn(async () => nativeAck('Saved Project', 0, false));
    const save = vi.fn();
    Object.defineProperty(window.noveltea, 'nativeProjectPatch', {
      configurable: true,
      value: patch,
    });
    Object.defineProperty(window.noveltea, 'nativeProjectSaveUnit', {
      configurable: true,
      value: save,
    });
    const rejected = await useCommandStore.getState().executeCommandAsync({
      type: 'entity.createRecord',
      payload: { collection: 'rooms', entityId: 'native-patch-denied', label: 'Denied Room' },
      originSaveUnitId: 'workflow:new-entity',
      persistencePolicy: 'auto-commit',
    });
    expect(rejected.ok).toBe(false);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    expect(useCommandStore.getState().nativeMutationPending).toBe(false);
    expect(useCommandStore.getState().nativeMutationFailure).toBeNull();
    expect(useCommandStore.getState().history.entries).toHaveLength(0);
  });
  it('stages dirty text through the serialized native queue without publishing Project edits', async () => {
    const stage = vi.fn().mockResolvedValue({
      ...nativeAck('Saved Project', 1),
      textSourceStaged: true,
      textSourceDiskRevision: 'sha256:' + 'a'.repeat(64),
    });
    Object.defineProperty(window.noveltea, 'nativeProjectStageText', {
      configurable: true,
      writable: true,
      value: stage,
    });
    const revisionBefore = useProjectStore.getState().projectRevision;
    const result = await useCommandStore
      .getState()
      .stageNativeTextAsync(
        'scripts/demo.lua',
        'return 17',
        'sha256:' + 'a'.repeat(64),
        revisionBefore,
      );
    expect(result.ok).toBe(true);
    expect(stage).toHaveBeenCalledWith(
      sessionId,
      0,
      'scripts/demo.lua',
      'sha256:' + 'a'.repeat(64),
      'return 17',
    );
    expect(useCommandStore.getState().nativeWorkingRevision).toBe(1);
    expect(useProjectStore.getState().projectRevision).toBe(revisionBefore);
    expect(useCommandStore.getState().history.entries).toHaveLength(0);
  });

  it('queues text Save behind native editing and advances revision only on worker acknowledgment', async () => {
    let release!: (value: ReturnType<typeof nativeAck>) => void;
    vi.spyOn(window.noveltea, 'nativeProjectPatch').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const sourceRevision = 'sha256:' + 'f'.repeat(64);
    const nativeSaveText = vi.fn().mockResolvedValue({
      ...nativeAck('Edited', 3),
      textSourceDiskRevisions: { 'scripts/demo.lua': sourceRevision },
    });
    Object.defineProperty(window.noveltea, 'nativeProjectSaveText', {
      configurable: true,
      writable: true,
      value: nativeSaveText,
    });
    const command = useCommandStore.getState().executeCommandAsync(request('Edited'));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const expectedProjectRevision = useProjectStore.getState().projectRevision + 1;
    const saving = useCommandStore
      .getState()
      .saveNativeTextAsync(
        'scripts/demo.lua',
        'return true',
        'sha256:' + 'a'.repeat(64),
        expectedProjectRevision,
      );
    expect(nativeSaveText).not.toHaveBeenCalled();
    release(nativeAck('Edited', 1));
    expect((await command).ok).toBe(true);
    expect(await saving).toEqual({ ok: true, contentHash: sourceRevision });
    expect(nativeSaveText).toHaveBeenCalledWith(
      sessionId,
      1,
      'scripts/demo.lua',
      'sha256:' + 'a'.repeat(64),
      'return true',
    );
    expect(useCommandStore.getState().nativeWorkingRevision).toBe(3);
    expect(useCommandStore.getState().nativeMutationPending).toBe(false);
  });

  it('retains native staged revision after source disk conflict, without falling back', async () => {
    const nativeSaveText = vi.fn().mockResolvedValue({
      ...nativeAck('Saved Project', 1, false),
      error: 'WORKSPACE_REVISION_CONFLICT',
    });
    Object.defineProperty(window.noveltea, 'nativeProjectSaveText', {
      configurable: true,
      writable: true,
      value: nativeSaveText,
    });
    const result = await useCommandStore
      .getState()
      .saveNativeTextAsync(
        'scripts/demo.lua',
        'return edited',
        'sha256:' + 'b'.repeat(64),
        useProjectStore.getState().projectRevision,
      );
    expect(result.ok).toBe(false);
    expect(useCommandStore.getState().nativeWorkingRevision).toBe(1);
    expect(useCommandStore.getState().nativeMutationFailure).toBeNull();
    expect(useCommandStore.getState().executeCommand(request('Legacy')).ok).toBe(false);
  });
  it('serializes scoped native Save after acknowledged edits without changing editor history', async () => {
    let release!: (value: ReturnType<typeof nativeAck>) => void;
    const patch = vi.spyOn(window.noveltea, 'nativeProjectPatch').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const save = vi.fn().mockResolvedValue(nativeAck('Edited', 1));
    Object.defineProperty(window.noveltea, 'nativeProjectSaveUnit', {
      configurable: true,
      writable: true,
      value: save,
    });
    const command = useCommandStore.getState().executeCommandAsync(request('Edited'));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const atRevision = useProjectStore.getState().projectRevision;
    const saved = useCommandStore
      .getState()
      .saveNativeUnitAsync('project:settings', atRevision + 1, { comments: 'keep' });
    expect(save).not.toHaveBeenCalled();
    release(nativeAck('Edited', 1));
    expect((await command).ok).toBe(true);
    expect((await saved).ok).toBe(true);
    expect(save).toHaveBeenCalledWith(sessionId, 1, 'project:settings', { comments: 'keep' });
    expect(useCommandStore.getState().history.entries).toHaveLength(1);
    expect(useCommandStore.getState().nativeMutationFailure).toBeNull();
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it('adopts a saved baseline before allowing the next queued native edit to publish', async () => {
    const order: string[] = [];
    Object.defineProperty(window.noveltea, 'nativeProjectSaveUnit', {
      configurable: true,
      writable: true,
      value: vi.fn(async () => nativeAck('Saved Project', 0)),
    });
    vi.spyOn(window.noveltea, 'nativeProjectPatch').mockImplementationOnce(async () => {
      order.push('next-command');
      return nativeAck('Next change', 1);
    });
    const originalRevision = useProjectStore.getState().projectRevision;
    const saving = useCommandStore
      .getState()
      .saveNativeUnitAsync('project:settings', originalRevision, { comments: 'keep' }, () => {
        order.push('saved-baseline');
        expect(useProjectStore.getState().projectRevision).toBe(originalRevision);
      });
    const next = useCommandStore.getState().executeCommandAsync(request('Next change'));
    expect((await saving).ok).toBe(true);
    expect((await next).ok).toBe(true);
    expect(order).toEqual(['saved-baseline', 'next-command']);
    expect(projectName()).toBe('Next change');
  });

  it('keeps native Save failure from creating a saved baseline or enabling a legacy writer', async () => {
    const save = vi.fn().mockResolvedValue(nativeAck('Saved Project', 0, false));
    Object.defineProperty(window.noveltea, 'nativeProjectSaveUnit', {
      configurable: true,
      writable: true,
      value: save,
    });
    const current = useProjectStore.getState().projectRevision;
    const denied = await useCommandStore
      .getState()
      .saveNativeUnitAsync('project:settings', current, { comments: 'keep' });
    expect(denied.ok).toBe(false);
    expect(useCommandStore.getState().nativeWorkingRevision).toBe(0);
    expect(useCommandStore.getState().nativeMutationFailure).toBeNull();
    expect(useCommandStore.getState().executeCommand(request('Legacy writer')).ok).toBe(false);
    save.mockRejectedValueOnce(new Error('Worker stopped before Save reply'));
    const unknown = await useCommandStore
      .getState()
      .saveNativeUnitAsync('project:settings', current, {});
    expect(unknown.ok).toBe(false);
    expect(useCommandStore.getState().nativeMutationFailure).toContain('Worker stopped');
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('submits grouped editor commands as one native mutation and one undo entry', async () => {
    const patch = vi.spyOn(window.noveltea, 'nativeProjectPatch');
    patch.mockResolvedValueOnce(nativeAck('Second name', 1));
    const result = await useCommandStore.getState().executeCommandBatchAsync(
      {
        label: 'Edit project name twice',
        originSaveUnitId: 'project:settings',
        persistencePolicy: 'manual-save',
      },
      [request('First name'), request('Second name')],
    );
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]?.[2]).toHaveLength(2);
    expect(projectName()).toBe('Second name');
    expect(useCommandStore.getState().history.entries).toHaveLength(1);
    patch.mockResolvedValueOnce(nativeAck('Saved Project', 2));
    expect((await useCommandStore.getState().undoAsync()).ok).toBe(true);
    expect(projectName()).toBe('Saved Project');
  });

  it('confirms JSON Patch array append against the final native parent array', async () => {
    const original = createInitialCommandBusState({ project: { tags: ['a'] } });
    const proposal = executeCommand(original, {
      type: 'project.applyPatch',
      payload: [{ op: 'add', path: '/project/tags/-', value: 'b' }],
      originSaveUnitId: 'project:settings',
      persistencePolicy: 'manual-save',
    });
    expect(proposal.ok, JSON.stringify(proposal.diagnostics)).toBe(true);
    const submitted = vi.fn(async () => ({
      ...nativeAck('irrelevant', 1),
      snapshot: {
        ...nativeAck('irrelevant', 1).snapshot,
        source: { project: { tags: ['a', 'b'] } },
      },
    }));
    const confirmed = await confirmNativeCommand(
      original,
      proposal,
      proposal.historyEntry!.patches,
      sessionId,
      0,
      submitted,
    );
    expect(confirmed.result.ok).toBe(true);
    expect(confirmed.result.document).toMatchObject({ project: { tags: ['a', 'b'] } });
  });

  it('confirms native cancellation of an unborn record only when its owner is explicitly removed', async () => {
    const original = createInitialCommandBusState({ rooms: { newroom: { id: 'newroom' } } });
    const proposal = executeCommand(original, {
      type: 'project.applyPatch',
      payload: [{ op: 'remove', path: '/rooms/newroom' }],
      originSaveUnitId: 'record:rooms:newroom',
      persistencePolicy: 'manual-save',
    });
    expect(proposal.ok).toBe(true);
    const acknowledged = {
      ...nativeAck('irrelevant', 1),
      affectedRecords: ['rooms/newroom'],
      snapshot: { ...nativeAck('irrelevant', 1).snapshot, recordSnapshots: {} },
    };
    const accepted = await confirmNativeCommand(
      original,
      proposal,
      proposal.historyEntry!.patches,
      sessionId,
      0,
      async () => acknowledged,
    );
    expect(accepted.result.ok).toBe(true);
    await expect(
      confirmNativeCommand(
        original,
        proposal,
        proposal.historyEntry!.patches,
        sessionId,
        0,
        async () => ({ ...acknowledged, affectedRecords: [] }),
      ),
    ).rejects.toThrow('did not acknowledge');
  });

  beforeEach(() => {
    Object.defineProperty(window.noveltea, 'nativeProjectPatch', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    useProjectStore.getState().clearProject();
    useCommandStore.getState().resetCommandHistory();
    setProject();
    useCommandStore.getState().enableNativeCommandMode(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window.noveltea, 'nativeProjectPatch');
    Reflect.deleteProperty(window.noveltea, 'nativeProjectSaveUnit');
    Reflect.deleteProperty(window.noveltea, 'nativeProjectSaveText');
    Reflect.deleteProperty(window.noveltea, 'nativeProjectStageText');
    Reflect.deleteProperty(window.noveltea, 'nativeProjectUseDiskUnit');
    useProjectStore.getState().clearProject();
    useCommandStore.getState().resetCommandHistory();
  });

  it('waits for native acknowledgment before publishing document and history; supports undo/redo', async () => {
    let release!: (value: ReturnType<typeof nativeAck>) => void;
    const patch = vi.spyOn(window.noveltea, 'nativeProjectPatch').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const state = useCommandStore.getState();
    const pending = state.executeCommandAsync(request('Native Edition'));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(projectName()).toBe('Saved Project');
    expect(useCommandStore.getState().history.cursor).toBe(-1);
    expect(useCommandStore.getState().nativeMutationPending).toBe(true);
    expect(useCommandStore.getState().executeCommand(request('Unsafe fallback')).ok).toBe(false);
    const queued = state.executeCommandAsync(request('Concurrent'));
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]?.slice(0, 2)).toEqual([sessionId, 0]);
    patch.mockResolvedValueOnce(nativeAck('Concurrent', 2));
    release(nativeAck('Native Edition', 1));
    expect((await pending).ok).toBe(true);
    expect(projectName()).toBe('Native Edition');
    expect(useCommandStore.getState().nativeWorkingRevision).toBe(1);
    expect(useCommandStore.getState().history.cursor).toBe(0);

    const queuedResult = await queued;
    expect(queuedResult.ok, JSON.stringify(queuedResult.diagnostics)).toBe(true);
    expect(projectName()).toBe('Concurrent');
    expect(useCommandStore.getState().nativeWorkingRevision).toBe(2);
    expect(useCommandStore.getState().history.cursor).toBe(1);

    patch.mockResolvedValueOnce(nativeAck('Native Edition', 3));
    expect((await state.undoAsync()).ok).toBe(true);
    expect(projectName()).toBe('Native Edition');
    expect(useCommandStore.getState().history.cursor).toBe(0);

    patch.mockResolvedValueOnce(nativeAck('Concurrent', 4));
    expect((await state.redoAsync()).ok).toBe(true);
    expect(projectName()).toBe('Concurrent');
    expect(useCommandStore.getState().history.cursor).toBe(1);
    expect(useCommandStore.getState().nativeWorkingRevision).toBe(4);
  });

  it('Use Disk prunes acknowledged native history without blocking the next edit', async () => {
    vi.spyOn(window.noveltea, 'nativeProjectPatch')
      .mockResolvedValueOnce(nativeAck('Dirty Project', 1))
      .mockResolvedValueOnce(nativeAck('After Use Disk', 3));
    expect(
      (await useCommandStore.getState().executeCommandAsync(request('Dirty Project'))).ok,
    ).toBe(true);
    expect(useCommandStore.getState().history.entries).toHaveLength(1);
    Object.defineProperty(window.noveltea, 'nativeProjectUseDiskUnit', {
      configurable: true,
      value: vi.fn().mockResolvedValue(nativeAck('Saved Project', 2)),
    });
    const used = await useCommandStore.getState().useNativeDiskUnitAsync('project:settings', () => {
      expect(
        useProjectStore.getState().publishExternalReconciliation({
          document: useProjectStore.getState().savedDocument!,
          savedDocument: useProjectStore.getState().savedDocument!,
          scriptSourcePaths: {},
          affectedPaths: ['/project/name'],
        }),
      ).toBe(true);
    });
    expect(used.ok).toBe(true);
    expect(useCommandStore.getState().nativeMutationFailure).toBeNull();
    expect(useCommandStore.getState().history.entries).toHaveLength(0);
    expect(
      (await useCommandStore.getState().executeCommandAsync(request('After Use Disk'))).ok,
    ).toBe(true);
    expect(projectName()).toBe('After Use Disk');
    expect(useCommandStore.getState().nativeMutationFailure).toBeNull();
  });

  it('rejects denied native patches without changing the document or history', async () => {
    const patch = vi
      .spyOn(window.noveltea, 'nativeProjectPatch')
      .mockResolvedValueOnce(nativeAck('Refused', 0, false));
    expect((await useCommandStore.getState().executeCommandAsync(request('Refused'))).ok).toBe(
      false,
    );
    expect(projectName()).toBe('Saved Project');
    expect(useCommandStore.getState().history.cursor).toBe(-1);
    expect(useCommandStore.getState().nativeWorkingRevision).toBe(0);
    patch.mockResolvedValueOnce(nativeAck('Accepted', 1));
    expect((await useCommandStore.getState().executeCommandAsync(request('Accepted'))).ok).toBe(
      true,
    );
    expect(projectName()).toBe('Accepted');
  });

  it('freezes native editing after an inconsistent accepted acknowledgment', async () => {
    const patch = vi
      .spyOn(window.noveltea, 'nativeProjectPatch')
      .mockResolvedValue(nativeAck('Unexpected Native Value', 1));
    const first = await useCommandStore.getState().executeCommandAsync(request('Proposed'));
    expect(first.ok).toBe(false);
    expect(first.diagnostics[0]?.message).toContain('disagreed');
    expect(projectName()).toBe('Saved Project');
    expect(useCommandStore.getState().nativeMutationFailure).toContain('disagreed');
    expect((await useCommandStore.getState().executeCommandAsync(request('Another'))).ok).toBe(
      false,
    );
    expect(useCommandStore.getState().executeCommand(request('TS fallback')).ok).toBe(false);
    expect(patch).toHaveBeenCalledTimes(1);
    useCommandStore.getState().resetCommandHistory();
    expect(useCommandStore.getState().nativeWorkingRevision).toBe(0);
    expect(useCommandStore.getState().nativeMutationFailure).toContain('disagreed');
  });

  it('refuses to submit commands after an unrelated TypeScript Project publication', async () => {
    const patch = vi.spyOn(window.noveltea, 'nativeProjectPatch');
    const current = useProjectStore.getState().document!;
    const changed = structuredClone(current) as { project: { name: string } };
    changed.project.name = 'Legacy Publication';
    expect(
      useProjectStore.getState().replaceDocumentFromCommand(changed, -1, {
        kind: 'replace',
        affectedPaths: ['/project/name'],
      }),
    ).toBe(true);
    const result = await useCommandStore.getState().executeCommandAsync(request('Native Attempt'));
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.message).toContain('without a native acknowledgment');
    expect(projectName()).toBe('Legacy Publication');
    expect(patch).not.toHaveBeenCalled();
    expect(useCommandStore.getState().nativeMutationFailure).toContain('without a native');
  });

  it('prevents legacy auto-commit and discards delayed responses after a Project switch', async () => {
    const patch = vi.spyOn(window.noveltea, 'nativeProjectPatch');
    expect(
      (
        await useCommandStore.getState().executeCommandAsync({
          ...request('Auto'),
          persistencePolicy: 'auto-commit',
        })
      ).ok,
    ).toBe(false);
    expect(patch).not.toHaveBeenCalled();
    let release!: (value: ReturnType<typeof nativeAck>) => void;
    patch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = useCommandStore.getState().executeCommandAsync(request('Old Project'));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    setProject('New Project', newSessionId);
    expect(useCommandStore.getState().nativeWorkingRevision).toBeNull();
    release(nativeAck('Old Project', 1));
    expect((await pending).ok).toBe(false);
    expect(projectName()).toBe('New Project');
    expect(useCommandStore.getState().nativeMutationFailure).toBeNull();
    expect(useCommandStore.getState().executeCommand(request('TS New Project')).ok).toBe(true);
  });

  it('does not block commands in a new Project while an old native worker reply is pending', async () => {
    let release!: (value: ReturnType<typeof nativeAck>) => void;
    const patch = vi.spyOn(window.noveltea, 'nativeProjectPatch').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const previous = useCommandStore.getState().executeCommandAsync(request('Old Project Edit'));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const staleQueued = useCommandStore.getState().executeCommandAsync(request('Never Apply'));
    setProject('New Project', newSessionId);
    useCommandStore.getState().enableNativeCommandMode(0);
    patch.mockResolvedValueOnce(nativeAck('New Project Edit', 1));

    const current = useCommandStore.getState().executeCommandAsync(request('New Project Edit'));
    expect(
      await Promise.race([
        current.then((value) => value.ok),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
      ]),
    ).toBe(true);
    expect(projectName()).toBe('New Project Edit');
    expect(patch).toHaveBeenCalledTimes(2);
    release(nativeAck('Old Project Edit', 1));
    expect((await previous).ok).toBe(false);
    expect((await staleQueued).ok).toBe(false);
    expect(projectName()).toBe('New Project Edit');
  });
});
