import type { AuthoringProject } from './authoring-project';

declare const structurallyAdmittedProjectBrand: unique symbol;

/**
 * An authoring project that passed tolerant structural admission. Semantic diagnostics may still be
 * present. The value is deeply immutable while it is owned by the authoritative project store.
 */
export type StructurallyAdmittedAuthoringProject = AuthoringProject & {
  readonly [structurallyAdmittedProjectBrand]: true;
};

export function asStructurallyAdmittedAuthoringProject(
  project: AuthoringProject,
): StructurallyAdmittedAuthoringProject {
  return project as StructurallyAdmittedAuthoringProject;
}
