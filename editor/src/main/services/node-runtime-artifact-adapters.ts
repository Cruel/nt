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
