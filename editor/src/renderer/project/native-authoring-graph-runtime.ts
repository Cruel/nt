import { useCommandStore } from '../commands/command-store';
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
      this.token++;
      this.current = null;
      this.previous = null;
      this.requested = null;
      this.notify();
      return Promise.resolve();
    }
    if (!sameIdentity(identity, this.requested)) {
      if (this.current?.projectInstanceId === identity.instance) this.previous = this.current;
      else this.previous = null;
    }
    this.requested = identity;
    this.current = null;
    this.lastError = null;
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
        );
        this.current = { ...snapshot, graphRevision: ++this.graphRevision };
        this.notify();
      })
      .catch((error: unknown) => {
        if (token !== this.token || !sameIdentity(identity, currentIdentity())) return;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.current = null;
        this.notify();
      });
  }
  synchronize() {
    const identity = currentIdentity();
    if (!sameIdentity(identity, this.requested)) void this.refresh();
  }
}

export const nativeRendererGraphService = new NativeRendererGraphService();
