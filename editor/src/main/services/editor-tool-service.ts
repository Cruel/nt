import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { validateProjectComfyUiWorkflows } from './comfyui-service';
import type { PackageExportOptions, ShaderCompileOptions } from '../../shared/editor-tooling';

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

  return path.resolve(process.cwd(), '..', 'build', 'linux-debug', 'tools', 'editor_tool', toolName());
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

async function openAuthoringProjectFromSource(source: string, projectFilePath: string): Promise<Record<string, unknown> | null> {
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
      importedLegacy: false,
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
  const response = (await invokeEditorTool('load-project', { source })) as Record<string, unknown>;
  const workflowDiagnostics = await validateProjectComfyUiWorkflows(projectFilePath);
  return {
    ...response,
    diagnostics: [...(Array.isArray(response.diagnostics) ? response.diagnostics : []), ...workflowDiagnostics],
    projectPath: path.dirname(projectFilePath),
    projectFilePath,
  };
}

export function importLegacyGame(source: string) {
  return invokeEditorTool('import-legacy-game', { source });
}

export function validateProject(project: unknown) {
  return invokeEditorTool('validate', { project });
}

export function listPlaybackTests(project: unknown) {
  return invokeEditorTool('list-tests', { project });
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

export function exportPackage(project: unknown, outputPath: string, options?: PackageExportOptions) {
  return invokeEditorTool('export-package', { project, outputPath, options: options ?? {} });
}

export function compileShaders(shaderProject: unknown, options?: ShaderCompileOptions) {
  return invokeEditorTool('compile-shaders', { shaderProject, options: options ?? {} });
}

export function setEntityRecord(
  project: unknown,
  collection: string,
  entityId: string,
  record: unknown,
) {
  return invokeEditorTool('set-entity', { project, collection, entityId, record });
}

export function eraseEntityRecord(project: unknown, collection: string, entityId: string) {
  return invokeEditorTool('erase-entity', { project, collection, entityId });
}
