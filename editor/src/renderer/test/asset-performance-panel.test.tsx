import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AssetPerformancePanel } from '@/asset-profiler/AssetPerformancePanel';
import { useAssetProfilerStore } from '@/asset-profiler/asset-profiler-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { AssetProfilerWireChange } from '../../shared/asset-profiler-protocol';
import { assetProfilerEntry, assetProfilerFullPayload } from './fixtures/asset-profiler';

function telemetry(
  sequence: string,
  timestampNs: string,
  stableIdentity: string,
  eventKind: 'request-failed' | 'reloaded-after-eviction',
  diagnosticCode = '',
): AssetProfilerWireChange {
  return {
    kind: 'telemetry-event',
    sequence,
    timestampNs,
    event: {
      eventKind,
      executionMode: 'threaded',
      cacheKey: { stableIdentity, sourceGeneration: '1' },
      jobId: '1',
      requestId: sequence,
      prefetchGeneration: '0',
      requestReason: 'demand',
      jobPriority: 'critical',
      memory: {
        sourceBytes: '0',
        preparedCpuBytes: '0',
        gpuBytes: '0',
        audioBytes: '0',
        temporaryBytes: '0',
      },
      compressedBytes: '0',
      uncompressedBytes: '0',
      durationNs: '0',
      diagnosticCode,
      evictionReason: null,
      memoryPolicy: null,
    },
  };
}

beforeEach(() => {
  useAssetProfilerStore.getState().resetForEditorReload();
  useProjectStore.getState().clearProject();
  useWorkbenchStore.getState().resetWorkbench();
});

describe('AssetPerformancePanel', () => {
  it('offers to open Play when no live preview is connected', () => {
    render(<AssetPerformancePanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Open Play' }));

    expect(useWorkbenchStore.getState().tabsById['tab:full-game-preview']).toMatchObject({
      title: 'Play',
      editorType: 'full-game-preview',
    });
  });

  it('renders the Phase 7 overview without exposing future cache-policy categories', () => {
    const payload = assetProfilerFullPayload({ assets: [assetProfilerEntry()] });
    payload.memory.current.assetRamBytes = '1048576';
    payload.memory.peak.assetRamBytes = '2097152';
    payload.memory.current.asset.gpuBytes = '524288';
    payload.memory.peak.asset.gpuBytes = '1048576';
    payload.memory.current.totalGpuResourceBytes = '3145728';
    payload.memory.peak.totalGpuResourceBytes = '4194304';
    payload.memory.current.rendererEstimate.ordinaryTextureBytes = '524288';
    payload.memory.current.rendererEstimate.renderTargetBytes = '2621440';
    payload.memory.peak.rendererEstimate.ordinaryTextureBytes = '1048576';
    payload.memory.peak.rendererEstimate.renderTargetBytes = '3145728';
    payload.memory.policy.budget.sourceBytes = '4194304';
    payload.memory.policy.budget.preparedCpuBytes = '4194304';
    payload.memory.policy.budget.gpuBytes = '4194304';
    payload.memory.policy.budget.audioBytes = '4194304';
    payload.memory.policy.budget.temporaryBytes = '4194304';
    payload.outcomes.readyBeforeUse = '9';
    payload.outcomes.loadedTooLate = '1';
    payload.outcomes.assetWaitCount = '2';
    payload.outcomes.assetWaitTimeNs = '1500000';
    useAssetProfilerStore.getState().applyPayload(payload);

    render(<AssetPerformancePanel />);

    expect(screen.getByText('Memory budget used')).toBeInTheDocument();
    expect(screen.getByText('Total GPU resource details (estimate)')).toBeInTheDocument();
    expect(screen.getByText('Ordinary textures')).toBeInTheDocument();
    expect(screen.getByText('Render targets')).toBeInTheDocument();
    expect(screen.getByText('90%')).toBeInTheDocument();
    expect(screen.queryByText('Pinned')).not.toBeInTheDocument();
    expect(screen.queryByText('Warm')).not.toBeInTheDocument();
    expect(screen.queryByText('Cold')).not.toBeInTheDocument();
  });

  it('filters issues through profiler-local controls and reveals technical details on expansion', () => {
    const project = createAuthoringProject();
    project.assets.broken = {
      id: 'broken',
      label: 'Broken',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'broken.png' },
        aliases: [],
        sampling: 'linear',
      },
    };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    const payload = assetProfilerFullPayload({ latestSequence: '2' });
    payload.retainedChanges = [
      telemetry(
        '1',
        '10',
        'texture|project:/broken.png|0',
        'request-failed',
        'assets.decode_failed',
      ),
      telemetry('2', '20', 'texture|project:/reloaded.png|0', 'reloaded-after-eviction'),
    ];
    useAssetProfilerStore.getState().applyPayload(payload);
    useAssetProfilerStore.getState().setSelectedView('issues');

    render(<AssetPerformancePanel />);

    expect(screen.getAllByText('Load failed')).not.toHaveLength(0);
    expect(screen.getByText('Reloaded after removal')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open project:/broken.png' }));
    expect(useWorkbenchStore.getState().tabsById['tab:asset-detail:assets:broken']).toMatchObject({
      resource: { stableId: 'record:assets:broken' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand issue details' })[0]!);
    expect(screen.getByText('assets.decode_failed')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'Search issues' }), {
      target: { value: 'reloaded.png' },
    });
    expect(screen.queryByText('project:/broken.png')).not.toBeInTheDocument();
    expect(screen.getByText('project:/reloaded.png')).toBeInTheDocument();

    act(() => {
      useAssetProfilerStore.getState().setIssueQuery('');
      useAssetProfilerStore.getState().setIssueType('load-failed');
    });
    expect(screen.getByText('project:/broken.png')).toBeInTheDocument();
    expect(screen.queryByText('project:/reloaded.png')).not.toBeInTheDocument();
  });
});
