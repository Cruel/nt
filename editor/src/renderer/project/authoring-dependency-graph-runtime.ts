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

export function currentAuthoringGraphSnapshot() {
  return nativeRendererGraphService.currentSnapshot();
}
