import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { useProjectStore } from './project-store';

/** Display/command-intent view only; native admission belongs to the session reply. */
export function projectForEditor(
  value: unknown,
  _nativeSession = useProjectStore.getState().nativeSession,
): AuthoringProject | null {
  if (!value) return null;
  return value as AuthoringProject;
}
