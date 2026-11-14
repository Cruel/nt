import { describe, expect, it, vi } from 'vite-plus/test';
import { mkdtemp, mkdir, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { NativeAuthoringEvent } from '../../main/services/native-authoring-worker-contract';
import {
  NativeEditorObserverWatchService,
  watchEventFromNativeObservation,
} from '../../main/services/native-editor-observer-watch-service';

type Delta = Extract<NativeAuthoringEvent, { type: 'delta' }>;

function event(overrides: Partial<Delta['observation']> = {}): Delta {
  const projectHash = `xxh3-128:${'a'.repeat(32)}`;
  const assetHash = `xxh3-128:${'b'.repeat(32)}`;
  return {
    type: 'delta',
    sessionId: 'project-1',
    generation: 1,
    sequence: 1,
    observation: {
      authoritative: true,
      scopedAuthority: true,
      unchanged: false,
      fullRescan: false,
      error: '',
      added: [],
      changed: ['records/rooms/foyer.yaml', 'assets/scene.png', 'scripts/start.lua'],
      removed: [],
      revisions: {
        'records/rooms/foyer.yaml': projectHash,
        'assets/scene.png': assetHash,
        'scripts/start.lua': projectHash,
      },
      watchPaths: [],
      invalidSources: [],
      recordDiagnostics: [],
      ...overrides,
    },
    changedRecords: ['rooms/foyer'],
    changedSourcePaths: ['records/rooms/foyer.yaml'],
  };
}

describe('native observer as sole physical Project watcher', () => {
  it('observes only ignored working proposals, suppresses manifest/baseline events and fences close', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-live-watch-'));
    const working = path.join(root, '.noveltea/editor/working');
    await mkdir(path.join(working, 'files/records/rooms'), { recursive: true });
    await mkdir(path.join(working, 'baselines'), { recursive: true });
    let current = true;
    const publish = vi.fn();
    const watcher = new NativeEditorObserverWatchService(
      { subscribe: () => () => {}, onFailure: () => () => {} },
      { isCurrent: (session) => current && session === 'project-1' },
      publish,
      () => root,
    );
    try {
      watcher.start('project-1');
      await new Promise((resolve) => setTimeout(resolve, 300));
      await writeFile(path.join(working, 'manifest.json'), '{}');
      await writeFile(path.join(working, 'baselines/a.blob'), 'base');
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(publish).not.toHaveBeenCalled();
      const temp = path.join(working, 'files/records/rooms/agent.tmp');
      await writeFile(temp, 'id: hall\nlabel: External\n');
      await rename(temp, path.join(working, 'files/records/rooms/hall.yaml'));
      await vi.waitFor(
        () =>
          expect(publish).toHaveBeenCalledWith(
            expect.objectContaining({
              projectSessionId: 'project-1',
              workingSourceChanged: true,
              authoringChangedPaths: [],
            }),
          ),
        { timeout: 3500 },
      );
      publish.mockClear();
      current = false;
      await writeFile(path.join(working, 'files/records/rooms/hall.yaml'), 'changed again');
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(publish).not.toHaveBeenCalled();
      watcher.close();
    } finally {
      watcher.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 12_000);

  it('settles two in-place writes and observes deleted working paths without watching authored YAML', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-live-watch-settle-'));
    const working = path.join(root, '.noveltea/editor/working');
    await mkdir(path.join(working, 'files/records/rooms'), { recursive: true });
    const published = vi.fn();
    const watcher = new NativeEditorObserverWatchService(
      { subscribe: () => () => {}, onFailure: () => () => {} },
      { isCurrent: () => true },
      published,
      () => root,
    );
    const target = path.join(working, 'files/records/rooms/hall.yaml');
    try {
      await writeFile(target, 'id: hall\nlabel: old\n');
      watcher.start('one');
      await new Promise((resolve) => setTimeout(resolve, 300));
      await writeFile(target, 'id: hall\nlabel: first pass\n');
      await new Promise((resolve) => setTimeout(resolve, 70));
      await writeFile(target, 'id: hall\nlabel: final pass\n');
      await vi.waitFor(() => expect(published).toHaveBeenCalledTimes(1), { timeout: 3500 });
      published.mockClear();
      await rm(target);
      await vi.waitFor(
        () =>
          expect(published).toHaveBeenCalledWith(
            expect.objectContaining({
              projectSessionId: 'one',
              workingSourceChanged: true,
            }),
          ),
        { timeout: 3500 },
      );
    } finally {
      watcher.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 12_000);
  it('publishes native verified YAML, source and Asset paths without TS workspace reopening', () => {
    const result = watchEventFromNativeObservation('project-1', event());
    expect(result?.authoringChangedPaths).toEqual(['records/rooms/foyer.yaml']);
    expect(result?.sourceChangedPaths).toEqual(['scripts/start.lua']);
    expect(result?.assetChangedPaths).toEqual(['assets/scene.png']);
    expect(result?.assetFileRevisions).toEqual({
      'assets/scene.png': `xxh3-128:${'b'.repeat(32)}`,
    });
  });

  it('fails closed for untrusted source paths or lost native observer authority', () => {
    const unsafe = watchEventFromNativeObservation(
      'project-1',
      event({ changed: ['../other-project/project.yaml'] }),
    );
    expect(unsafe?.authoringChangedPaths).toEqual([]);
    expect(unsafe?.sourceDiagnostics?.map((d) => d.code)).toContain('native.observer.unsafe-path');
    const lost = watchEventFromNativeObservation('project-1', event({ authoritative: false }));
    expect(lost?.changedPaths).toEqual([]);
    expect(lost?.sourceDiagnostics?.map((d) => d.code)).toContain(
      'native.observer.authority-uncertain',
    );
  });

  it('never publishes an Asset revision without exact native physical proof', () => {
    const changed = watchEventFromNativeObservation(
      'project-1',
      event({ revisions: { 'records/rooms/foyer.yaml': 'absent' } }),
    );
    expect(changed?.assetChangedPaths).toEqual([]);
    expect(changed?.sourceDiagnostics?.map((d) => d.code)).toContain(
      'native.observer.asset-proof-missing',
    );
  });

  it('revokes subscriptions on close and drops superseded session observations', () => {
    let subscriber: ((delta: Delta) => void) | null = null;
    let failed: ((error: Error) => void) | null = null;
    const unsubscribe = vi.fn();
    const unlistenFailure = vi.fn();
    let active = true;
    const bridge = {
      subscribe: vi.fn((handler: (delta: Delta) => void) => {
        subscriber = handler;
        return unsubscribe;
      }),
      onFailure: vi.fn((handler: (error: Error) => void) => {
        failed = handler;
        return unlistenFailure;
      }),
    };
    const publish = vi.fn();
    const watcher = new NativeEditorObserverWatchService(
      bridge,
      { isCurrent: (id) => active && id === 'project-1' },
      publish,
    );
    watcher.start('project-1');
    subscriber!(event());
    expect(publish).toHaveBeenCalledOnce();
    active = false;
    subscriber!(event());
    failed!(new Error('terminated'));
    expect(publish).toHaveBeenCalledOnce();
    watcher.close();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(unlistenFailure).toHaveBeenCalledOnce();
  });
});
