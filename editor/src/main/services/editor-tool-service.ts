import { validateProjectComfyUiWorkflows } from './comfyui-service';
import type {
  PackageExportOptions,
  ShaderCompileOptions,
  ToolDiagnostic,
} from '../../shared/editor-tooling';
import { publishCompiledArtifact } from '../../shared/compiled-artifact-publication';
import { parseShaderCompileResponse } from '../../shared/shader-compile-contract';
import { createNodeProjectWorkspaceService } from '../../shared/project-workspace/node-project-workspace-service';
import {
  createProjectWorkspaceSnapshot,
  publishProjectWorkspaceSnapshot,
} from '../../shared/project-workspace/project-workspace-service';
import { AUTHORING_PROJECT_SCHEMA_VERSION } from '../../shared/project-schema/authoring-collections';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import { parseTestData } from '../../shared/project-schema/authoring-tests';
import {
  classifyProjectValidationDiagnostics,
  projectValidationBoundariesForCompilerDiagnostic,
} from '../../shared/project-schema/project-validation';
export {
  invokeNovelTeaNativeOperation,
  resolveNovelTeaCliPath,
} from '../../shared/noveltea-cli-subprocess';
import { invokeNovelTeaNativeOperation } from '../../shared/noveltea-cli-subprocess';
import { buildRuntimePlaybackSpecFromAuthoringTest } from '../../shared/project-schema/test-playback-project';

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
    recoveryBaselineWorkspaceRevision: opened.recoveryBaselineWorkspaceRevision,
    repairs: opened.repairs,
    workspaceRevision: opened.snapshot.workspaceRevision,
    fileRevisions: Object.fromEntries(
      Object.entries(opened.snapshot.fileRevisions).map(([file, revision]) => [
        file,
        revision.contentHash,
      ]),
    ),
    scriptSourcePaths: { ...opened.snapshot.scriptSourcePaths },
    projectPath: opened.snapshot.projectRoot,
    projectFilePath: opened.snapshot.manifestPath,
  };
}

export function validateProject(project: unknown) {
  const compiled = isAuthoringProject(project)
    ? publishProjectWorkspaceSnapshot(createProjectWorkspaceSnapshot(project))
    : publishCompiledArtifact(project);
  const diagnostics = classifyProjectValidationDiagnostics(
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
  return Promise.resolve({ ok: true, success: compiled.ok, diagnostics });
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
          message: `Project must use noveltea.authoring.project version ${AUTHORING_PROJECT_SCHEMA_VERSION}.`,
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
    return invokeNovelTeaNativeOperation('run-test', { project: built.project, spec: built.spec });
  }
  return {
    ok: false,
    success: false,
    error: 'Playback requires an authoring project.',
  };
}

export function runPlaybackSpec(project: unknown, spec: unknown) {
  return invokeNovelTeaNativeOperation('run-test', { project, spec });
}

export function runUiPlaybackSpec(project: unknown, spec: unknown) {
  return invokeNovelTeaNativeOperation('run-ui-test', { project, spec });
}

export function exportPackage(
  project: unknown,
  outputPath: string,
  options?: PackageExportOptions,
) {
  return invokeNovelTeaNativeOperation('export-package', {
    project,
    outputPath,
    options: options ?? {},
  }).then((value) => normalizePackageToolResponse(value));
}

export function compileShaders(shaderProject: unknown, options?: ShaderCompileOptions) {
  return invokeNovelTeaNativeOperation('compile-shaders', {
    shaderProject,
    options: options ?? {},
  }).then((value) => normalizeShaderToolResponse(value));
}

function normalizePackageToolResponse(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.diagnostics)) return value;
  const diagnostics = classifyProjectValidationDiagnostics(record.diagnostics as ToolDiagnostic[], {
    producer: 'package-publication',
  });
  return { ...record, diagnostics };
}

function normalizeShaderToolResponse(value: unknown): unknown {
  const response = parseShaderCompileResponse(value);
  const classified = classifyProjectValidationDiagnostics(
    response.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      path: diagnostic.path ?? diagnostic.outputPath ?? diagnostic.sourcePath ?? '/shaders',
      message: diagnostic.message,
      category: 'shader',
    })),
    { producer: 'shader-compile' },
  );
  return {
    ...response,
    diagnostics: response.diagnostics.map((diagnostic, index) => ({
      ...diagnostic,
      ...classified[index],
    })),
  };
}
