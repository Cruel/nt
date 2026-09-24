import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { NovelTeaCliPlatformToolService } from './platform-tool-service';
import type { NovelTeaCliNativeToolService } from './native-tool-service';
import type { RuntimeArtifactPathAdapter } from '../shared/runtime-artifact-preparation';
import type { PreparedRuntimePackageOptions } from '../shared/project-schema/prepared-runtime-artifact';
import type { ShaderCompileOptions } from '../shared/editor-tooling';
import type { PinnedProjectTextSources } from './pinned-project-text-sources';
import {
  packageOptionsWithPinnedProjectTextSources,
  pinnedShaderSourceOverlays,
} from './pinned-project-text-sources';

export interface NovelTeaCliPlatformToolServiceOptions {
  readonly runtimeArtifactPaths?: RuntimeArtifactPathAdapter;
  readonly pinnedProjectTextSources?: PinnedProjectTextSources;
}

function internalToken(token: string): string {
  const match = /^([a-zA-Z0-9._-]+)@([a-zA-Z0-9._-]+)$/.exec(token);
  if (!match) throw new Error(`Invalid template identity '${token}'; expected <id>@<build>.`);
  return `${match[1]}/${match[2]}`;
}

async function pathKind(value: string): Promise<'missing' | 'symlink' | 'other'> {
  try {
    return (await lstat(value)).isSymbolicLink() ? 'symlink' : 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

export function createNovelTeaCliPlatformToolService(
  nativeTools?: NovelTeaCliNativeToolService,
  options: NovelTeaCliPlatformToolServiceOptions = {},
): NovelTeaCliPlatformToolService {
  return {
    async listTemplates() {
      const { listPlayerTemplates } = await import('../main/services/template-registry-service');
      return listPlayerTemplates();
    },
    async inspectTemplate(token) {
      const { inspectPlayerTemplate } = await import('../main/services/template-registry-service');
      const [templateId, buildId] = internalToken(token).split('/');
      return inspectPlayerTemplate(templateId!, buildId!);
    },
    async installTemplate(archivePath, force) {
      const { installPlayerTemplate } = await import('../main/services/template-registry-service');
      return installPlayerTemplate({
        archivePath: path.resolve(archivePath),
        force,
        origin: 'noveltea-cli',
      });
    },
    async removeTemplate(token) {
      const { removePlayerTemplate } = await import('../main/services/template-registry-service');
      const [templateId, buildId] = internalToken(token).split('/');
      return removePlayerTemplate(templateId!, buildId!);
    },
    async exportProject(request, onProgress, abortSignal, beforePublish) {
      const [{ exportProjectToPlatform }, { cancelPlatformExport }] = await Promise.all([
        import('../main/services/platform-export-orchestration-service'),
        import('../main/services/platform-staging-service'),
      ]);
      const operationId = request.operationId ?? `cli-${process.pid}-${Date.now()}`;
      const cancel = () => cancelPlatformExport(operationId);
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
      abortSignal?.addEventListener('abort', cancel, { once: true });
      if (abortSignal?.aborted) cancel();
      try {
        return await exportProjectToPlatform(
          { ...request, operationId },
          onProgress,
          nativeTools
            ? {
                compileShaders: (shaderProject, compileOptions) => {
                  const shaderOptions = (compileOptions ?? {}) as ShaderCompileOptions;
                  return nativeTools.compileShaders(shaderProject, {
                    ...shaderOptions,
                    sourceOverlays: {
                      ...shaderOptions.sourceOverlays,
                      ...pinnedShaderSourceOverlays(options.pinnedProjectTextSources),
                    },
                  });
                },
                exportPackage: (project, outputPath, packageOptions) =>
                  nativeTools.exportPackage({
                    project,
                    outputPath,
                    options: packageOptionsWithPinnedProjectTextSources(
                      (packageOptions ?? {}) as PreparedRuntimePackageOptions,
                      options.pinnedProjectTextSources,
                    ),
                  }),
              }
            : undefined,
          beforePublish,
          nativeTools?.registerStagedOutput
            ? (recoveryPath) => nativeTools.registerStagedOutput!(recoveryPath)
            : undefined,
          options.runtimeArtifactPaths,
        );
      } finally {
        process.off('SIGINT', cancel);
        process.off('SIGTERM', cancel);
        abortSignal?.removeEventListener('abort', cancel);
      }
    },
    async loadUserConfig() {
      const { loadUserExportConfig } = await import('../main/services/user-export-config-service');
      return loadUserExportConfig();
    },
    async initializeConfig(destination, force) {
      const resolved = path.resolve(destination);
      const kind = await pathKind(resolved);
      if (kind === 'symlink') throw new Error('Refusing to replace a symbolic-link config path.');
      if (kind !== 'missing' && !force)
        throw new Error(
          `Config destination '${resolved}' already exists; use --force to replace it.`,
        );
      const { EDITOR_EXPORT_LOCAL_STATE_FORMAT, parseEditorExportLocalState } =
        await import('../shared/project-schema/platform-export-contracts');
      const value = parseEditorExportLocalState({
        format: EDITOR_EXPORT_LOCAL_STATE_FORMAT,
        templateRoots: [],
        toolchains: {},
        signing: {},
      });
      await mkdir(path.dirname(resolved), { recursive: true });
      const temporary = `${resolved}.tmp-${process.pid}`;
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
      try {
        if (kind !== 'missing') await rm(resolved, { force: true });
        await rename(temporary, resolved);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      return value;
    },
  };
}

export const createNodeNovelTeaCliPlatformToolService = createNovelTeaCliPlatformToolService;
