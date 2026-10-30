import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import type {
  AppliedPreviewDocumentResult,
  FocusedRecordPreviewDocument,
} from '../../shared/focused-preview-contracts';
import type { EnginePreviewController } from '@/hooks/use-engine-preview';
import type { PreviewHostLease } from '@/preview/preview-host-pool';
import { FocusedPreviewFreshnessCoordinator } from '@/preview/focused-preview-coordinator';
import { projectNativeGraphForRenderer } from '../project/native-authoring-graph-projection';
import { nativeSemanticGraphSchema } from '../../main/services/native-authoring-worker-contract';

const revision = `sha256:${'0'.repeat(64)}` as const;
const adapterBuild = vi.hoisted(() => vi.fn());

const focusedDocument: FocusedRecordPreviewDocument = {
  kind: 'room-preview',
  recordId: 'room-a',
  revision,
  projectInstanceId: 'project-one',
  projectRevision: 1,
  inputRevision: revision,
  resourceRevision: revision,
  resources: [],
  data: {},
};
const appliedResult: AppliedPreviewDocumentResult = {
  disposition: 'applied',
  projectInstanceId: 'project-one',
  kind: 'room-preview',
  recordId: 'room-a',
  revision,
  resourceStageGeneration: 0,
  roomResolution: {
    castEntryIds: [],
    interactableOccurrenceIds: [],
    propIds: [],
    environmentIds: [],
  },
};

vi.mock('@/preview/focused-preview-adapters', () => ({
  canonicalFocusedPreviewInputRevision: () => revision,
  validateFocusedPreviewInputs: (_kind: string, inputs: unknown) => inputs,
  focusedPreviewAdapterFor: () => ({
    topologyDependent: false,
    owningPath: () => '/rooms/room-a',
    build: (input: { projectInstanceId: string; projectRevision: number }) => {
      adapterBuild(input);
      return {
        ...focusedDocument,
        projectInstanceId: input.projectInstanceId,
        projectRevision: input.projectRevision,
      };
    },
  }),
}));

let frames: FrameRequestCallback[];

async function runNextFrame() {
  const frame = frames.shift();
  if (!frame) throw new Error('Expected a scheduled animation frame.');
  frame(0);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createLease(
  applyFocusedEditorDocument: ReturnType<typeof vi.fn>,
  initialCommittedContentKey: string | null = null,
  initialFocusedResult: AppliedPreviewDocumentResult | null = null,
) {
  let applySequence = 0;
  let committedContentKey = initialCommittedContentKey;
  let committedFocusedResult = initialFocusedResult;
  const controller = { applyFocusedEditorDocument } as unknown as EnginePreviewController;
  return {
    leaseId: 'lease-one',
    hostId: 'host-one',
    ownerTabId: 'tab:room:a',
    paneId: 'main',
    mode: 'room',
    wheelPolicy: 'editor-scroll',
    hostGeneration: 1,
    nativeHostGeneration: () => 1,
    transportGeneration: () => 1,
    activeShaderVariant: () => 'glsl-330',
    committedContentKey: () => committedContentKey,
    committedFocusedResult: () => committedFocusedResult,
    commitContent: (key: string) => {
      committedContentKey = key;
    },
    commitFocusedResult: (result: AppliedPreviewDocumentResult) => {
      committedFocusedResult = result;
    },
    nextFocusedApplySequence: () => ++applySequence,
    subscribeReady: () => () => undefined,
    reveal: vi.fn(),
    conceal: vi.fn(),
    send: <TResult>(command: (value: EnginePreviewController) => Promise<TResult>) =>
      command(controller),
  } satisfies PreviewHostLease;
}

beforeEach(() => {
  frames = [];
  adapterBuild.mockClear();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FocusedPreviewFreshnessCoordinator', () => {
  function nativeRoomGraph(projectRevision: number, assetId: string, generation = 1) {
    const room = { kind: 'record' as const, collection: 'rooms', id: 'room-a' };
    const asset = { kind: 'record' as const, collection: 'assets', id: assetId };
    const graph = nativeSemanticGraphSchema.parse({
      projectSessionId: '11111111-1111-4111-8111-111111111111',
      generation,
      workingRevision: projectRevision,
      complete: true,
      incompleteOwners: [],
      sourceRevisions: { 'project.yaml': `sha256:${'a'.repeat(64)}` },
      textSourceRevisions: {},
      nodes: [
        { key: room, keyText: JSON.stringify(room), owningPath: '/rooms/room-a', label: 'Room A' },
        {
          key: asset,
          keyText: JSON.stringify(asset),
          owningPath: `/assets/${assetId}`,
          label: assetId,
        },
      ],
      edges: [
        {
          id: `room:${assetId}`,
          source: room,
          target: asset,
          sourcePath: '/rooms/room-a/data/background/asset/$ref',
          targetPath: `/assets/${assetId}`,
          role: 'room-background',
          facets: ['reference-integrity', 'preview-visual'],
          targetImpactPaths: [`/assets/${assetId}/data/source/path`],
          repair: { kind: 'set-null', path: '/rooms/room-a/data/background/asset' },
        },
      ],
      occurrences: [],
      diagnostics: [],
    });
    return projectNativeGraphForRenderer(graph, 'project-one', projectRevision);
  }

  it('invalidates native Room closure using both prior and new edges, but not unrelated Assets', async () => {
    const coordinator = new FocusedPreviewFreshnessCoordinator();
    const lease = createLease(vi.fn().mockResolvedValue(appliedResult));
    const project = createAuthoringProject();
    const original = nativeRoomGraph(1, 'old');
    const rewired = nativeRoomGraph(2, 'new');
    const submit = (
      projectRevision: number,
      graph: ReturnType<typeof nativeRoomGraph>,
      previousGraph: ReturnType<typeof nativeRoomGraph> | null,
      affectedPaths: string[],
    ) => {
      coordinator.submit({
        project,
        projectSessionId: '11111111-1111-4111-8111-111111111111',
        projectInstanceId: 'project-one',
        projectRevision,
        affectedPaths,
        graph,
        previousGraph,
        sourceAnalysis: [],
        root: { kind: 'room-preview', recordId: 'room-a' },
        inputs: { displayPreference: { mode: 'project' } },
        lease,
      });
    };
    submit(1, original, null, ['/']);
    await runNextFrame();
    expect(adapterBuild).toHaveBeenCalledTimes(1);
    submit(2, rewired, original, ['/assets/other/data/source/path']);
    await runNextFrame();
    expect(adapterBuild).toHaveBeenCalledTimes(1);
    submit(2, rewired, original, ['/assets/old/data/source/path']);
    await runNextFrame();
    expect(adapterBuild).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });

  it('rebuilds the focused native Room on physical source generation changes without Project edits', async () => {
    const coordinator = new FocusedPreviewFreshnessCoordinator();
    const lease = createLease(vi.fn().mockResolvedValue(appliedResult));
    const project = createAuthoringProject();
    const submit = (graph: ReturnType<typeof nativeRoomGraph>) =>
      coordinator.submit({
        project,
        projectSessionId: '11111111-1111-4111-8111-111111111111',
        projectInstanceId: 'project-one',
        projectRevision: 1,
        affectedPaths: [],
        graph,
        sourceAnalysis: [],
        root: { kind: 'room-preview', recordId: 'room-a' },
        inputs: { displayPreference: { mode: 'project' } },
        lease,
      });
    submit(nativeRoomGraph(1, 'old', 1));
    await runNextFrame();
    submit(nativeRoomGraph(1, 'old', 2));
    await runNextFrame();
    expect(adapterBuild).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });
  it('reuses retained committed content and its native resolution after a coordinator remount', async () => {
    const applyFocusedEditorDocument = vi.fn().mockResolvedValue(appliedResult);
    const lease = createLease(
      applyFocusedEditorDocument,
      `focused:project-one:room-preview:room-a:${revision}:glsl-330`,
      appliedResult,
    );
    const coordinator = new FocusedPreviewFreshnessCoordinator();

    coordinator.submit({
      project: createAuthoringProject(),
      projectSessionId: '11111111-1111-4111-8111-111111111111',
      projectInstanceId: 'project-one',
      projectRevision: 1,
      affectedPaths: ['/'],
      graph: null,
      sourceAnalysis: [],
      root: { kind: 'room-preview', recordId: 'room-a' },
      inputs: { displayPreference: { mode: 'project' } },
      lease,
    });

    await runNextFrame();

    expect(applyFocusedEditorDocument).not.toHaveBeenCalled();
    expect(lease.reveal).toHaveBeenCalledTimes(1);
  });

  it('rejects an equivalent resubmission before rebuilding focused preview content', async () => {
    const applyFocusedEditorDocument = vi.fn().mockResolvedValue(undefined);
    const lease = createLease(applyFocusedEditorDocument);
    const coordinator = new FocusedPreviewFreshnessCoordinator();
    const project = createAuthoringProject();
    const submit = () =>
      coordinator.submit({
        project,
        projectSessionId: '11111111-1111-4111-8111-111111111111',
        projectInstanceId: 'project-one',
        projectRevision: 1,
        affectedPaths: ['/'],
        graph: null,
        sourceAnalysis: [],
        root: { kind: 'room-preview', recordId: 'room-a' },
        inputs: { displayPreference: { mode: 'project' } },
        lease,
      });

    submit();
    await runNextFrame();
    submit();
    await runNextFrame();

    expect(adapterBuild).toHaveBeenCalledTimes(1);
    expect(applyFocusedEditorDocument).toHaveBeenCalledTimes(1);
  });

  it('does not reuse committed content from another project instance', async () => {
    const applyFocusedEditorDocument = vi.fn().mockResolvedValue(appliedResult);
    const lease = createLease(
      applyFocusedEditorDocument,
      `focused:project-one:room-preview:room-a:${revision}:glsl-330`,
    );
    const coordinator = new FocusedPreviewFreshnessCoordinator();

    coordinator.submit({
      project: createAuthoringProject(),
      projectSessionId: '22222222-2222-4222-8222-222222222222',
      projectInstanceId: 'project-two',
      projectRevision: 1,
      affectedPaths: ['/'],
      graph: null,
      sourceAnalysis: [],
      root: { kind: 'room-preview', recordId: 'room-a' },
      inputs: { displayPreference: { mode: 'project' } },
      lease,
    });

    await runNextFrame();

    expect(applyFocusedEditorDocument).toHaveBeenCalledTimes(1);
    expect(lease.reveal).toHaveBeenCalledTimes(1);
  });

  it('returns the native Room resolution while keeping a semantic-only focused host concealed', async () => {
    const applyFocusedEditorDocument = vi.fn().mockResolvedValue(appliedResult);
    const lease = createLease(applyFocusedEditorDocument);
    const onApplied = vi.fn();
    const coordinator = new FocusedPreviewFreshnessCoordinator();

    coordinator.submit({
      project: createAuthoringProject(),
      projectSessionId: '11111111-1111-4111-8111-111111111111',
      projectInstanceId: 'project-one',
      projectRevision: 1,
      affectedPaths: ['/'],
      graph: null,
      sourceAnalysis: [],
      root: { kind: 'room-preview', recordId: 'room-a' },
      inputs: { displayPreference: { mode: 'project' } },
      lease,
      onApplied,
      revealOnApplied: false,
    });

    await runNextFrame();

    expect(onApplied).toHaveBeenCalledWith(appliedResult);
    expect(lease.conceal).toHaveBeenCalledTimes(1);
    expect(lease.reveal).not.toHaveBeenCalled();
  });

  it('reports a current apply failure without retrying the same document every frame', async () => {
    const applyFocusedEditorDocument = vi.fn().mockRejectedValue(new Error('native apply failed'));
    const reportBuildFailure = vi.fn();
    const coordinator = new FocusedPreviewFreshnessCoordinator();

    coordinator.submit({
      project: createAuthoringProject(),
      projectSessionId: '11111111-1111-4111-8111-111111111111',
      projectInstanceId: 'project-one',
      projectRevision: 1,
      affectedPaths: ['/'],
      graph: null,
      sourceAnalysis: [],
      root: { kind: 'room-preview', recordId: 'room-a' },
      inputs: { displayPreference: { mode: 'project' } },
      lease: createLease(applyFocusedEditorDocument),
      reportBuildFailure,
    });

    await runNextFrame();

    expect(applyFocusedEditorDocument).toHaveBeenCalledTimes(1);
    expect(reportBuildFailure).toHaveBeenCalledWith('native apply failed');
    expect(frames).toHaveLength(0);
  });
});
