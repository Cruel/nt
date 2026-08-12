import type { ShaderCompileOutput } from '../../shared/editor-tooling';
import type { ExportProfileData } from '../../shared/project-schema/authoring-export';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  prepareRuntimeArtifact,
  type PrepareRuntimeArtifactResult,
  type RuntimeArtifactAssessment,
} from '../../shared/runtime-artifact-preparation';
import { rendererRuntimeArtifactPaths } from '../export/runtime-artifact-adapters';

export interface RuntimeArtifactTestOptions {
  projectRoot?: string | null;
  profile: ExportProfileData;
  recoveryFingerprint?: unknown;
  shaderOutputs?: readonly ShaderCompileOutput[];
}

export async function prepareRuntimeArtifactForTest(
  project: AuthoringProject,
  options: RuntimeArtifactTestOptions,
): Promise<PrepareRuntimeArtifactResult> {
  const shaderOutputs = [...(options.shaderOutputs ?? [])];
  return prepareRuntimeArtifact({
    project,
    projectRoot: options.projectRoot ?? null,
    profile: options.profile,
    recoveryFingerprint: options.recoveryFingerprint,
    intent: options.shaderOutputs ? 'runtime-package-export' : 'runtime-package-preflight',
    paths: rendererRuntimeArtifactPaths,
    ...(options.shaderOutputs
      ? {
          shaderCompiler: {
            async compile() {
              return { ok: true, success: true, diagnostics: [], outputs: shaderOutputs };
            },
          },
        }
      : {}),
  });
}

export async function prepareRuntimeAssessmentForTest(
  project: AuthoringProject,
  options: RuntimeArtifactTestOptions,
): Promise<RuntimeArtifactAssessment> {
  const result = await prepareRuntimeArtifactForTest(project, options);
  if (result.status === 'cancelled') throw new Error('Preparation unexpectedly cancelled.');
  return result.assessment;
}
