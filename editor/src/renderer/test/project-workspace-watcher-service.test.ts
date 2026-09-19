import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const watcherHarness = vi.hoisted(() => {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const watcher = {
    on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      const callbacks = handlers.get(event) ?? [];
      callbacks.push(callback);
      handlers.set(event, callbacks);
      return watcher;
    }),
    close: vi.fn(async () => undefined),
  };
  return {
    watcher,
    emit(event: string, ...args: unknown[]) {
      for (const callback of handlers.get(event) ?? []) callback(...args);
    },
    reset() {
      handlers.clear();
      watcher.on.mockClear();
      watcher.close.mockClear();
    },
  };
});

const powerMonitorMock = vi.hoisted(() => ({
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: class BrowserWindow {},
  powerMonitor: powerMonitorMock,
}));
vi.mock('chokidar', () => ({
  default: { watch: vi.fn(() => watcherHarness.watcher) },
}));

import {
  PROJECT_WORKSPACE_WATCH_STABILITY_THRESHOLD_MS,
  PROJECT_WORKSPACE_WATCH_POLL_INTERVAL_MS,
  PROJECT_WORKSPACE_WATCH_QUIET_PERIOD_MS,
  classifyProjectWorkspaceWatchPath,
  refreshProjectWorkspaceWatchAssetSourcePaths,
  scheduleProjectWorkspaceQuietFlush,
  shouldIgnoreProjectWorkspaceWatchPath,
  startProjectWorkspaceWatcher,
  stopProjectWorkspaceWatcher,
} from '../../main/services/project-workspace-watcher-service';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import { emptyEditorProjectState } from '../../shared/project-schema/editor-project-state';
import { shouldReconcileProjectWorkspaceWatchEvent } from '../../shared/project-workspace-watch';

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-watcher-test-'));
  tempRoots.push(root);
  return root;
}

async function waitForWatcherFlush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, PROJECT_WORKSPACE_WATCH_QUIET_PERIOD_MS + 75));
}

describe('project workspace watcher policy', () => {
  afterEach(async () => {
    await stopProjectWorkspaceWatcher();
    watcherHarness.reset();
    powerMonitorMock.on.mockClear();
    powerMonitorMock.removeListener.mockClear();
    vi.useRealTimers();
    for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps the fixed low-latency settling contract', () => {
    expect(PROJECT_WORKSPACE_WATCH_STABILITY_THRESHOLD_MS).toBe(200);
    expect(PROJECT_WORKSPACE_WATCH_POLL_INTERVAL_MS).toBe(50);
    expect(PROJECT_WORKSPACE_WATCH_QUIET_PERIOD_MS).toBe(150);
  });

  it('debounces batches until one full quiet period has elapsed', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    let timer = scheduleProjectWorkspaceQuietFlush(null, callback);
    vi.advanceTimersByTime(100);
    timer = scheduleProjectWorkspaceQuietFlush(timer, callback);
    vi.advanceTimersByTime(PROJECT_WORKSPACE_WATCH_QUIET_PERIOD_MS - 1);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('ignores editor-local, workflow, temporary, build, and generated output', () => {
    const root = '/project';
    expect(
      shouldIgnoreProjectWorkspaceWatchPath(root, '/project/.noveltea/editor/state.json'),
    ).toBe(true);
    expect(shouldIgnoreProjectWorkspaceWatchPath(root, '/project/workflows/image.json')).toBe(true);
    expect(shouldIgnoreProjectWorkspaceWatchPath(root, '/project/build/output.bin')).toBe(true);
    expect(shouldIgnoreProjectWorkspaceWatchPath(root, '/project/generated/output.json')).toBe(
      true,
    );
    expect(
      shouldIgnoreProjectWorkspaceWatchPath(root, '/project/records/rooms/hall.json.tmp'),
    ).toBe(true);
  });

  it('refreshes arbitrary asset source paths after an asset record changes', () => {
    const root = '/project';
    const project = createAuthoringProject();
    project.assets.logo = {
      id: 'logo',
      label: 'Logo',
      data: {
        kind: 'audio',
        source: { type: 'project-file', path: 'images/old.webp' },
        aliases: [],
        imageMetadata: null,
      },
    };
    const known = new Set(['images/old.webp']);
    project.assets.logo.data.source.path = 'sources/new.webp';

    refreshProjectWorkspaceWatchAssetSourcePaths(known, project);

    expect(known).toEqual(new Set(['sources/new.webp']));
    expect(classifyProjectWorkspaceWatchPath(root, '/project/sources/new.webp', known)).toBe(
      'asset',
    );
    expect(classifyProjectWorkspaceWatchPath(root, '/project/images/old.webp', known)).toBe(
      'ignore',
    );
  });

  it('classifies each observed path into exactly one downstream route', () => {
    const root = '/project';
    expect(classifyProjectWorkspaceWatchPath(root, '/project/assets/images/source.webp')).toBe(
      'asset',
    );
    expect(
      classifyProjectWorkspaceWatchPath(
        root,
        '/project/images/custom/source.webp',
        new Set(['images/custom/source.webp']),
      ),
    ).toBe('asset');
    expect(classifyProjectWorkspaceWatchPath(root, '/project/records/rooms/hall.json')).toBe(
      'authoring',
    );
    expect(classifyProjectWorkspaceWatchPath(root, '/project/shaders/effects/main.sc')).toBe(
      'source',
    );
    expect(classifyProjectWorkspaceWatchPath(root, '/project/notes.txt')).toBe('ignore');
    expect(
      classifyProjectWorkspaceWatchPath(root, '/project/.noveltea/transactions/tx-1/manifest.json'),
    ).toBe('transaction');
    expect(classifyProjectWorkspaceWatchPath(root, '/project/.noveltea/editor/state.json')).toBe(
      'ignore',
    );
  });

  it('never reconciles authoring state for an asset-only batch', () => {
    const event = {
      projectSessionId: 'session-a',
      changedPaths: ['assets/images/new.png'],
      authoringChangedPaths: [],
      assetChangedPaths: ['assets/images/new.png'],
    };
    expect(shouldReconcileProjectWorkspaceWatchEvent(event)).toBe(false);
  });

  it('reconciles an authoring batch only when it carries affected authoring paths', () => {
    const event = {
      projectSessionId: 'session-a',
      changedPaths: ['records/rooms/hall.json'],
      authoringChangedPaths: ['records/rooms/hall.json'],
      assetChangedPaths: [],
      authoring: {
        success: true,
        diagnostics: [],
        affectedPaths: ['/rooms/hall/label'],
        externalValueByPath: {
          '/rooms/hall/label': { exists: true as const, value: 'Hallway' },
        },
        fileRevisions: {
          'records/rooms/hall.json': `sha256:${'a'.repeat(64)}` as const,
        },
        scriptSourcePaths: {},
      },
    };
    expect(shouldReconcileProjectWorkspaceWatchEvent(event)).toBe(true);
    expect(
      shouldReconcileProjectWorkspaceWatchEvent({
        ...event,
        authoring: { ...event.authoring, affectedPaths: [] },
      }),
    ).toBe(false);
  });

  it('retries a consumed authoring observation after a transient probe error', async () => {
    const root = tempRoot();
    const project = createAuthoringProject();
    const snapshot = {
      projectRoot: root,
      project,
      canonicalSourceFiles: ['records/rooms/hall.json'],
      fileRevisions: {},
      scriptSourcePaths: {},
    };
    let coherence: 'coherent' | 'resync-needed' = 'coherent';
    const readFreshRevision = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    const resynchronizeAuthoring = vi.fn(async () => {
      coherence = 'coherent';
      return {
        opened: {
          ok: true as const,
          snapshot,
          editorState: emptyEditorProjectState(),
          diagnostics: [],
        },
        changedPaths: ['records/rooms/hall.json'],
      };
    });
    const session = {
      captureAuthoringFileStamps: vi.fn(async () => undefined),
      knownAssetSourcePaths: vi.fn(() => []),
      coherenceState: vi.fn(() => coherence),
      markResyncNeeded: vi.fn(() => {
        coherence = 'resync-needed';
      }),
      runExclusive: vi.fn(async (callback: () => unknown) => callback()),
      snapshot: vi.fn(() => snapshot),
      readFreshRevision,
      requiresAuthoringReassembly: vi.fn(() => true),
      resynchronizeAuthoring,
      recoverPendingTransactions: vi.fn(async () => ({ recovered: false, changedPaths: [] })),
      reassemble: vi.fn(),
      observeAssetRevisions: vi.fn(),
      project: vi.fn(() => project),
    } as never;
    const send = vi.fn();
    const owner = { isDestroyed: () => false, webContents: { send } } as never;
    const isSessionCurrent = vi.fn(() => true);
    const refreshSession = vi.fn(async () => undefined);

    await startProjectWorkspaceWatcher(
      owner,
      'session-a',
      root,
      session,
      isSessionCurrent,
      refreshSession,
    );
    watcherHarness.emit('change', path.join(root, 'records/rooms/hall.json'));

    await waitForWatcherFlush();
    expect(readFreshRevision).toHaveBeenCalledTimes(1);
    expect(resynchronizeAuthoring).not.toHaveBeenCalled();
    expect(coherence).toBe('resync-needed');

    await waitForWatcherFlush();
    expect(resynchronizeAuthoring).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ authoringChangedPaths: ['records/rooms/hall.json'] }),
    );
  });

  it('reports an externally deleted shader source against its typed Material usage', async () => {
    const root = tempRoot();
    const project = createAuthoringProject();
    const material = defaultMaterialData('FX');
    material.shader = { fragment: { kind: 'project', path: 'shaders/main.sc' } };
    project.materials.fx = { id: 'fx', label: 'FX', data: material };
    const snapshot = {
      projectRoot: root,
      project,
      canonicalSourceFiles: [],
      fileRevisions: {},
      scriptSourcePaths: {},
    };
    const session = {
      captureAuthoringFileStamps: vi.fn(async () => undefined),
      knownAssetSourcePaths: vi.fn(() => []),
      coherenceState: vi.fn(() => 'coherent'),
      markResyncNeeded: vi.fn(),
      runExclusive: vi.fn(async (callback: () => unknown) => callback()),
      snapshot: vi.fn(() => snapshot),
      readFreshRevision: vi.fn(async () => 'absent' as const),
      requiresAuthoringReassembly: vi.fn(() => false),
      resynchronizeAuthoring: vi.fn(),
      recoverPendingTransactions: vi.fn(async () => ({ recovered: false, changedPaths: [] })),
      reassemble: vi.fn(),
      observeAssetRevisions: vi.fn(),
      project: vi.fn(() => project),
    } as never;
    const send = vi.fn();
    const owner = { isDestroyed: () => false, webContents: { send } } as never;

    await startProjectWorkspaceWatcher(
      owner,
      'session-a',
      root,
      session,
      () => true,
      async () => undefined,
    );
    watcherHarness.emit('unlink', path.join(root, 'shaders', 'main.sc'));
    await waitForWatcherFlush();

    expect(send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        sourceChangedPaths: ['shaders/main.sc'],
        sourceDiagnostics: [
          expect.objectContaining({
            code: 'workspace.project-source.missing',
            ownerPaths: ['/materials/fx'],
          }),
        ],
      }),
    );
  });

  it('reports an externally deleted Layout script dependency without treating a create as a rename', async () => {
    const root = tempRoot();
    const project = createAuthoringProject();
    const layout = defaultLayoutData('HUD', 'document');
    layout.dependencies.scripts = ['scripts/ui/hud.lua'];
    layout.rml.sourceText =
      '<rml><head><script src="scripts/ui/hud.lua"/></head><body></body></rml>';
    project.layouts.hud = { id: 'hud', label: 'HUD', data: layout };
    const snapshot = {
      projectRoot: root,
      project,
      canonicalSourceFiles: [],
      fileRevisions: {},
      scriptSourcePaths: {},
    };
    const session = {
      captureAuthoringFileStamps: vi.fn(async () => undefined),
      knownAssetSourcePaths: vi.fn(() => []),
      coherenceState: vi.fn(() => 'coherent'),
      markResyncNeeded: vi.fn(),
      runExclusive: vi.fn(async (callback: () => unknown) => callback()),
      snapshot: vi.fn(() => snapshot),
      readFreshRevision: vi.fn(async () => 'absent' as const),
      requiresAuthoringReassembly: vi.fn(() => false),
      resynchronizeAuthoring: vi.fn(),
      recoverPendingTransactions: vi.fn(async () => ({ recovered: false, changedPaths: [] })),
      reassemble: vi.fn(),
      observeAssetRevisions: vi.fn(),
      project: vi.fn(() => project),
    } as never;
    const send = vi.fn();
    const owner = { isDestroyed: () => false, webContents: { send } } as never;

    await startProjectWorkspaceWatcher(
      owner,
      'session-a',
      root,
      session,
      () => true,
      async () => undefined,
    );
    watcherHarness.emit('unlink', path.join(root, 'scripts', 'ui', 'hud.lua'));
    watcherHarness.emit('add', path.join(root, 'scripts', 'ui', 'replacement.lua'));
    await waitForWatcherFlush();

    expect(send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        sourceChangedPaths: ['scripts/ui/hud.lua', 'scripts/ui/replacement.lua'],
        sourceDiagnostics: [
          expect.objectContaining({
            code: 'workspace.project-source.missing',
            path: '/scripts/ui/hud.lua',
            ownerPaths: ['/layouts/hud', '/layouts/hud'],
          }),
        ],
      }),
    );
  });

  it('does not report a missing Asset source after the Asset record is intentionally deleted', async () => {
    const root = tempRoot();
    const project = createAuthoringProject();
    project.assets.logo = {
      id: 'logo',
      label: 'Logo',
      data: {
        kind: 'binary',
        source: { type: 'project-file', path: 'assets/logo.bin' },
        aliases: [],
        imageMetadata: null,
      },
    };
    const snapshot = {
      projectRoot: root,
      project,
      canonicalSourceFiles: [],
      fileRevisions: {},
      scriptSourcePaths: {},
    };
    const session = {
      captureAuthoringFileStamps: vi.fn(async () => undefined),
      knownAssetSourcePaths: vi.fn(() => (project.assets.logo ? ['assets/logo.bin'] : [])),
      coherenceState: vi.fn(() => 'coherent'),
      markResyncNeeded: vi.fn(),
      runExclusive: vi.fn(async (callback: () => unknown) => callback()),
      snapshot: vi.fn(() => snapshot),
      readFreshRevision: vi.fn(),
      requiresAuthoringReassembly: vi.fn(),
      resynchronizeAuthoring: vi.fn(),
      recoverPendingTransactions: vi.fn(async () => ({ recovered: false, changedPaths: [] })),
      reassemble: vi.fn(),
      observeAssetRevisions: vi.fn(async () => ({ 'assets/logo.bin': 'absent' })),
      project: vi.fn(() => project),
    } as never;
    const send = vi.fn();
    const owner = { isDestroyed: () => false, webContents: { send } } as never;

    await startProjectWorkspaceWatcher(
      owner,
      'session-a',
      root,
      session,
      () => true,
      async () => undefined,
    );

    delete project.assets.logo;
    watcherHarness.emit('unlink', path.join(root, 'assets/logo.bin'));
    await waitForWatcherFlush();

    expect(send).toHaveBeenCalledTimes(1);
    const event = send.mock.calls[0]?.[1] as { assetDiagnostics?: Array<{ code: string }> };
    expect(event.assetDiagnostics ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'workspace.asset-source.missing' })]),
    );
  });

  it('still reports a source that disappears while its Asset record remains', async () => {
    const root = tempRoot();
    const project = createAuthoringProject();
    project.assets.logo = {
      id: 'logo',
      label: 'Logo',
      data: {
        kind: 'binary',
        source: { type: 'project-file', path: 'assets/logo.bin' },
        aliases: [],
        imageMetadata: null,
      },
    };
    const snapshot = {
      projectRoot: root,
      project,
      canonicalSourceFiles: [],
      fileRevisions: {},
      scriptSourcePaths: {},
    };
    const session = {
      captureAuthoringFileStamps: vi.fn(async () => undefined),
      knownAssetSourcePaths: vi.fn(() => ['assets/logo.bin']),
      coherenceState: vi.fn(() => 'coherent'),
      markResyncNeeded: vi.fn(),
      runExclusive: vi.fn(async (callback: () => unknown) => callback()),
      snapshot: vi.fn(() => snapshot),
      readFreshRevision: vi.fn(),
      requiresAuthoringReassembly: vi.fn(),
      resynchronizeAuthoring: vi.fn(),
      recoverPendingTransactions: vi.fn(async () => ({ recovered: false, changedPaths: [] })),
      reassemble: vi.fn(),
      observeAssetRevisions: vi.fn(async () => ({ 'assets/logo.bin': 'absent' })),
      project: vi.fn(() => project),
    } as never;
    const send = vi.fn();
    const owner = { isDestroyed: () => false, webContents: { send } } as never;

    await startProjectWorkspaceWatcher(
      owner,
      'session-a',
      root,
      session,
      () => true,
      async () => undefined,
    );

    watcherHarness.emit('unlink', path.join(root, 'assets/logo.bin'));
    await waitForWatcherFlush();

    expect(send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        assetDiagnostics: [
          expect.objectContaining({
            code: 'workspace.asset-source.missing',
            message: "Referenced asset source 'assets/logo.bin' is missing.",
          }),
        ],
      }),
    );
  });

  it('retries only the failed Asset observation without dropping it', async () => {
    const root = tempRoot();
    const project = createAuthoringProject();
    const snapshot = {
      projectRoot: root,
      project,
      canonicalSourceFiles: [],
      fileRevisions: {},
      scriptSourcePaths: {},
    };
    const observeAssetRevisions = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
      .mockResolvedValueOnce({ 'assets/logo.bin': `sha256:${'a'.repeat(64)}` });
    const session = {
      captureAuthoringFileStamps: vi.fn(async () => undefined),
      knownAssetSourcePaths: vi.fn(() => ['assets/logo.bin']),
      coherenceState: vi.fn(() => 'coherent'),
      markResyncNeeded: vi.fn(),
      runExclusive: vi.fn(async (callback: () => unknown) => callback()),
      snapshot: vi.fn(() => snapshot),
      readFreshRevision: vi.fn(),
      requiresAuthoringReassembly: vi.fn(),
      resynchronizeAuthoring: vi.fn(),
      recoverPendingTransactions: vi.fn(async () => ({ recovered: false, changedPaths: [] })),
      reassemble: vi.fn(),
      observeAssetRevisions,
      project: vi.fn(() => project),
    } as never;
    const send = vi.fn();
    const owner = { isDestroyed: () => false, webContents: { send } } as never;

    await startProjectWorkspaceWatcher(
      owner,
      'session-a',
      root,
      session,
      () => true,
      async () => undefined,
    );
    watcherHarness.emit('change', path.join(root, 'assets/logo.bin'));

    await waitForWatcherFlush();
    expect(observeAssetRevisions).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();

    await waitForWatcherFlush();
    expect(observeAssetRevisions).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ assetChangedPaths: ['assets/logo.bin'] }),
    );
  });
});
