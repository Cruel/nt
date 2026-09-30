import type {
  AuthoringDependencyGraphDiagnostic,
  AuthoringDependencyGraphSnapshot,
} from '../../shared/authoring-dependency-contracts';
import {
  findPreviewRootsImpactedByPathUnion,
  findPreviewRootsImpactedByPaths,
  recordNodeKey,
  serializeAuthoringDependencyNodeKey,
} from '../../shared/authoring-dependency-graph';
import type {
  AppliedPreviewDocumentResult,
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
  projectSessionId: string | null;
  projectInstanceId: string;
  projectRevision: number;
  affectedPaths: readonly string[];
  graph: AuthoringDependencyGraphSnapshot | null;
  previousGraph?: AuthoringDependencyGraphSnapshot | null;
  sourceAnalysis: readonly AuthoringSourceAnalysisArtifact<AuthoringDependencyGraphDiagnostic>[];
  root: PreviewRootKey;
  inputs: unknown;
  lease: PreviewHostLease;
  onLoadingChange?(loading: boolean): void;
  onApplied?(result: AppliedPreviewDocumentResult): void;
  revealOnApplied?: boolean;
  reportBuildFailure?(message: string): void;
}

export class FocusedPreviewFreshnessCoordinator {
  private desired: FocusedPreviewDesiredState | null = null;
  private scheduledFrame = 0;
  private inFlight = false;
  private pending = false;
  private currentApplySequence = 0;
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
    result: AppliedPreviewDocumentResult;
  } | null = null;
  private disposed = false;

  submit(next: FocusedPreviewDesiredState): void {
    if (this.disposed) return;
    this.desired = next;
    this.desiredGeneration += 1;
    this.pending = true;
    next.onLoadingChange?.(true);
    this.schedule();
  }

  release(leaseId: string): void {
    if (this.desired?.lease.leaseId === leaseId) {
      this.desired.onLoadingChange?.(false);
      this.desired = null;
    }
    if (this.lastApplied?.leaseId === leaseId) this.lastApplied = null;
  }

  dispose(): void {
    this.disposed = true;
    this.desired?.onLoadingChange?.(false);
    this.desired = null;
    if (this.scheduledFrame) cancelAnimationFrame(this.scheduledFrame);
  }

  private schedule(): void {
    if (this.scheduledFrame) {
      return;
    }
    this.scheduledFrame = requestAnimationFrame(() => {
      this.scheduledFrame = 0;
      void this.flush();
    });
  }

  private rootKeyText(state: FocusedPreviewDesiredState): string {
    if (state.root.kind === 'shader-preview')
      throw new Error(
        'Authored Shader focused previews were removed; shader source previews use source tabs.',
      );
    const collection = state.root.kind === 'layout-preview' ? 'layouts' : 'rooms';
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
    const previous = state.previousGraph;
    if (
      previous &&
      previous.projectInstanceId === state.projectInstanceId &&
      previous.projectRevision < state.projectRevision
    ) {
      return (
        findPreviewRootsImpactedByPathUnion(
          previous.graph,
          state.graph.graph,
          [rootKeyText],
          state.affectedPaths,
        ).length > 0
      );
    }
    return (
      findPreviewRootsImpactedByPaths(state.graph.graph, [rootKeyText], state.affectedPaths)
        .length > 0
    );
  }

  private async prepareBuild(state: FocusedPreviewDesiredState): Promise<{
    adapter: ReturnType<typeof focusedPreviewAdapterFor>;
    inputs: unknown;
    inputRevision: Awaited<ReturnType<typeof canonicalFocusedPreviewInputRevision>>;
    activeShaderVariant: FocusedPreviewHostCapabilities['activeShaderVariant'];
  } | null> {
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
    if (!activeShaderVariant) return null;
    const hostCapabilities: FocusedPreviewHostCapabilities = { activeShaderVariant };
    const inputRevision = await canonicalFocusedPreviewInputRevision({ inputs, hostCapabilities });
    return { adapter, inputs, inputRevision, activeShaderVariant };
  }

  private async build(
    state: FocusedPreviewDesiredState,
    prepared: NonNullable<Awaited<ReturnType<FocusedPreviewFreshnessCoordinator['prepareBuild']>>>,
  ): Promise<FocusedRecordPreviewDocument> {
    const hostCapabilities: FocusedPreviewHostCapabilities = {
      activeShaderVariant: prepared.activeShaderVariant,
    };
    return prepared.adapter.build({
      project: state.project,
      projectSessionId: state.projectSessionId,
      projectInstanceId: state.projectInstanceId,
      projectRevision: state.projectRevision,
      root: state.root,
      inputs: prepared.inputs,
      inputRevision: prepared.inputRevision,
      graph: state.graph,
      sourceAnalysis: state.sourceAnalysis,
      hostCapabilities,
    });
  }

  private contentKey(document: FocusedRecordPreviewDocument, activeShaderVariant: string): string {
    return [
      'focused',
      document.projectInstanceId,
      document.kind,
      document.recordId,
      document.revision,
      activeShaderVariant,
    ].join(':');
  }

  private async flush(): Promise<void> {
    if (this.inFlight || this.disposed) return;
    const state = this.desired;
    if (!state || !this.pending) return;

    this.inFlight = true;
    try {
      const desiredGeneration = this.desiredGeneration;
      this.pending = false;
      const transportGeneration = state.lease.transportGeneration();
      const replay =
        this.lastApplied?.leaseId === state.lease.leaseId &&
        this.lastApplied.transportGeneration !== transportGeneration;
      let prepared: Awaited<ReturnType<FocusedPreviewFreshnessCoordinator['prepareBuild']>>;
      try {
        prepared = await this.prepareBuild(state);
      } catch (error) {
        state.reportBuildFailure?.(
          error instanceof Error ? error.message : 'Focused preview input preparation failed.',
        );
        state.onLoadingChange?.(false);
        return;
      }
      if (this.disposed || this.desired !== state || desiredGeneration !== this.desiredGeneration)
        return;
      if (!prepared) {
        this.pending = true;
        return;
      }
      const { inputRevision, activeShaderVariant } = prepared;
      if (!replay && !this.impacted(state, inputRevision, activeShaderVariant)) {
        state.onLoadingChange?.(false);
        return;
      }
      let document: FocusedRecordPreviewDocument;
      try {
        document = await this.build(state, prepared);
      } catch (error) {
        state.reportBuildFailure?.(
          error instanceof Error ? error.message : 'Focused preview document construction failed.',
        );
        state.onLoadingChange?.(false);
        return;
      }
      if (this.disposed || this.desired !== state || desiredGeneration !== this.desiredGeneration)
        return;
      const contentKey = this.contentKey(document, activeShaderVariant);
      const retainedContent = state.lease.committedContentKey() === contentKey;
      const retainedResult = state.lease.committedFocusedResult();
      const matchingLastApplied =
        this.lastApplied?.leaseId === state.lease.leaseId &&
        this.lastApplied.revision === document.revision;
      const reusableResult = matchingLastApplied
        ? this.lastApplied!.result
        : retainedResult?.projectInstanceId === state.projectInstanceId &&
            retainedResult.kind === state.root.kind &&
            retainedResult.recordId === state.root.recordId &&
            retainedResult.revision === document.revision
          ? retainedResult
          : null;
      if (retainedContent && reusableResult) {
        state.onApplied?.(reusableResult);
        if (state.revealOnApplied === false) state.lease.conceal();
        else state.lease.reveal();
        state.onLoadingChange?.(false);
        return;
      }
      const retainedContentNeedsResult = retainedContent && !reusableResult;
      const impactedResult =
        retainedContentNeedsResult ||
        replay ||
        this.impacted(state, inputRevision, activeShaderVariant);
      if (!impactedResult) {
        state.onLoadingChange?.(false);
        return;
      }
      if (
        !replay &&
        this.lastApplied?.leaseId === state.lease.leaseId &&
        this.lastApplied.revision === document.revision
      ) {
        state.onLoadingChange?.(false);
        return;
      }

      const sequence = state.lease.nextFocusedApplySequence();
      this.currentApplySequence = sequence;
      try {
        const result = await state.lease.send((controller) =>
          controller.applyFocusedEditorDocument(document, sequence),
        );
        if (
          this.desired?.lease.leaseId !== state.lease.leaseId ||
          sequence !== this.currentApplySequence ||
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
          result,
        };
        state.onApplied?.(result);
        state.lease.commitContent(contentKey);
        state.lease.commitFocusedResult(result);
        if (state.revealOnApplied === false) state.lease.conceal();
        else state.lease.reveal();
        state.onLoadingChange?.(false);
      } catch (error) {
        if (
          this.desired?.lease.leaseId === state.lease.leaseId &&
          desiredGeneration === this.desiredGeneration
        ) {
          state.reportBuildFailure?.(
            error instanceof Error ? error.message : 'Focused preview application failed.',
          );
          state.onLoadingChange?.(false);
        }
      }
    } finally {
      this.inFlight = false;
      if (this.pending) this.schedule();
    }
  }
}
