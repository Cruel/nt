/** Legacy Project admission and linker, retained only until #521 switches production. */
import {
  missingAuthoringStructuralReferences,
  serializeAuthoringDependencyNodeKey,
} from './authoring-dependency-graph';
import { authoringProjectSchema, type AuthoringProject } from './project-schema/authoring-project';
import { projectSettingsFromProject } from './project-schema/authoring-project-settings';
import { validateAdmittedAuthoringProject } from './project-schema/authoring-validation';
import type { ProjectValidationDiagnostic } from './project-schema/project-diagnostic-projection';
import {
  compileAuthoringProject as compileWithLegacyHooks,
  compileAuthoringProjectValue as compileValueWithLegacyHooks,
  preflightAdmittedAuthoringProject as preflightWithLegacyValidator,
  type LegacyAuthoringCompilerHooks,
} from './authoring-compiler-lowering';

export * from './authoring-compiler-lowering';
export * from './legacy-authoring-symbol-tables';

const legacyHooks: LegacyAuthoringCompilerHooks = {
  normalize(value) {
    const parsed = authoringProjectSchema.safeParse(value);
    if (!parsed.success) return { issues: parsed.error.issues };
    return { project: { ...parsed.data, settings: projectSettingsFromProject(parsed.data) } };
  },
  validate: (project) => validateAdmittedAuthoringProject(project).diagnostics,
  missingReferences(project) {
    return missingAuthoringStructuralReferences(project).map((edge) => ({
      sourcePath: edge.sourcePath,
      targetLabel:
        edge.target.kind === 'record'
          ? `${edge.target.collection}/${edge.target.id}`
          : serializeAuthoringDependencyNodeKey(edge.target),
    }));
  },
};

export function preflightAdmittedAuthoringProject(
  project: AuthoringProject,
  validate: (
    project: AuthoringProject,
  ) => readonly ProjectValidationDiagnostic[] = legacyHooks.validate,
) {
  return preflightWithLegacyValidator(project, validate);
}

export function compileAuthoringProject(
  project: unknown,
  validate: (
    project: AuthoringProject,
  ) => readonly ProjectValidationDiagnostic[] = legacyHooks.validate,
) {
  return compileWithLegacyHooks(project, validate, legacyHooks);
}

export function compileAuthoringProjectValue(
  project: unknown,
  validate: (
    project: AuthoringProject,
  ) => readonly ProjectValidationDiagnostic[] = legacyHooks.validate,
  admitted = false,
) {
  return compileValueWithLegacyHooks(project, validate, admitted, legacyHooks);
}
