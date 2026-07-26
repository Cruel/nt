import { AuthoringDependencyGraphService } from './authoring-dependency-graph-service';
import { useProjectStore } from './project-store';
import { useSyncExternalStore } from 'react';

export const authoringDependencyGraphService = new AuthoringDependencyGraphService({
  getProjectReadSessionId: () => useProjectStore.getState().projectReadSessionId,
  readProjectTextSources: (request) => window.noveltea.readProjectTextSources(request),
});

let unsubscribe: (() => void) | null = null;

export function isAuthoringDependencyGraphServiceStarted(): boolean {
  return unsubscribe !== null;
}

export function startAuthoringDependencyGraphService(): () => void {
  if (unsubscribe) return unsubscribe;
  let lastPublication = useProjectStore.getState().lastMutationPublication;
  unsubscribe = useProjectStore.subscribe((state) => {
    if (!state.lastMutationPublication || state.lastMutationPublication === lastPublication) return;
    lastPublication = state.lastMutationPublication;
    void authoringDependencyGraphService.publish(state.lastMutationPublication);
  });
  if (lastPublication) void authoringDependencyGraphService.publish(lastPublication);
  return () => {
    unsubscribe?.();
    unsubscribe = null;
  };
}

export function useCurrentAuthoringDependencyGraphSnapshot() {
  const projectInstanceId = useProjectStore((state) => state.projectInstanceId);
  const projectRevision = useProjectStore((state) => state.projectRevision);
  useSyncExternalStore(
    (listener) => authoringDependencyGraphService.subscribe(listener),
    () => authoringDependencyGraphService.state(),
    () => authoringDependencyGraphService.state(),
  );
  return projectInstanceId
    ? authoringDependencyGraphService.currentSnapshot(projectInstanceId, projectRevision)
    : null;
}
