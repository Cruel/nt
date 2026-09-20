import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateProjectComfyUiWorkflows } from './comfyui-service';
import type {
  PackageExportOptions,
  ShaderCompileOptions,
  ShaderCompileResponse,
  ToolDiagnostic,
} from '../../shared/editor-tooling';
import { publishCompiledArtifact } from '../../shared/compiled-artifact-publication';
import { parseShaderCompileResponse } from '../../shared/shader-compile-contract';
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
} from '../../shared/project-schema/project-validation';
export {
  invokeNovelTeaNativeOperation,
  resolveNovelTeaCliPath,
} from '../../shared/noveltea-cli-subprocess';
import { invokeNovelTeaNativeOperation } from '../../shared/noveltea-cli-subprocess';
import { buildRuntimePlaybackSpecFromAuthoringTest } from '../../shared/project-schema/test-playback-project';
import {
  logicalRuntimeArtifactPaths,
  prepareRuntimeArtifact,
} from '../../shared/runtime-artifact-preparation';
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
        })
      : invokeNovelTeaNativeOperation('run-test', {
          project: built.project,
          spec: built.spec,
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
  });
}

export function runPlaybackSpec(project: unknown, spec: unknown) {
  return invokeNovelTeaNativeOperation('run-test', { project, spec });
}

export function runUiPlaybackSpec(
  project: unknown,
  spec: unknown,
  projectRoot: string | null = null,
  shaderMaterialMetadata: unknown = null,
) {
  return invokeNovelTeaNativeOperation('run-ui-test', {
    project,
    spec,
    projectRoot,
    shaderMaterialMetadata,
  });
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

function safeShaderOverlayPath(relativePath: string): boolean {
  if (!relativePath.startsWith('shaders/') || path.isAbsolute(relativePath)) return false;
  const normalized = path.posix.normalize(relativePath.replaceAll('\\', '/'));
  return normalized === relativePath && !normalized.split('/').includes('..');
}

async function withShaderSourceOverlayRoot<T>(
  projectRoot: string,
  overlays: Readonly<Record<string, string>>,
  run: (projectRoot: string) => Promise<T>,
): Promise<T> {
  const overlayRoot = await mkdtemp(path.join(tmpdir(), 'noveltea-shader-overlay-'));
  try {
    const sourceShaderRoot = path.join(projectRoot, 'shaders');
    const overlayShaderRoot = path.join(overlayRoot, 'shaders');
    await cp(sourceShaderRoot, overlayShaderRoot, { recursive: true, force: false }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      },
    );
    for (const [relativePath, text] of Object.entries(overlays)) {
      if (!safeShaderOverlayPath(relativePath))
        throw new Error(`Invalid shader source overlay path: ${relativePath}`);
      const destination = path.join(overlayRoot, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, text, 'utf8');
    }
    return await run(overlayRoot);
  } finally {
    await rm(overlayRoot, { recursive: true, force: true });
  }
}

export async function compileShaders(shaderProject: unknown, options?: ShaderCompileOptions) {
  const effectiveOptions = options ?? {};
  const { sourceOverlays, ...nativeOptions } = effectiveOptions;
  const invoke = (projectRoot = nativeOptions.projectRoot) =>
    invokeNovelTeaNativeOperation('compile-shaders', {
      shaderProject,
      options: { ...nativeOptions, projectRoot },
    }).then((value) => normalizeShaderToolResponse(value));
  if (!sourceOverlays || Object.keys(sourceOverlays).length === 0 || !nativeOptions.projectRoot)
    return invoke();
  return withShaderSourceOverlayRoot(
    nativeOptions.projectRoot,
    sourceOverlays,
    async (overlayRoot) => {
      const response = await invoke(overlayRoot);
      const remapPath = (value: string | undefined) => {
        if (!value) return value;
        const relative = path.relative(overlayRoot, value);
        return !relative.startsWith('..') && !path.isAbsolute(relative)
          ? path.join(nativeOptions.projectRoot!, relative)
          : value;
      };
      return {
        ...response,
        diagnostics: response.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          sourcePath: remapPath(diagnostic.sourcePath),
          path: remapPath(diagnostic.path),
        })),
      };
    },
  );
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

function normalizeShaderToolResponse(value: unknown): ShaderCompileResponse {
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
