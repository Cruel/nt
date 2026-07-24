import { beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  normalizeAssetProfilerValue,
  useAssetProfilerStore,
} from '@/asset-profiler/asset-profiler-store';
import {
  assetProfilerDeltaPayload,
  assetProfilerEntry,
  assetProfilerFullPayload,
} from './fixtures/asset-profiler';

describe('asset profiler client store', () => {
  beforeEach(() => {
    useAssetProfilerStore.getState().resetForEditorReload();
  });

  it('normalizes canonical decimal fields to bigint without changing identities', () => {
    expect(
      normalizeAssetProfilerValue({
        sessionId: '9007199254740993',
        cacheKey: { stableIdentity: '9007199254740993', sourceGeneration: '42' },
        memory: { assetRamBytes: '18446744073709551615' },
      }),
    ).toEqual({
      sessionId: 9_007_199_254_740_993n,
      cacheKey: { stableIdentity: '9007199254740993', sourceGeneration: 42n },
      memory: { assetRamBytes: 18_446_744_073_709_551_615n },
    });
  });

  it('rejects a delta from a replacement profiler session', () => {
    useAssetProfilerStore
      .getState()
      .applyPayload(assetProfilerFullPayload({ sessionId: '1', latestSequence: '4' }));

    expect(
      useAssetProfilerStore.getState().applyPayload(
        assetProfilerDeltaPayload({
          sessionId: '2',
          afterSequence: '4',
          latestSequence: '5',
        }),
      ),
    ).toBe('session-mismatch');
    expect(useAssetProfilerStore.getState().payload?.sessionId).toBe(1n);
  });

  it('installs a history-gap replacement window and preserves the notice after a same-session full refresh', () => {
    useAssetProfilerStore.getState().applyPayload(assetProfilerFullPayload());
    const replacement = assetProfilerEntry('project:/replacement.png');

    expect(
      useAssetProfilerStore.getState().applyPayload(
        assetProfilerDeltaPayload({
          afterSequence: '1',
          latestSequence: '9',
          replacementInventory: [replacement],
          historyGap: true,
        }),
      ),
    ).toBe('history-gap');
    expect(useAssetProfilerStore.getState()).toMatchObject({
      status: 'ready',
      historyGapNotice: true,
    });
    expect(
      [...useAssetProfilerStore.getState().assetsByKey.values()][0]?.cacheKey.stableIdentity,
    ).toBe('project:/replacement.png');

    useAssetProfilerStore
      .getState()
      .applyPayload(assetProfilerFullPayload({ sessionId: '1', latestSequence: '10' }));
    expect(useAssetProfilerStore.getState().historyGapNotice).toBe(true);
  });

  it('keys the authoritative inventory by asset type, identity, and source generation', () => {
    const image = assetProfilerEntry('project:/shared.bin');
    const audio = { ...assetProfilerEntry('project:/shared.bin'), assetType: 'audio' as const };
    const nextGeneration = {
      ...assetProfilerEntry('project:/shared.bin'),
      cacheKey: { stableIdentity: 'project:/shared.bin', sourceGeneration: '2' },
    };

    useAssetProfilerStore
      .getState()
      .applyPayload(assetProfilerFullPayload({ assets: [image, audio, nextGeneration] }));

    expect(useAssetProfilerStore.getState().assetsByKey.size).toBe(3);
  });

  it('keeps issue controls across transient clearing and resets them at the defined boundaries', () => {
    useAssetProfilerStore.getState().applyPayload(assetProfilerFullPayload({ sessionId: '1' }));
    useAssetProfilerStore.getState().setSelectedView('issues');
    useAssetProfilerStore.getState().setIssueQuery('hero');
    useAssetProfilerStore.getState().setIssueType('asset-wait');
    useAssetProfilerStore.getState().toggleExpandedIssue('wait-7');
    useAssetProfilerStore.getState().clear('disconnected');
    expect(useAssetProfilerStore.getState()).toMatchObject({
      selectedView: 'issues',
      issueQuery: 'hero',
      issueType: 'asset-wait',
      expandedIssueIds: ['wait-7'],
    });

    useAssetProfilerStore.getState().applyPayload(assetProfilerFullPayload({ sessionId: '1' }));
    expect(useAssetProfilerStore.getState()).toMatchObject({
      selectedView: 'issues',
      issueQuery: 'hero',
      issueType: 'asset-wait',
      expandedIssueIds: ['wait-7'],
    });

    useAssetProfilerStore.getState().applyPayload(assetProfilerFullPayload({ sessionId: '2' }));
    expect(useAssetProfilerStore.getState()).toMatchObject({
      selectedView: 'overview',
      issueQuery: '',
      issueType: 'all',
      expandedIssueIds: [],
    });

    useAssetProfilerStore.getState().setIssueQuery('again');
    useAssetProfilerStore.getState().resetForEditorReload();
    expect(useAssetProfilerStore.getState()).toMatchObject({
      selectedView: 'overview',
      issueQuery: '',
      issueType: 'all',
      expandedIssueIds: [],
      lastAcceptedSessionId: null,
    });
  });
});
