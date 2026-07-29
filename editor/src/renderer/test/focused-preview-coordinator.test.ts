import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { FocusedRecordPreviewDocument } from '../../shared/focused-preview-contracts';
import type { EnginePreviewController } from '@/hooks/use-engine-preview';
import type { PreviewHostLease } from '@/preview/preview-host-pool';
import { FocusedPreviewFreshnessCoordinator } from '@/preview/focused-preview-coordinator';

const revision = `sha256:${'0'.repeat(64)}` as const;
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

vi.mock('@/preview/focused-preview-adapters', () => ({
  canonicalFocusedPreviewInputRevision: () => revision,
  validateFocusedPreviewInputs: (_kind: string, inputs: unknown) => inputs,
  focusedPreviewAdapterFor: () => ({
    topologyDependent: false,
    owningPath: () => '/rooms/room-a',
    build: () => focusedDocument,
  }),
}));

let frames: FrameRequestCallback[];

async function runNextFrame() {
  const frame = frames.shift();
  if (!frame) throw new Error('Expected a scheduled animation frame.');
  frame(0);
  await Promise.resolve();
  await Promise.resolve();
}

function createLease(
  applyFocusedEditorDocument: ReturnType<typeof vi.fn>,
  initialCommittedContentKey: string | null = null,
) {
  let applySequence = 0;
  let committedContentKey = initialCommittedContentKey;
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
    activeShaderVariant: () => 'glsl-120',
    committedContentKey: () => committedContentKey,
    commitContent: (key: string) => {
      committedContentKey = key;
    },
    nextFocusedApplySequence: () => ++applySequence,
    subscribeReady: () => () => undefined,
    reveal: vi.fn(),
    send: <TResult>(command: (value: EnginePreviewController) => Promise<TResult>) =>
      command(controller),
  } satisfies PreviewHostLease;
}

beforeEach(() => {
  frames = [];
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
  it('reuses a retained committed document without another native apply', async () => {
    const applyFocusedEditorDocument = vi.fn().mockResolvedValue(undefined);
    const lease = createLease(
      applyFocusedEditorDocument,
      `focused:room-preview:room-a:${revision}:glsl-120`,
    );
    const coordinator = new FocusedPreviewFreshnessCoordinator();

    coordinator.submit({
      project: createAuthoringProject(),
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

  it('reports a current apply failure without retrying the same document every frame', async () => {
    const applyFocusedEditorDocument = vi.fn().mockRejectedValue(new Error('native apply failed'));
    const reportBuildFailure = vi.fn();
    const coordinator = new FocusedPreviewFreshnessCoordinator();

    coordinator.submit({
      project: createAuthoringProject(),
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
