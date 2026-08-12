import type { ShaderCompileResponse } from '../../shared/editor-tooling';
import { parseShaderCompileResponse } from '../../shared/shader-compile-contract';
import type {
  RuntimeArtifactPathAdapter,
  RuntimeArtifactShaderCompilerAdapter,
} from '../../shared/runtime-artifact-preparation';
import { useShaderCompileStore } from '../shaders/shader-compile-store';

export const rendererRuntimeArtifactPaths: RuntimeArtifactPathAdapter = {
  resolveProjectSource(projectRoot, source) {
    if (/^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(source)) return source;
    const clean = source.replace(/^[/\\]+/, '').replace(/\\/g, '/');
    return projectRoot ? `${projectRoot.replace(/[\\/]+$/, '')}/${clean}` : clean;
  },
  shaderAssetRoot(projectRoot) {
    return projectRoot ? `${projectRoot.replace(/[\\/]+$/, '')}/.noveltea/build` : undefined;
  },
};

export const rendererShaderCompilerAdapter: RuntimeArtifactShaderCompilerAdapter = {
  async compile(shaderProject, options) {
    useShaderCompileStore.setState({
      compiling: true,
      lastOptions: options,
      diagnostics: [],
      outputs: [],
      authoringOutputs: [],
      error: null,
    });
    try {
      const response = parseShaderCompileResponse(
        await window.noveltea.compileShaders(shaderProject, options),
      );
      useShaderCompileStore.getState().setResult(response, options);
      return response;
    } catch (error) {
      const response: ShaderCompileResponse = {
        ok: false,
        success: false,
        outputs: [],
        diagnostics: [
          { severity: 'error', message: error instanceof Error ? error.message : String(error) },
        ],
        error: error instanceof Error ? error.message : String(error),
      };
      useShaderCompileStore.getState().setResult(response, options);
      return response;
    }
  },
};
