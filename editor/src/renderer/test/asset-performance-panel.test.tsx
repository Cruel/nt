import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AssetPerformancePanel } from '@/asset-profiler/AssetPerformancePanel';
import { useAssetProfilerStore } from '@/asset-profiler/asset-profiler-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import {
  createAuthoringProject,
  isAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
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

  it('renders the current overview without exposing unsupported cache-policy categories', () => {
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

  it('displays the exact live runtime prediction plan from profiler generations', () => {
    const payload = assetProfilerFullPayload({ latestSequence: '2' });
    payload.retainedChanges = [
      {
        kind: 'prefetch-generation-upsert',
        sequence: '2',
        timestampNs: '20',
        generation: {
          generation: '7',
          timestampNs: '20',
          presentationRevision: '3',
          expectedNextCount: '1',
          possibleNextCount: '0',
          predictionPlan: [
            {
              cacheKey: {
                stableIdentity: 'texture|project:/intro.png|0',
                sourceGeneration: '1',
              },
              prediction: 'expected-next',
              executionDistance: '2',
              executionOrder: '4',
              dependencyPriority: '0',
              estimatedCost: {
                sourceBytes: '10',
                preparedCpuBytes: '20',
                gpuBytes: '30',
                audioBytes: '0',
                temporaryBytes: '0',
              },
              costEstimate: 'metadata',
              provenance: [
                {
                  root: 'flow-execution',
                  room: null,
                  exit: null,
                  supplementalHintId: null,
                  reasonChain: ['scene:opening:entry', 'scene:opening:step:show-intro'],
                },
              ],
            },
          ],
          opaqueFrontiers: [],
          submittedEntries: [
            {
              cacheKey: {
                stableIdentity: 'texture|project:/intro.png|0',
                sourceGeneration: '1',
              },
              prediction: 'expected-next',
            },
          ],
          submissionFailures: [],
          usedCount: '0',
          lateCount: '0',
          unusedCount: '0',
        },
      },
    ];
    const generationChange = payload.retainedChanges[0]!;
    if (generationChange.kind !== 'prefetch-generation-upsert') throw new Error('fixture mismatch');
    payload.activePrefetchGeneration = generationChange.generation;
    useAssetProfilerStore.getState().applyPayload(payload);
    useAssetProfilerStore.getState().setSelectedView('prediction');

    render(<AssetPerformancePanel />);

    expect(screen.getByText('texture|project:/intro.png|0')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Automatic → Flow execution → scene:opening:entry → scene:opening:step:show-intro',
      ),
    ).toBeInTheDocument();

    act(() => {
      useAssetProfilerStore.getState().applyPayload({
        ...payload,
        latestSequence: '3',
        activePrefetchGeneration: null,
        retainedChanges: [
          ...payload.retainedChanges,
          {
            kind: 'prefetch-generation-released',
            sequence: '3',
            timestampNs: '21',
            generation: '7',
          },
        ],
      });
    });
    expect(screen.queryByText('texture|project:/intro.png|0')).not.toBeInTheDocument();
    expect(
      screen.getByText('No live prediction generation has been published yet.'),
    ).toBeInTheDocument();
  });

  it('offers an explicit prefetch-hint action for a safely resolved opaque prediction miss', () => {
    const project = createAuthoringProject();
    project.assets.dynamic = {
      id: 'dynamic',
      label: 'Dynamic image',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'dynamic.png' },
        aliases: [],
        sampling: 'linear',
        imageMetadata: { width: 64, height: 64, hasAlpha: false, orientation: 1 },
      },
    };
    const room = defaultRoomData('Hall');
    room.lifecycle.afterEnter.push({
      id: 'dynamic-lua',
      kind: 'run-lua',
      source: 'choose_dynamic()',
    });
    project.rooms.hall = { id: 'hall', label: 'Hall', data: room };
    project.entrypoint = { kind: 'room', id: 'hall' };
    useProjectStore.getState().loadUnsavedProjectDocument(project);

    const payload = assetProfilerFullPayload({ latestSequence: '1' });
    payload.retainedChanges = [
      {
        kind: 'opaque-prediction-miss',
        sequence: '1',
        timestampNs: '20',
        miss: {
          cacheKey: {
            stableIdentity: 'texture|project:/dynamic.png|0',
            sourceGeneration: '1',
          },
          requestId: '7',
          generation: '3',
          frontier: {
            root: 'flow-execution',
            room: 'hall',
            exit: 'north-exit',
            supplementalHintId: null,
            attachmentPoint: 'room:hall:after-enter',
            reasonChain: ['room:hall:after-enter'],
          },
        },
      },
    ];
    useAssetProfilerStore.getState().applyPayload(payload);
    useAssetProfilerStore.getState().setSelectedView('prediction');

    render(<AssetPerformancePanel />);

    expect(screen.getByText('Opaque prediction misses')).toBeInTheDocument();
    expect(screen.getByText('dynamic')).toBeInTheDocument();
    expect(screen.getByText(/Automatic → flow-execution/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add prefetch hint here' }));

    const updated = useProjectStore.getState().document;
    expect(isAuthoringProject(updated)).toBe(true);
    if (!isAuthoringProject(updated)) return;
    expect(Object.values(updated.prefetchHints)).toContainEqual({
      id: 'prefetch-hint',
      target: { kind: 'asset', asset: { $ref: { collection: 'assets', id: 'dynamic' } } },
      attachment: {
        kind: 'point',
        point: {
          kind: 'room-lifecycle',
          room: { $ref: { collection: 'rooms', id: 'hall' } },
          stage: 'after-enter',
        },
      },
    });
  });

  it('removes persisted author prefetch hints without editing derived prediction data', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Hall');
    project.rooms.hall = { id: 'hall', label: 'Hall', data: room };
    project.entrypoint = { kind: 'room', id: 'hall' };
    project.prefetchHints['author-hint'] = {
      id: 'author-hint',
      target: { kind: 'room', room: { $ref: { collection: 'rooms', id: 'hall' } } },
      attachment: {
        kind: 'room',
        room: { $ref: { collection: 'rooms', id: 'hall' } },
        scope: 'resident',
      },
    };
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    useAssetProfilerStore.getState().setSelectedView('prediction');

    render(<AssetPerformancePanel />);

    expect(screen.getByText(/author-hint/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    const updated = useProjectStore.getState().document;
    expect(isAuthoringProject(updated)).toBe(true);
    if (!isAuthoringProject(updated)) return;
    expect(updated.prefetchHints['author-hint']).toBeUndefined();
    expect('flowPrediction' in updated).toBe(false);
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
        imageMetadata: { width: 256, height: 256, hasAlpha: true, orientation: 1 },
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

  it('virtualizes large live asset inventories', () => {
    const offsetHeight = vi
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockReturnValue(400);
    const offsetWidth = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(920);
    const boundingRect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 920,
      bottom: 36,
      width: 920,
      height: 36,
      toJSON: () => ({}),
    });
    try {
      const assets = Array.from({ length: 1_000 }, (_, index) =>
        assetProfilerEntry(`project:/asset-${index.toString().padStart(4, '0')}.png`),
      );
      useAssetProfilerStore.getState().applyPayload(assetProfilerFullPayload({ assets }));
      useAssetProfilerStore.getState().setSelectedView('assets');

      render(<AssetPerformancePanel />);

      expect(screen.getByText('project:/asset-0000.png')).toBeInTheDocument();
      expect(screen.queryByText('project:/asset-0999.png')).not.toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Expand asset details' }).length).toBeLessThan(
        100,
      );
    } finally {
      boundingRect.mockRestore();
      offsetWidth.mockRestore();
      offsetHeight.mockRestore();
    }
  });
});
