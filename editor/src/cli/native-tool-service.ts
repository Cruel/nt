import type { ShaderCompileOptions, ShaderCompileResponse } from '../shared/editor-tooling';
import type {
  LocalizationFontCoverageRequest,
  LocalizationFontCoverageResponse,
} from '../shared/localization-font-coverage';
import {
  compileShadersNative,
  exportPackageNative,
  runHeadlessTestNative,
  runTestSuiteNative,
  runUiTestNative,
  shadercNative,
  texturecNative,
  validateFontCoverageNative,
} from '@noveltea/tooling-native';

export interface NovelTeaCliNativeToolService {
  compileShaders(
    shaderProject: unknown,
    options: ShaderCompileOptions,
  ): Promise<ShaderCompileResponse>;
  runHeadlessTest(request: unknown): Promise<unknown>;
  runTestSuite?(request: unknown): Promise<unknown>;
  runUiTest(request: unknown): Promise<unknown>;
  exportPackage(request: unknown): Promise<unknown>;
  validateFontCoverage?(
    request: LocalizationFontCoverageRequest,
  ): Promise<LocalizationFontCoverageResponse>;
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
    async runTestSuite(request) {
      return runTestSuiteNative(request);
    },
    async runUiTest(request) {
      return runUiTestNative(request);
    },
    async exportPackage(request) {
      return exportPackageNative(request);
    },
    async validateFontCoverage(request) {
      return validateFontCoverageNative<LocalizationFontCoverageResponse>(request);
    },
    shaderc(arguments_) {
      return shadercNative(arguments_);
    },
    texturec(arguments_) {
      return texturecNative(arguments_);
    },
  };
}
