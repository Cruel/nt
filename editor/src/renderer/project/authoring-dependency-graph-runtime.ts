import { AuthoringDependencyGraphService } from './authoring-dependency-graph-service';
import { useProjectStore } from './project-store';
import { useSyncExternalStore } from 'react';
import { useCommandStore } from '../commands/command-store';
import { nativeRendererGraphService } from './native-authoring-graph-runtime';

export const authoringDependencyGraphService = new AuthoringDependencyGraphService({
  getProjectSessionId: () => useProjectStore.getState().projectSessionId,
  getScriptSourcePaths: () => useProjectStore.getState().scriptSourcePaths,
  readProjectTextSources: (request) => window.noveltea.readProjectTextSources(request),
});

let unsubscribe: (() => void) | null = null;

export function isAuthoringDependencyGraphServiceStarted(): boolean {
  return unsubscribe !== null;
}

export function startAuthoringDependencyGraphService(): () => void {
  if (unsubscribe) return unsubscribe;
  let lastPublication = useProjectStore.getState().lastMutationPublication;
  const unsubscribeProject = useProjectStore.subscribe((state) => {
    if (!state.lastMutationPublication || state.lastMutationPublication === lastPublication) return;
    lastPublication = state.lastMutationPublication;
    // Loading a native Project publishes its document before command mode is
    // enabled in the same event turn. Defer legacy dispatch until that choice
    // is known: native admissions must not execute TS graph construction.
    queueMicrotask(() => {
      if (useCommandStore.getState().nativeWorkingRevision === null)
        void authoringDependencyGraphService.publish(state.lastMutationPublication!);
      else nativeRendererGraphService.synchronize();
    });
  });
  const unsubscribeCommands = useCommandStore.subscribe(() =>
    nativeRendererGraphService.synchronize(),
  );
  if (lastPublication) {
    queueMicrotask(() => {
      if (useCommandStore.getState().nativeWorkingRevision === null)
        void authoringDependencyGraphService.publish(lastPublication!);
      else nativeRendererGraphService.synchronize();
    });
  }
  unsubscribe = () => {
    unsubscribeProject();
    unsubscribeCommands();
    unsubscribe = null;
  };
  return unsubscribe;
}

export function refreshAuthoringDependencyGraphProjectSources() {
  if (useCommandStore.getState().nativeWorkingRevision !== null)
    return nativeRendererGraphService.refresh();
  const publication = useProjectStore.getState().lastMutationPublication;
  return publication
    ? authoringDependencyGraphService.refreshProjectSources(publication)
    : Promise.resolve(null);
}

export function useCurrentAuthoringDependencyGraphSnapshot() {
  const nativeWorkingRevision = useCommandStore((state) => state.nativeWorkingRevision);
  const projectInstanceId = useProjectStore((state) => state.projectInstanceId);
  const projectRevision = useProjectStore((state) => state.projectRevision);
  useSyncExternalStore(
    (listener) => authoringDependencyGraphService.subscribe(listener),
    () => authoringDependencyGraphService.state(),
    () => authoringDependencyGraphService.state(),
  );
  useSyncExternalStore(
    nativeRendererGraphService.subscribe,
    nativeRendererGraphService.state,
    nativeRendererGraphService.state,
  );
  if (nativeWorkingRevision !== null) return nativeRendererGraphService.currentSnapshot();
  return projectInstanceId
    ? authoringDependencyGraphService.currentSnapshot(projectInstanceId, projectRevision)
    : null;
}

export function currentAuthoringGraphSnapshot() {
  if (useCommandStore.getState().nativeWorkingRevision !== null)
    return nativeRendererGraphService.currentSnapshot();
  const project = useProjectStore.getState();
  return project.projectInstanceId
    ? authoringDependencyGraphService.currentSnapshot(
        project.projectInstanceId,
        project.projectRevision,
      )
    : null;
}
