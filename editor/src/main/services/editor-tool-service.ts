import { validateProjectComfyUiWorkflows } from './comfyui-service';
import { publishCompiledArtifact } from '../../shared/compiled-artifact-publication';
import { createNodeProjectWorkspaceService } from '../../shared/project-workspace/node-project-workspace-service';
import {
  createProjectWorkspaceSnapshot,
  publishProjectWorkspaceSnapshot,
} from '../../shared/project-workspace/project-workspace-service';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import { validateProjectSettingsAuthoringState } from '../../shared/project-schema/authoring-project-settings';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import { parseTestData } from '../../shared/project-schema/authoring-tests';
import {
  classifyProjectValidationDiagnostics,
  collectProjectValidationDiagnostics,
  projectValidationBoundariesForCompilerDiagnostic,
} from '../../shared/project-schema/project-diagnostic-projection';
import { invokeNovelTeaNativeOperation } from '../../shared/noveltea-cli-subprocess';

import { buildRuntimePlaybackSpecFromAuthoringTest } from '../../shared/project-schema/test-playback-project';
import {
  logicalRuntimeArtifactPaths,
  prepareRuntimeArtifact,
} from '../../shared/legacy-runtime-artifact-preparation';
import { selectedExportProfile } from '../../shared/project-schema/authoring-export';
import { buildRuntimeTestCatalog } from '../../shared/runtime-test-catalog';

export async function openProject(projectPath: string) {
  const workspace = createNodeProjectWorkspaceService();
  const opened = await workspace.open(projectPath);
  if (!opened.ok)
    return {
      ok: true,
      success: false,
      diagnostics: opened.diagnostics,
      projectPath: opened.projectRoot,
      projectFilePath: opened.manifestPath,
    };
  const comfyUiDiagnostics = await validateProjectComfyUiWorkflows(opened.snapshot.manifestPath);
  const recoveryFiles = new Set(
    Object.values(opened.editorState.recovery.saveUnitsById).flatMap((entry) =>
      Object.keys(entry.baselineFileRevisions ?? {}),
    ),
  );
  return {
    ok: true,
    success: true,
    diagnostics: [
      ...opened.diagnostics,
      ...classifyProjectValidationDiagnostics(comfyUiDiagnostics, { producer: 'authoring' }),
    ],
    contentProject: opened.contentProject,
    savedContentProject: opened.savedContentProject,
    editorState: opened.editorState,
    repairs: opened.repairs,
    recoveryFileRevisions: Object.fromEntries(
      [...recoveryFiles]
        .sort()
        .map((file) => [file, opened.snapshot.fileRevisions[file]?.contentHash ?? 'absent']),
    ),
    scriptSourcePaths: { ...opened.snapshot.scriptSourcePaths },
    _workspaceSnapshot: opened.snapshot,
    projectPath: opened.snapshot.projectRoot,
    projectFilePath: opened.snapshot.manifestPath,
  };
}

export async function validateProject(project: unknown) {
  const authoringDiagnostics = isAuthoringProject(project)
    ? collectProjectValidationDiagnostics(
        validateAuthoringProject(project),
        validateProjectSettingsAuthoringState(project),
      )
    : [];
  const compiled = isAuthoringProject(project)
    ? publishProjectWorkspaceSnapshot(await createProjectWorkspaceSnapshot(project))
    : publishCompiledArtifact(project);
  const compilerDiagnostics = classifyProjectValidationDiagnostics(
    compiled.diagnostics.map((item) => ({
      code: item.code,
      severity: item.severity,
      category: item.code,
      path: item.jsonPointer,
      message: item.message,
      boundaries: projectValidationBoundariesForCompilerDiagnostic(item.code, item.jsonPointer),
    })),
    { producer: 'compiler' },
  );
  const diagnostics = collectProjectValidationDiagnostics(
    authoringDiagnostics,
    compilerDiagnostics,
  );
  return Promise.resolve({
    ok: true,
    success: !diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
    diagnostics,
  });
}

export function listPlaybackTests(project: unknown) {
  if (!isAuthoringProject(project)) {
    return Promise.resolve({
      ok: true,
      tests: [],
      diagnostics: [
        {
          severity: 'error',
          category: 'Project schema',
          path: '/schema',
          message: 'Project must use the current noveltea.authoring.project schema.',
        },
      ],
    });
  }
  const diagnostics: Array<{ severity: 'error'; category: string; path: string; message: string }> =
    [];
  const tests = Object.entries(project.tests).flatMap(([id, record]) => {
    const data = parseTestData(record.data);
    if (!data) {
      diagnostics.push({
        severity: 'error',
        category: 'Tests',
        path: `/tests/${id}/data`,
        message: `Test '${id}' is invalid.`,
      });
      return [];
    }
    return [{ id, steps: data.steps.length }];
  });
  return Promise.resolve({ ok: true, tests, diagnostics });
}

export async function runPlaybackTest(project: unknown, testId: string) {
  if (isAuthoringProject(project)) {
    const built = await buildRuntimePlaybackSpecFromAuthoringTest(project, testId);
    if (!built.ok || !built.project || !built.spec)
      return { ok: false, success: false, diagnostics: built.diagnostics };
    return built.runner === 'runtime-ui'
      ? invokeNovelTeaNativeOperation('run-ui-test', {
          project: built.project,
          spec: built.spec,
          projectRoot: null,
          shaderMaterialMetadata: built.shaderMaterialMetadata ?? null,
          shaderVariants: built.shaderVariants ?? [],
        })
      : invokeNovelTeaNativeOperation('run-test', {
          project: built.project,
          spec: built.spec,
          shaderVariants: built.shaderVariants ?? [],
        });
  }
  return {
    ok: false,
    success: false,
    error: 'Playback requires an authoring project.',
  };
}

export async function runPlaybackSuite(project: unknown) {
  if (!isAuthoringProject(project))
    return {
      ok: false,
      success: false,
      diagnostics: [],
      error: 'Playback requires an authoring project.',
    };

  const prepared = await prepareRuntimeArtifact({
    project,
    projectRoot: null,
    profile: selectedExportProfile(project),
    intent: 'test-playback',
    paths: logicalRuntimeArtifactPaths,
  });
  if (prepared.status !== 'prepared')
    return { ok: false, success: false, diagnostics: prepared.diagnostics };

  return invokeNovelTeaNativeOperation('run-test-suite', {
    project: prepared.artifact.compiledProject,
    catalog: buildRuntimeTestCatalog(project),
    projectRoot: null,
    shaderMaterialMetadata: prepared.artifact.shaderMaterialMetadata ?? null,
    shaderVariants: prepared.artifact.packageOptions.shaderVariants,
  });
}
