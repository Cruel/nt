import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { prepareOpaqueVideoMotion } from './opaque-video-preparation-service';
import {
  installedMediaTool,
  runMediaToolProcess,
  type MediaToolRunner,
} from './media-preparation-service';
import { resolveNovelTeaCliPath } from '../../shared/noveltea-cli-subprocess';
import { parseShaderCompileResponse } from '../../shared/shader-compile-contract';
import type {
  RuntimeArtifactPathAdapter,
  RuntimeArtifactShaderCompilerAdapter,
} from '../../shared/runtime-artifact-preparation';

export function createNodeRuntimeArtifactPaths(
  cliExecutable: () => string = resolveNovelTeaCliPath,
  mediaRunner: MediaToolRunner = runMediaToolProcess,
): RuntimeArtifactPathAdapter {
  return {
    resolveProjectSource(projectRoot, source) {
      return path.isAbsolute(source) || !projectRoot ? source : path.resolve(projectRoot, source);
    },
    shaderAssetRoot(projectRoot) {
      return projectRoot ? path.join(projectRoot, '.noveltea', 'build') : undefined;
    },
    async prepareOpaqueVideo(projectRoot, request) {
      if (!projectRoot) throw new Error('Video preparation requires a Project root.');
      return prepareOpaqueVideoMotion(
        projectRoot,
        request,
        installedMediaTool(process.env.NOVELTEA_FFMPEG === undefined ? cliExecutable() : undefined),
        mediaRunner,
      );
    },
    async readProjectTextSources(projectRoot, entries) {
      return Promise.all(
        entries.map(async ({ assetId, projectRelativePath, expectedContentHash }) => {
          if (!projectRoot) return { status: 'unavailable' as const, assetId };
          try {
            const root = await realpath(projectRoot);
            const source = await realpath(path.resolve(root, projectRelativePath));
            const relative = path.relative(root, source);
            if (
              relative === '..' ||
              relative.startsWith(`..${path.sep}`) ||
              path.isAbsolute(relative)
            )
              return { status: 'unavailable' as const, assetId };
            if ((await stat(source)).size > 2 * 1024 * 1024)
              return { status: 'unavailable' as const, assetId };
            const bytes = await readFile(source);
            const contentHash =
              `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
            if (expectedContentHash !== null && contentHash !== expectedContentHash)
              return { status: 'unavailable' as const, assetId };
            return {
              status: 'ready' as const,
              assetId,
              projectRelativePath,
              contentHash,
              byteLength: bytes.byteLength,
              text: new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, ''),
            };
          } catch {
            return { status: 'unavailable' as const, assetId };
          }
        }),
      );
    },
  };
}

export const nodeRuntimeArtifactPaths = createNodeRuntimeArtifactPaths();

export function nodeShaderCompilerAdapter(
  compile: RuntimeArtifactShaderCompilerAdapter['compile'],
): RuntimeArtifactShaderCompilerAdapter {
  return {
    async compile(shaderProject, options) {
      return parseShaderCompileResponse(await compile(shaderProject, options));
    },
  };
}
