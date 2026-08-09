import type { ShaderCompileOptions, ShaderCompileResponse } from '../shared/editor-tooling';
import { invokeEditorTool } from '../shared/editor-tool-subprocess';

export interface NovelTeaCliNativeToolService {
  compileShaders(
    shaderProject: unknown,
    options: ShaderCompileOptions,
  ): Promise<ShaderCompileResponse>;
}

export function createSubprocessNovelTeaCliNativeToolService(): NovelTeaCliNativeToolService {
  return {
    async compileShaders(shaderProject, options) {
      return (await invokeEditorTool('compile-shaders', {
        shaderProject,
        options,
      })) as ShaderCompileResponse;
    },
  };
}
