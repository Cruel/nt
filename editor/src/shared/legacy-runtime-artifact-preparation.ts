/** Pre-#521 production bridge. Native candidates must import the downstream
 * runtime-artifact-preparation module directly, never this old Project analyzer. */
import { unchangedValidationContributionInputs } from './project-schema/authoring-validation-input-equivalence';
import {
  validateAdmittedAuthoringProject,
  validateAuthoringProject,
} from './project-schema/authoring-validation';
import type {
  AuthoringValidationContribution,
  AuthoringValidationReuse,
} from './project-schema/authoring-validation-contributions';
import { compileAuthoringProjectValue } from './authoring-compiler';
import { legacyRuntimeSourceGraphAssessment } from './legacy-runtime-source-graph';
import {
  prepareRuntimeArtifact as prepareDownstream,
  verifyPreparedRuntimeArtifact as verifyDownstream,
  type PrepareRuntimeArtifactOptions,
  type VerifyPreparedRuntimeArtifactOptions,
} from './runtime-artifact-preparation';
import type { AuthoringProject } from './project-schema/authoring-project';

export * from './runtime-artifact-preparation';

function compileLegacyProject(
  project: AuthoringProject,
  runtimeProject: AuthoringProject,
  contributions?: readonly AuthoringValidationContribution[],
) {
  const semanticValidation = contributions
    ? (normalized: AuthoringProject) => {
        const unchangedInputs = unchangedValidationContributionInputs(
          project,
          normalized,
          contributions,
        );
        const reuse: AuthoringValidationReuse = {
          contributions,
          resolveInputs(paths) {
            return unchangedInputs.get(JSON.stringify(paths)) ?? null;
          },
        };
        return validateAdmittedAuthoringProject(normalized, reuse).diagnostics;
      }
    : undefined;
  return compileAuthoringProjectValue(runtimeProject, semanticValidation);
}

export function prepareRuntimeArtifact(options: PrepareRuntimeArtifactOptions) {
  return prepareDownstream({
    ...options,
    legacyValidate: validateAuthoringProject,
    legacyCompile: compileLegacyProject,
    legacySourceGraph: legacyRuntimeSourceGraphAssessment,
  });
}

export function verifyPreparedRuntimeArtifact(
  artifact: unknown,
  options: VerifyPreparedRuntimeArtifactOptions,
) {
  return verifyDownstream(artifact, {
    ...options,
    legacyCompile: (project) => compileAuthoringProjectValue(project),
    legacySourceGraph: legacyRuntimeSourceGraphAssessment,
  });
}
