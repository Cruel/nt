import { useSyncExternalStore } from 'react';
import { useCommandStore } from '../commands/command-store';
import { useProjectStore } from './project-store';
import { nativeRendererGraphService } from './native-authoring-graph-runtime';

let unsubscribe: (() => void) | null = null;

export function isAuthoringDependencyGraphServiceStarted(): boolean {
  return unsubscribe !== null;
}

export function startAuthoringDependencyGraphService(): () => void {
  if (unsubscribe) return unsubscribe;
  const synchronize = () => nativeRendererGraphService.synchronize();
  const unsubscribeProject = useProjectStore.subscribe(synchronize);
  const unsubscribeCommands = useCommandStore.subscribe(synchronize);
  synchronize();
  unsubscribe = () => {
    unsubscribeProject();
    unsubscribeCommands();
    unsubscribe = null;
  };
  return unsubscribe;
}

export function refreshAuthoringDependencyGraphProjectSources() {
  return nativeRendererGraphService.refresh();
}

export function useCurrentAuthoringDependencyGraphSnapshot() {
  useCommandStore((state) => state.nativeWorkingRevision);
  useProjectStore((state) => state.projectRevision);
  useSyncExternalStore(
    nativeRendererGraphService.subscribe,
    nativeRendererGraphService.state,
    nativeRendererGraphService.state,
  );
  return nativeRendererGraphService.currentSnapshot();
}

/** Read-only focused previews may use a partial native graph after checking
 * that incomplete owners are outside the requested preview closure. */
export function useScopedAuthoringDeletionGraphSnapshot(
  collection: string,
  entityId: string,
  force = false,
) {
  useCommandStore((state) => state.nativeWorkingRevision);
  useProjectStore((state) => state.projectRevision);
  useSyncExternalStore(
    nativeRendererGraphService.subscribe,
    nativeRendererGraphService.state,
    nativeRendererGraphService.state,
  );
  return nativeRendererGraphService.deletionSnapshot(collection, entityId, force);
}

export function currentAuthoringDeletionGraphSnapshot(
  collection: string,
  entityId: string,
  force = false,
) {
  return nativeRendererGraphService.deletionSnapshot(collection, entityId, force);
}

export function useAuthoringDependencyGraphError() {
  useSyncExternalStore(
    nativeRendererGraphService.subscribe,
    nativeRendererGraphService.state,
    nativeRendererGraphService.state,
  );
  return nativeRendererGraphService.error();
}

/** Presentation-only graph, retained through requery without granting mutation authority. */
export function useDisplayedAuthoringDependencyGraphSnapshot() {
  useProjectStore((state) => state.projectInstanceId);
  useProjectStore((state) => state.projectSessionId);
  useSyncExternalStore(
    nativeRendererGraphService.subscribe,
    nativeRendererGraphService.state,
    nativeRendererGraphService.state,
  );
  return nativeRendererGraphService.displayedSnapshot();
}

export function useFocusedPreviewDependencyGraphSnapshot() {
  useCommandStore((state) => state.nativeWorkingRevision);
  useProjectStore((state) => state.projectRevision);
  useSyncExternalStore(
    nativeRendererGraphService.subscribe,
    nativeRendererGraphService.state,
    nativeRendererGraphService.state,
  );
  return nativeRendererGraphService.previewSnapshot();
}

export function currentAuthoringGraphSnapshot() {
  return nativeRendererGraphService.currentSnapshot();
}
