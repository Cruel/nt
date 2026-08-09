import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('electron', () => ({ BrowserWindow: class BrowserWindow {} }));

import {
  PROJECT_WORKSPACE_WATCH_STABILITY_THRESHOLD_MS,
  PROJECT_WORKSPACE_WATCH_POLL_INTERVAL_MS,
  PROJECT_WORKSPACE_WATCH_QUIET_PERIOD_MS,
  scheduleProjectWorkspaceQuietFlush,
  shouldIgnoreProjectWorkspaceWatchPath,
} from '../../main/services/project-workspace-watcher-service';

describe('project workspace watcher policy', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps the fixed settling contract', () => {
    expect(PROJECT_WORKSPACE_WATCH_STABILITY_THRESHOLD_MS).toBe(2_000);
    expect(PROJECT_WORKSPACE_WATCH_POLL_INTERVAL_MS).toBe(250);
    expect(PROJECT_WORKSPACE_WATCH_QUIET_PERIOD_MS).toBe(1_000);
  });

  it('debounces batches until one full quiet period has elapsed', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    let timer = scheduleProjectWorkspaceQuietFlush(null, callback);
    vi.advanceTimersByTime(750);
    timer = scheduleProjectWorkspaceQuietFlush(timer, callback);
    vi.advanceTimersByTime(999);
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

  it('observes transaction state and arbitrary project asset source paths', () => {
    const root = '/project';
    expect(
      shouldIgnoreProjectWorkspaceWatchPath(
        root,
        '/project/.noveltea/transactions/tx-1/manifest.json',
      ),
    ).toBe(false);
    expect(shouldIgnoreProjectWorkspaceWatchPath(root, '/project/images/custom/source.webp')).toBe(
      false,
    );
  });
});
