import { useCommandStore } from '../commands/command-store';
import { nativeGraphAllowsIncompleteTargetDeletion } from '../../main/services/native-semantic-graph-queries';
import { useProjectStore } from './project-store';
import {
  projectNativeGraphForRenderer,
  type NativeRendererGraphSnapshot,
} from './native-authoring-graph-projection';

interface Identity {
  session: string;
  instance: string;
  projectRevision: number;
  nativeRevision: number;
}

function currentIdentity(): Identity | null {
  const project = useProjectStore.getState();
  const commands = useCommandStore.getState();
  if (
    !project.projectSessionId ||
    !project.projectInstanceId ||
    commands.nativeWorkingRevision === null ||
    commands.nativeProjectSessionId !== project.projectSessionId ||
    commands.nativeProjectionRevision !== project.projectRevision ||
    commands.nativeMutationPending ||
    commands.nativeMutationFailure
  )
    return null;
  return {
    session: project.projectSessionId,
    instance: project.projectInstanceId,
    projectRevision: project.projectRevision,
    nativeRevision: commands.nativeWorkingRevision,
  };
}

function sameIdentity(left: Identity | null, right: Identity | null) {
  return JSON.stringify(left) === JSON.stringify(right);
}

class NativeRendererGraphService {
  private readonly listeners = new Set<() => void>();
  private current: NativeRendererGraphSnapshot | null = null;
  private previewCurrent: NativeRendererGraphSnapshot | null = null;
  private displayed: NativeRendererGraphSnapshot | null = null;
  private previous: NativeRendererGraphSnapshot | null = null;
  private requested: Identity | null = null;
  private token = 0;
  private version = 0;
  private graphRevision = 0;
  private lastError: string | null = null;

  state = () => this.version;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private notify() {
    this.version++;
    for (const listener of this.listeners) listener();
  }
  currentSnapshot(): NativeRendererGraphSnapshot | null {
    const identity = currentIdentity();
    return identity &&
      this.current?.projectInstanceId === identity.instance &&
      this.current.projectRevision === identity.projectRevision &&
      this.current.nativeGraph.workingRevision === identity.nativeRevision
      ? this.current
      : null;
  }
  /** Read-only preview graph. Incomplete records are checked against the
   * selected preview's dependency closure before building its document. */
  previewSnapshot(): NativeRendererGraphSnapshot | null {
    const identity = currentIdentity();
    return identity &&
      this.previewCurrent?.projectInstanceId === identity.instance &&
      this.previewCurrent.projectRevision === identity.projectRevision &&
      this.previewCurrent.nativeGraph.workingRevision === identity.nativeRevision
      ? this.previewCurrent
      : null;
  }
  deletionSnapshot(
    collection: string,
    entityId: string,
    force = false,
  ): NativeRendererGraphSnapshot | null {
    const complete = this.currentSnapshot();
    if (complete) return complete;
    const partial = this.previewSnapshot();
    return partial &&
      nativeGraphAllowsIncompleteTargetDeletion(
        partial.nativeGraph,
        {
          kind: 'record',
          collection,
          id: entityId,
        },
        force,
      )
      ? partial
      : null;
  }
  /** Last admitted graph for display only. It can be a prior revision during
   * native mutation/requery and must never authorize destructive commands.
   * Project identity is checked even when the command store is temporarily
   * unable to expose a mutation-ready identity.
   */
  displayedSnapshot(): NativeRendererGraphSnapshot | null {
    const project = useProjectStore.getState();
    return this.displayed?.projectInstanceId === project.projectInstanceId &&
      this.displayed.nativeGraph.projectSessionId === project.projectSessionId
      ? this.displayed
      : null;
  }
  previousSnapshot() {
    const identity = currentIdentity();
    return identity && this.previous?.projectInstanceId === identity.instance
      ? this.previous
      : null;
  }
  error() {
    return this.lastError;
  }
  refresh() {
    const identity = currentIdentity();
    if (!identity) {
      const project = useProjectStore.getState();
      if (
        this.displayed?.projectInstanceId !== project.projectInstanceId ||
        this.displayed.nativeGraph.projectSessionId !== project.projectSessionId
      ) {
        this.displayed = null;
        this.lastError = null;
      }
      this.token++;
      this.current = null;
      this.previewCurrent = null;
      this.previous = null;
      this.requested = null;
      this.notify();
      return Promise.resolve();
    }
    const revisionChanged = !sameIdentity(identity, this.requested);
    if (revisionChanged) {
      if (this.current?.projectInstanceId === identity.instance) this.previous = this.current;
      else this.previous = null;
      if (
        identity.instance !== this.requested?.instance ||
        identity.session !== this.requested?.session
      )
        this.lastError = null;
    }
    this.requested = identity;
    // Re-query invalidates mutation authority, but never the visible review.
    // This also protects other commands that do not use Delete's click-time
    // revalidation from relying on physical sources being rechecked.
    this.current = null;
    this.previewCurrent = null;
    const token = ++this.token;
    this.notify();
    return Promise.resolve()
      .then(() =>
        window.noveltea.nativeProjectSemanticGraph(identity.session, identity.nativeRevision),
      )
      .then((graph) => {
        if (token !== this.token || !sameIdentity(identity, currentIdentity())) return;
        if (
          graph.projectSessionId !== identity.session ||
          graph.workingRevision !== identity.nativeRevision
        )
          throw new Error('Native graph reply belongs to a superseded Project revision.');
        const snapshot = projectNativeGraphForRenderer(
          graph,
          identity.instance,
          identity.projectRevision,
          { readOnlyScopedPreview: true },
        );
        const projected = { ...snapshot, graphRevision: ++this.graphRevision };
        this.previewCurrent = projected;
        // A failed/incomplete global scan is not a new reference summary.
        // Keep the last verified content until a usable projection arrives.
        const firstIncompleteOwner = graph.incompleteOwners[0]?.split('/');
        const recordScopedPartial =
          firstIncompleteOwner?.length === 2 &&
          nativeGraphAllowsIncompleteTargetDeletion(
            graph,
            { kind: 'record', collection: firstIncompleteOwner[0]!, id: firstIncompleteOwner[1]! },
            true,
          );
        if ((graph.complete && graph.incompleteOwners.length === 0) || recordScopedPartial)
          this.displayed = projected;
        if (graph.complete && graph.incompleteOwners.length === 0) {
          this.current = projected;
          this.lastError = null;
        } else {
          this.current = null;
          this.lastError =
            'Native semantic graph is incomplete; unsafe editor actions are blocked.';
        }
        this.notify();
      })
      .catch((error: unknown) => {
        if (token !== this.token || !sameIdentity(identity, currentIdentity())) return;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.current = null;
        this.previewCurrent = null;
        this.notify();
      });
  }
  synchronize() {
    const identity = currentIdentity();
    if (!sameIdentity(identity, this.requested)) void this.refresh();
  }
}

export const nativeRendererGraphService = new NativeRendererGraphService();
