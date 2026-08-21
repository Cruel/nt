import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EDITOR_EXPORT_LOCAL_STATE_FORMAT,
  EDITOR_EXPORT_LOCAL_STATE_FORMAT_VERSION,
  parseEditorExportLocalState,
} from '../shared/project-schema/platform-export-contracts';
import { exportProjectToPlatform } from '../main/services/platform-export-orchestration-service';
import { cancelPlatformExport } from '../main/services/platform-staging-service';
import {
  inspectPlayerTemplate,
  installPlayerTemplate,
  listPlayerTemplates,
  removePlayerTemplate,
} from '../main/services/template-registry-service';
import type { NovelTeaCliPlatformToolService } from './platform-tool-service';
import type { NovelTeaCliNativeToolService } from './native-tool-service';
import { loadUserExportConfig } from '../main/services/user-export-config-service';

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
): NovelTeaCliPlatformToolService {
  return {
    listTemplates: () => listPlayerTemplates(),
    async inspectTemplate(token) {
      const [templateId, buildId] = internalToken(token).split('/');
      return inspectPlayerTemplate(templateId!, buildId!);
    },
    installTemplate: (archivePath, force) =>
      installPlayerTemplate({
        archivePath: path.resolve(archivePath),
        force,
        origin: 'noveltea-cli',
      }),
    async removeTemplate(token) {
      const [templateId, buildId] = internalToken(token).split('/');
      return removePlayerTemplate(templateId!, buildId!);
    },
    async exportProject(request, onProgress) {
      const operationId = request.operationId ?? `cli-${process.pid}-${Date.now()}`;
      const cancel = () => cancelPlatformExport(operationId);
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
      try {
        return await exportProjectToPlatform(
          { ...request, operationId },
          onProgress,
          nativeTools
            ? {
                compileShaders: (shaderProject, options) =>
                  nativeTools.compileShaders(shaderProject, options ?? {}),
                exportPackage: (project, outputPath, options) =>
                  nativeTools.exportPackage({ project, outputPath, options: options ?? {} }),
              }
            : undefined,
        );
      } finally {
        process.off('SIGINT', cancel);
        process.off('SIGTERM', cancel);
      }
    },
    loadUserConfig: () => loadUserExportConfig(),
    async initializeConfig(destination, force) {
      const resolved = path.resolve(destination);
      const kind = await pathKind(resolved);
      if (kind === 'symlink') throw new Error('Refusing to replace a symbolic-link config path.');
      if (kind !== 'missing' && !force)
        throw new Error(
          `Config destination '${resolved}' already exists; use --force to replace it.`,
        );
      const value = parseEditorExportLocalState({
        format: EDITOR_EXPORT_LOCAL_STATE_FORMAT,
        formatVersion: EDITOR_EXPORT_LOCAL_STATE_FORMAT_VERSION,
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
