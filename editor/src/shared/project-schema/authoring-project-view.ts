import type { AuthoringProject } from './authoring-project';

/** Presentation and edit-intent view of a native-admitted Project, not schema admission. */
export function isAuthoringProjectView(value: unknown): value is AuthoringProject {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'project' in value &&
    'settings' in value &&
    'assets' in value
  );
}
