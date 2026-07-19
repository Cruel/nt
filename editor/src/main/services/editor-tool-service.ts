import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { validateProjectComfyUiWorkflows } from './comfyui-service';
import type {
  PackageExportOptions,
  ShaderCompileDiagnostic,
  ShaderCompileOptions,
  ToolDiagnostic,
} from '../../shared/editor-tooling';
import { publishCompiledArtifact } from '../../shared/compiled-artifact-publication';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import { parseTestData } from '../../shared/project-schema/authoring-tests';
import {
  classifyProjectValidationDiagnostics,
  createProjectValidationDiagnostic,
  projectValidationBoundariesForCompilerDiagnostic,
} from '../../shared/project-schema/project-validation';

const MAX_TOOL_INPUT_BYTES = 32 * 1024 * 1024;

function toolName() {
  return process.platform === 'win32' ? 'noveltea-editor-tool.exe' : 'noveltea-editor-tool';
}

function repoRootCandidates() {
  const cwd = process.cwd();
  return [
    path.resolve(cwd, '..'),
    path.resolve(cwd),
    path.resolve(app.getAppPath(), '..'),
    path.resolve(app.getAppPath(), '..', '..'),
  ];
}

export function resolveEditorToolPath(): string {
  if (process.env.NOVELTEA_EDITOR_TOOL) {
    return process.env.NOVELTEA_EDITOR_TOOL;
  }

  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', toolName());
  }

  const relativeCandidates = [
    path.join('build', 'linux-debug', 'tools', 'editor_tool', toolName()),
    path.join('build', 'linux-release', 'tools', 'editor_tool', toolName()),
    path.join('build', 'web-debug', 'tools', 'editor_tool', toolName()),
  ];
  for (const root of repoRootCandidates()) {
    for (const relative of relativeCandidates) {
      const candidate = path.resolve(root, relative);
      if (existsSync(candidate)) return candidate;
    }
  }

  return path.resolve(
    process.cwd(),
    '..',
    'build',
    'linux-debug',
    'tools',
    'editor_tool',
    toolName(),
  );
}

export function invokeEditorTool(command: string, payload: unknown): Promise<unknown> {
  const input = JSON.stringify(payload ?? {});
  if (Buffer.byteLength(input, 'utf8') > MAX_TOOL_INPUT_BYTES) {
    return Promise.reject(new Error('Editor tool payload is too large.'));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(resolveEditorToolPath(), [command], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Editor tool timed out.'));
    }, 30_000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > 16 * 1024 * 1024) {
        child.kill();
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let parsed: unknown = null;
      try {
        parsed = stdout ? JSON.parse(stdout) : null;
      } catch (parseError) {
        reject(
          new Error(
            `Editor tool returned invalid JSON.${stderr ? ` stderr: ${stderr}` : ''} ${String(parseError)}`,
          ),
        );
        return;
      }

      if (code !== 0 && !parsed) {
        reject(new Error(stderr || `Editor tool failed with exit code ${code ?? 'unknown'}.`));
        return;
      }
      resolve(parsed);
    });
    child.stdin.end(input);
  });
}

function findProjectFile(projectPath: string) {
  const absolute = path.resolve(projectPath);
  if (existsSync(absolute) && !absolute.endsWith(path.sep)) {
    try {
      const stat = statSync(absolute);
      if (stat.isFile()) return absolute;
    } catch {
      // Fall through to directory candidates.
    }
  }

  const candidates = ['game.json', 'project.json', 'game'];
  for (const candidate of candidates) {
    const filePath = path.join(absolute, candidate);
    if (existsSync(filePath)) return filePath;
  }
  return path.join(absolute, 'game.json');
}

async function openAuthoringProjectFromSource(
  source: string,
  projectFilePath: string,
): Promise<Record<string, unknown> | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return null;
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>).schema === 'noveltea.authoring.project'
  ) {
    const diagnostics = await validateProjectComfyUiWorkflows(projectFilePath);
    return {
      ok: true,
      success: true,
      diagnostics,
      project: parsed,
      projectPath: path.dirname(projectFilePath),
      projectFilePath,
    };
  }
  return null;
}

export async function openProject(projectPath: string) {
  const projectFilePath = findProjectFile(projectPath);
  const source = readFileSync(projectFilePath, 'utf8');
  const authoringProject = await openAuthoringProjectFromSource(source, projectFilePath);
  if (authoringProject) return authoringProject;
  return {
    ok: true,
    success: false,
    diagnostics: [
      createProjectValidationDiagnostic({
        code: 'authoring.schema.unsupported',
        severity: 'error',
        category: 'authoring.unsupported_schema',
        path: '/schema',
        message: 'Project must use noveltea.authoring.project version 2.',
        boundaries: ['authoring', 'runtime-package'],
        ownerPaths: ['/schema'],
      }),
    ],
    projectPath: path.dirname(projectFilePath),
    projectFilePath,
  };
}

export function validateProject(project: unknown) {
  const compiled = publishCompiledArtifact(project);
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
          message: 'Project must use noveltea.authoring.project version 2.',
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

export function runPlaybackTest(project: unknown, testId: string) {
  return invokeEditorTool('run-test', { project, testId });
}

export function runPlaybackSpec(project: unknown, spec: unknown) {
  return invokeEditorTool('run-test', { project, spec });
}

export function runUiPlaybackSpec(project: unknown, spec: unknown) {
  return invokeEditorTool('run-ui-test', { project, spec });
}

export function exportPackage(
  project: unknown,
  outputPath: string,
  options?: PackageExportOptions,
) {
  return invokeEditorTool('export-package', {
    project,
    outputPath,
    options: options ?? {},
  }).then((value) => normalizePackageToolResponse(value));
}

export function compileShaders(shaderProject: unknown, options?: ShaderCompileOptions) {
  return invokeEditorTool('compile-shaders', {
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.diagnostics)) return value;
  const rawDiagnostics = record.diagnostics as ShaderCompileDiagnostic[];
  const classified = classifyProjectValidationDiagnostics(
    rawDiagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      path: diagnostic.path ?? diagnostic.outputPath ?? diagnostic.sourcePath ?? '/shaders',
      message: diagnostic.message,
      category: 'shader',
    })),
    { producer: 'shader-compile' },
  );
  return {
    ...record,
    diagnostics: rawDiagnostics.map((diagnostic, index) => ({
      ...diagnostic,
      ...classified[index],
    })),
  };
}
