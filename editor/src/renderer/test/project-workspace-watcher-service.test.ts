import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('electron', () => ({ BrowserWindow: class BrowserWindow {} }));

import {
  PROJECT_WORKSPACE_WATCH_STABILITY_THRESHOLD_MS,
  PROJECT_WORKSPACE_WATCH_POLL_INTERVAL_MS,
  PROJECT_WORKSPACE_WATCH_QUIET_PERIOD_MS,
  classifyProjectWorkspaceWatchPath,
  refreshProjectWorkspaceWatchAssetSourcePaths,
  scheduleProjectWorkspaceQuietFlush,
  shouldIgnoreProjectWorkspaceWatchPath,
} from '../../main/services/project-workspace-watcher-service';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { shouldReconcileProjectWorkspaceWatchEvent } from '../../shared/project-workspace-watch';

describe('project workspace watcher policy', () => {
  afterEach(() => vi.useRealTimers());

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
    expect(classifyProjectWorkspaceWatchPath(root, '/project/notes.txt')).toBe('ignore');
    expect(
      classifyProjectWorkspaceWatchPath(root, '/project/.noveltea/transactions/tx-1/manifest.json'),
    ).toBe('transaction');
    expect(classifyProjectWorkspaceWatchPath(root, '/project/.noveltea/editor/state.json')).toBe(
      'ignore',
    );
  });

  it('never reconciles authoring state for an asset-only batch', () => {
    const revision = `sha256:${'a'.repeat(64)}`;
    const event = {
      projectRoot: '/project',
      manifestPath: '/project/project.json',
      changedPaths: ['assets/images/new.png'],
      authoringChangedPaths: [],
      assetChangedPaths: ['assets/images/new.png'],
      candidate: {
        success: true,
        diagnostics: [],
        workspaceRevision: revision,
      },
    };
    expect(shouldReconcileProjectWorkspaceWatchEvent(revision, event)).toBe(false);
    expect(shouldReconcileProjectWorkspaceWatchEvent(`sha256:${'b'.repeat(64)}`, event)).toBe(
      false,
    );
  });

  it('reconciles an authoring batch only when its canonical revision changed', () => {
    const revision = `sha256:${'a'.repeat(64)}`;
    const event = {
      projectRoot: '/project',
      manifestPath: '/project/project.json',
      changedPaths: ['records/rooms/hall.json'],
      authoringChangedPaths: ['records/rooms/hall.json'],
      assetChangedPaths: [],
      candidate: {
        success: true,
        diagnostics: [],
        workspaceRevision: revision,
      },
    };
    expect(shouldReconcileProjectWorkspaceWatchEvent(revision, event)).toBe(false);
    expect(shouldReconcileProjectWorkspaceWatchEvent(`sha256:${'b'.repeat(64)}`, event)).toBe(true);
  });
});
