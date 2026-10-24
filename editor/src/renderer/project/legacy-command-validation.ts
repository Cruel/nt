import { useProjectStore } from './project-store';

/** Native commands submit edit intent; only the native reply may admit its semantics. */
export function legacyCommandDiagnostics<T>(validate: () => T[]): T[] {
  return useProjectStore.getState().nativeSession ? [] : validate();
}
