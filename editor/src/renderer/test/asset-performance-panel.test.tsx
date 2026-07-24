import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { fireEvent, render, screen } from '@testing-library/react';
import { AssetPerformancePanel } from '@/asset-profiler/AssetPerformancePanel';
import { useAssetProfilerStore } from '@/asset-profiler/asset-profiler-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { assetProfilerEntry, assetProfilerFullPayload } from './fixtures/asset-profiler';

beforeEach(() => {
  useAssetProfilerStore.getState().clear();
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
});
