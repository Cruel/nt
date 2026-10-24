import type { ToolDiagnostic } from '../editor-tooling';
import { isAuthoringProject, type AuthoringProject } from './authoring-project';
import { selectedExportProfile } from './authoring-export';
import {
  logicalRuntimeArtifactPaths,
  prepareRuntimeArtifact,
} from '../legacy-runtime-artifact-preparation';
import { parseTestData } from './authoring-tests';

import {
  diagnostic,
  buildRuntimePlaybackSpecFromTestData,
  type TestRunReadiness,
  type RuntimePlaybackSpecBuildResult,
} from './test-playback-projection';
export * from './test-playback-projection';

async function compiledProjectForAuthoring(project: AuthoringProject): Promise<{
  project?: unknown;
  shaderMaterialMetadata?: unknown;
  shaderVariants: string[];
  diagnostics: ToolDiagnostic[];
  ok: boolean;
}> {
  const profile = selectedExportProfile(project);
  const prepared = await prepareRuntimeArtifact({
    project,
    projectRoot: null,
    profile,
    intent: 'test-playback',
    paths: logicalRuntimeArtifactPaths,
  });
  if (prepared.status === 'cancelled')
    return { shaderVariants: profile.shaderVariants, diagnostics: prepared.diagnostics, ok: false };
  return {
    project: prepared.assessment.compiledProject,
    shaderMaterialMetadata: prepared.assessment.shaderMaterialMetadata,
    shaderVariants: profile.shaderVariants,
    diagnostics: prepared.assessment.diagnostics,
    ok: prepared.status === 'prepared',
  };
}

export async function buildRuntimePlaybackSpecFromAuthoringTest(
  project: AuthoringProject,
  testId: string,
): Promise<RuntimePlaybackSpecBuildResult> {
  const record = project.tests[testId];
  if (!record) {
    return {
      ok: false,
      diagnostics: [diagnostic('error', `/tests/${testId}`, 'Test record does not exist.')],
    };
  }
  const data = parseTestData(record.data);
  if (!data) {
    return {
      ok: false,
      diagnostics: [diagnostic('error', `/tests/${testId}/data`, 'Test data is invalid.')],
    };
  }
  const built = buildRuntimePlaybackSpecFromTestData(testId, data);
  const compiledProject = await compiledProjectForAuthoring(project);
  return {
    ...built,
    ok: built.ok && compiledProject.ok,
    project: compiledProject.project,
    shaderMaterialMetadata: compiledProject.shaderMaterialMetadata,
    shaderVariants: compiledProject.shaderVariants,
    diagnostics: [...built.diagnostics, ...compiledProject.diagnostics],
  };
}

export async function getAuthoringTestRunReadiness(
  project: unknown,
  testId: string,
): Promise<TestRunReadiness> {
  if (!isAuthoringProject(project)) {
    return {
      runnable: false,
      reason: 'not-runnable-invalid-test',
      diagnostics: [
        diagnostic('error', '/project', 'The authoring project is invalid and cannot run tests.'),
      ],
    };
  }
  const record = project.tests[testId];
  if (!record) {
    return {
      runnable: false,
      reason: 'not-runnable-invalid-test',
      diagnostics: [diagnostic('error', `/tests/${testId}`, 'Test record does not exist.')],
    };
  }
  const data = parseTestData(record.data);
  if (!data) {
    return {
      runnable: false,
      reason: 'not-runnable-invalid-test',
      diagnostics: [diagnostic('error', `/tests/${testId}/data`, 'Test data is invalid.')],
    };
  }
  const playback = buildRuntimePlaybackSpecFromTestData(testId, data);
  if (!playback.ok) {
    return {
      runnable: false,
      reason: 'not-runnable-missing-runtime-support',
      diagnostics: playback.diagnostics,
    };
  }
  const compiledProject = await compiledProjectForAuthoring(project);
  if (!compiledProject.ok) {
    return {
      runnable: false,
      reason: 'not-runnable-project-compilation-failed',
      diagnostics: compiledProject.diagnostics,
    };
  }
  return {
    runnable: true,
    reason: 'runnable',
    diagnostics: compiledProject.diagnostics.filter((item) => item.severity !== 'error'),
  };
}
