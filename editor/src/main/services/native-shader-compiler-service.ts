import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ShaderCompileOptions, ShaderCompileResponse } from '../../shared/editor-tooling';
import { parseShaderCompileResponse } from '../../shared/shader-compile-contract';
import { classifyProjectValidationDiagnostics } from '../../shared/project-schema/project-diagnostic-projection';
import { invokeNovelTeaNativeOperation } from '../../shared/noveltea-cli-subprocess';

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
