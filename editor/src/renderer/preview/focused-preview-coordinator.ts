import type {
  AuthoringDependencyGraphDiagnostic,
  AuthoringDependencyGraphSnapshot,
} from '../../shared/authoring-dependency-contracts';
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
  private lastApplied: {
    leaseId: string;
    revision: string;
    transportGeneration: number | null;
  } | null = null;
  private disposed = false;

  submit(next: FocusedPreviewDesiredState): void {
    if (this.disposed) return;
    this.desired = next;
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
    if (this.scheduledFrame || this.inFlight || this.disposed) return;
    this.scheduledFrame = requestAnimationFrame(() => {
      this.scheduledFrame = 0;
      void this.flush();
    });
  }

  private impacted(state: FocusedPreviewDesiredState): boolean {
    if (!this.lastApplied || this.lastApplied.leaseId !== state.lease.leaseId) return true;
    const adapter = focusedPreviewAdapterFor(state.root.kind);
    if (state.affectedPaths.length === 0) return false;
    const owner = adapter.owningPath(state.root);
    const direct = state.affectedPaths.some(
      (path) =>
        path === '/' ||
        path === owner ||
        path.startsWith(`${owner}/`) ||
        owner.startsWith(`${path}/`),
    );
    if (direct) return true;
    if (!state.graph) return true;
    for (const edge of state.graph.graph.edgesById.values()) {
      if (!edge.targetImpactPaths.some((path) => path === owner || path.startsWith(`${owner}/`)))
        continue;
      if (
        state.affectedPaths.some(
          (path) =>
            path === edge.sourcePath ||
            path.startsWith(`${edge.sourcePath}/`) ||
            edge.sourcePath.startsWith(`${path}/`),
        )
      )
        return true;
    }
    return false;
  }

  private build(state: FocusedPreviewDesiredState): FocusedRecordPreviewDocument | null {
    const adapter = focusedPreviewAdapterFor(state.root.kind);
    if (adapter.topologyDependent && !state.graph) return null;
    const inputs = validateFocusedPreviewInputs(state.root.kind, state.inputs);
    const activeShaderVariant = state.lease.activeShaderVariant();
    if (!activeShaderVariant) return null;
    const hostCapabilities: FocusedPreviewHostCapabilities = { activeShaderVariant };
    const inputRevision = canonicalFocusedPreviewInputRevision({ inputs, hostCapabilities });
    return adapter.build({
      project: state.project,
      projectInstanceId: state.projectInstanceId,
      projectRevision: state.projectRevision,
      root: state.root,
      inputs,
      inputRevision,
      graph: state.graph,
      sourceAnalysis: state.sourceAnalysis,
      hostCapabilities,
    });
  }

  private async flush(): Promise<void> {
    if (this.inFlight || this.disposed) return;
    const state = this.desired;
    if (!state || !this.pending) return;
    this.pending = false;
    const transportGeneration = state.lease.transportGeneration();
    const replay =
      this.lastApplied?.leaseId === state.lease.leaseId &&
      this.lastApplied.transportGeneration !== transportGeneration;
    if (!replay && !this.impacted(state)) return;
    const document = this.build(state);
    if (!document) {
      this.pending = true;
      this.schedule();
      return;
    }
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
      if (this.desired?.lease.leaseId !== state.lease.leaseId || sequence !== this.applySequence)
        return;
      this.lastApplied = {
        leaseId: state.lease.leaseId,
        revision: document.revision,
        transportGeneration,
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
