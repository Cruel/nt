import type { ShaderCompileOptions, ShaderCompileResponse } from '../shared/editor-tooling';
import {
  compileShadersNative,
  exportPackageNative,
  runHeadlessTestNative,
  runUiTestNative,
  shadercNative,
  texturecNative,
} from '@noveltea/tooling-native';

export interface NovelTeaCliNativeToolService {
  compileShaders(
    shaderProject: unknown,
    options: ShaderCompileOptions,
  ): Promise<ShaderCompileResponse>;
  runHeadlessTest(request: unknown): Promise<unknown>;
  runUiTest(request: unknown): Promise<unknown>;
  exportPackage(request: unknown): Promise<unknown>;
  shaderc(arguments_: readonly string[]): number;
  texturec(arguments_: readonly string[]): number;
}

export function createInProcessNovelTeaCliNativeToolService(): NovelTeaCliNativeToolService {
  return {
    async compileShaders(shaderProject, options) {
      return compileShadersNative<ShaderCompileResponse>({
        shaderProject,
        options,
      });
    },
    async runHeadlessTest(request) {
      return runHeadlessTestNative(request);
    },
    async runUiTest(request) {
      return runUiTestNative(request);
    },
    async exportPackage(request) {
      return exportPackageNative(request);
    },
    shaderc(arguments_) {
      return shadercNative(arguments_);
    },
    texturec(arguments_) {
      return texturecNative(arguments_);
    },
  };
}
