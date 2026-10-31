import { describe, expect, it, vi } from 'vite-plus/test';
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
