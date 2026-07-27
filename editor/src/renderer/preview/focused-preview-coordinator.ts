import type {
  AuthoringDependencyGraphDiagnostic,
  AuthoringDependencyGraphSnapshot,
} from '../../shared/authoring-dependency-contracts';
import {
  findPreviewRootsImpactedByPaths,
  recordNodeKey,
  serializeAuthoringDependencyNodeKey,
} from '../../shared/authoring-dependency-graph';
import type {
  FocusedPreviewHostCapabilities,
  FocusedRecordPreviewDocument,
  PreviewRootKey,
} from '../../shared/focused-preview-contracts';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import type { AuthoringSourceAnalysisArtifact } from '../../shared/project-schema/authoring-lua-analysis';
import type { PreviewHostLease } from './preview-host-pool';
import {
  canonicalFocusedPreviewInputRevision,
  focusedPreviewAdapterFor,
  validateFocusedPreviewInputs,
} from './focused-preview-adapters';

export interface FocusedPreviewDesiredState {
  project: AuthoringProject;
  projectInstanceId: string;
  projectRevision: number;
  affectedPaths: readonly string[];
  graph: AuthoringDependencyGraphSnapshot | null;
  sourceAnalysis: readonly AuthoringSourceAnalysisArtifact<AuthoringDependencyGraphDiagnostic>[];
  root: PreviewRootKey;
  inputs: unknown;
  lease: PreviewHostLease;
}

export class FocusedPreviewFreshnessCoordinator {
  private desired: FocusedPreviewDesiredState | null = null;
  private scheduledFrame = 0;
  private inFlight = false;
  private pending = false;
  private applySequence = 0;
  private desiredGeneration = 0;
  private lastApplied: {
    leaseId: string;
    revision: string;
    transportGeneration: number | null;
    projectInstanceId: string;
    projectRevision: number;
    rootKeyText: string;
    inputRevision: string;
    activeShaderVariant: string;
  } | null = null;
  private disposed = false;

  submit(next: FocusedPreviewDesiredState): void {
    if (this.disposed) return;
    console.log(
      'DEBUG coordinator submit:',
      next.root.kind,
      next.root.recordId,
      'lease:',
      next.lease.leaseId,
    );
    this.desired = next;
    this.desiredGeneration += 1;
    this.pending = true;
    this.schedule();
  }

  release(leaseId: string): void {
    if (this.desired?.lease.leaseId === leaseId) this.desired = null;
    if (this.lastApplied?.leaseId === leaseId) this.lastApplied = null;
  }

  dispose(): void {
    this.disposed = true;
    this.desired = null;
    if (this.scheduledFrame) cancelAnimationFrame(this.scheduledFrame);
  }

  private schedule(): void {
    if (this.scheduledFrame) {
      console.log('DEBUG schedule: already scheduled, frame id', this.scheduledFrame);
      return;
    }
    console.log('DEBUG schedule: requesting frame');
    this.scheduledFrame = requestAnimationFrame(() => {
      console.log('DEBUG schedule: frame fired, calling flush');
      this.scheduledFrame = 0;
      void this.flush();
    });
  }

  private rootKeyText(state: FocusedPreviewDesiredState): string {
    const collection =
      state.root.kind === 'layout-preview'
        ? 'layouts'
        : state.root.kind === 'shader-preview'
          ? 'shaders'
          : 'rooms';
    return serializeAuthoringDependencyNodeKey(recordNodeKey(collection, state.root.recordId));
  }

  private impacted(
    state: FocusedPreviewDesiredState,
    inputRevision: string,
    activeShaderVariant: string,
  ): boolean {
    if (!this.lastApplied || this.lastApplied.leaseId !== state.lease.leaseId) return true;
    const rootKeyText = this.rootKeyText(state);
    if (
      this.lastApplied.projectInstanceId !== state.projectInstanceId ||
      this.lastApplied.rootKeyText !== rootKeyText ||
      this.lastApplied.inputRevision !== inputRevision ||
      this.lastApplied.activeShaderVariant !== activeShaderVariant
    )
      return true;
    if (this.lastApplied.projectRevision === state.projectRevision) return false;
    const adapter = focusedPreviewAdapterFor(state.root.kind);
    if (state.affectedPaths.length === 0) return true;
    const owner = adapter.owningPath(state.root);
    const direct = state.affectedPaths.some(
      (path) =>
        path === '/' ||
        path === owner ||
        path.startsWith(`${owner}/`) ||
        owner.startsWith(`${path}/`),
    );
    if (direct) return true;
    if (
      !state.graph ||
      state.graph.projectInstanceId !== state.projectInstanceId ||
      state.graph.projectRevision !== state.projectRevision
    )
      return true;
    return (
      findPreviewRootsImpactedByPaths(state.graph.graph, [rootKeyText], state.affectedPaths)
        .length > 0
    );
  }

  private build(state: FocusedPreviewDesiredState): {
    document: FocusedRecordPreviewDocument;
    inputRevision: string;
    activeShaderVariant: string;
  } | null {
    const adapter = focusedPreviewAdapterFor(state.root.kind);
    if (
      adapter.topologyDependent &&
      (!state.graph ||
        state.graph.projectInstanceId !== state.projectInstanceId ||
        state.graph.projectRevision !== state.projectRevision)
    )
      return null;
    const inputs = validateFocusedPreviewInputs(state.root.kind, state.inputs);
    const activeShaderVariant = state.lease.activeShaderVariant();
    console.log(
      'DEBUG coordinator build:',
      state.root.kind,
      state.root.recordId,
      'activeShaderVariant:',
      activeShaderVariant,
      'lease:',
      state.lease.leaseId,
    );
    if (!activeShaderVariant) return null;
    const hostCapabilities: FocusedPreviewHostCapabilities = { activeShaderVariant };
    const inputRevision = canonicalFocusedPreviewInputRevision({ inputs, hostCapabilities });
    return {
      document: adapter.build({
        project: state.project,
        projectInstanceId: state.projectInstanceId,
        projectRevision: state.projectRevision,
        root: state.root,
        inputs,
        inputRevision,
        graph: state.graph,
        sourceAnalysis: state.sourceAnalysis,
        hostCapabilities,
      }),
      inputRevision,
      activeShaderVariant,
    };
  }

  private async flush(): Promise<void> {
    if (this.inFlight || this.disposed) return;
    const state = this.desired;
    if (!state || !this.pending) return;
    const desiredGeneration = this.desiredGeneration;
    this.pending = false;
    const transportGeneration = state.lease.transportGeneration();
    const replay =
      this.lastApplied?.leaseId === state.lease.leaseId &&
      this.lastApplied.transportGeneration !== transportGeneration;
    let built: ReturnType<FocusedPreviewFreshnessCoordinator['build']>;
    try {
      built = this.build(state);
    } catch {
      return;
    }
    if (!built) {
      this.pending = true;
      return;
    }
    const { document, inputRevision, activeShaderVariant } = built;
    const impactedResult = replay || this.impacted(state, inputRevision, activeShaderVariant);
    if (!impactedResult) return;
    if (
      !replay &&
      this.lastApplied?.leaseId === state.lease.leaseId &&
      this.lastApplied.revision === document.revision
    )
      return;

    this.inFlight = true;
    const sequence = ++this.applySequence;
    try {
      await state.lease.send((controller) =>
        controller.applyFocusedEditorDocument(document, sequence),
      );
      if (
        this.desired?.lease.leaseId !== state.lease.leaseId ||
        sequence !== this.applySequence ||
        desiredGeneration !== this.desiredGeneration
      )
        return;
      this.lastApplied = {
        leaseId: state.lease.leaseId,
        revision: document.revision,
        transportGeneration,
        projectInstanceId: state.projectInstanceId,
        projectRevision: state.projectRevision,
        rootKeyText: this.rootKeyText(state),
        inputRevision,
        activeShaderVariant,
      };
      state.lease.reveal();
    } catch {
      if (this.desired?.lease.leaseId === state.lease.leaseId) this.pending = true;
    } finally {
      this.inFlight = false;
      if (this.pending) this.schedule();
    }
  }
}
