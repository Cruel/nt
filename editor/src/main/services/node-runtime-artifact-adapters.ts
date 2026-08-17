import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseShaderCompileResponse } from '../../shared/shader-compile-contract';
import type {
  RuntimeArtifactPathAdapter,
  RuntimeArtifactShaderCompilerAdapter,
} from '../../shared/runtime-artifact-preparation';

export const nodeRuntimeArtifactPaths: RuntimeArtifactPathAdapter = {
  resolveProjectSource(projectRoot, source) {
    return path.isAbsolute(source) || !projectRoot ? source : path.resolve(projectRoot, source);
  },
  shaderAssetRoot(projectRoot) {
    return projectRoot ? path.join(projectRoot, '.noveltea', 'build') : undefined;
  },
  async readProjectTextSources(projectRoot, entries) {
    return Promise.all(
      entries.map(async ({ assetId, projectRelativePath, expectedContentHash }) => {
        if (!projectRoot) return { status: 'unavailable' as const, assetId };
        try {
          const bytes = await readFile(path.resolve(projectRoot, projectRelativePath));
          const contentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
          if (contentHash !== expectedContentHash)
            return { status: 'unavailable' as const, assetId };
          return {
            status: 'ready' as const,
            assetId,
            projectRelativePath,
            contentHash,
            text: bytes.toString('utf8').replace(/^\uFEFF/u, ''),
          };
        } catch {
          return { status: 'unavailable' as const, assetId };
        }
      }),
    );
  },
};

export function nodeShaderCompilerAdapter(
  compile: RuntimeArtifactShaderCompilerAdapter['compile'],
): RuntimeArtifactShaderCompilerAdapter {
  return {
    async compile(shaderProject, options) {
      return parseShaderCompileResponse(await compile(shaderProject, options));
    },
  };
}
