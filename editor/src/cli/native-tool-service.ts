import type { ShaderCompileOptions, ShaderCompileResponse } from '../shared/editor-tooling';
import type {
  LocalizationFontCoverageRequest,
  LocalizationFontCoverageResponse,
} from '../shared/localization-font-coverage';
import { validateImportedAudioVideo } from '../main/services/media-import-validation-service';
import {
  compileShadersNative,
  exportPackageNative,
  runHeadlessTestNative,
  runTestSuiteNative,
  runUiTestNative,
  shadercNative,
  texturecNative,
  validateFontCoverageNative,
  inspectFontNative,
} from '@noveltea/tooling-native';

export interface NovelTeaCliNativeToolService {
  inspectFont?(absolutePath: string): Promise<{ ok: boolean; glyphCount?: number; error?: string }>;
  validateMedia?(absolutePath: string, kind: 'audio' | 'video'): Promise<void>;
  compileShaders(
    shaderProject: unknown,
    options: ShaderCompileOptions,
  ): Promise<ShaderCompileResponse>;
  runHeadlessTest(request: unknown): Promise<unknown>;
  runTestSuite?(request: unknown): Promise<unknown>;
  runUiTest(request: unknown): Promise<unknown>;
  exportPackage(request: unknown): Promise<unknown>;
  registerStagedOutput?(path: string): Promise<void>;
  commitComfyUiAssetPublication?(request: unknown): Promise<unknown>;
  validateFontCoverage?(
    request: LocalizationFontCoverageRequest,
  ): Promise<LocalizationFontCoverageResponse>;
  shaderc(arguments_: readonly string[]): number;
  texturec(arguments_: readonly string[]): number;
}

export function createInProcessNovelTeaCliNativeToolService(): NovelTeaCliNativeToolService {
  return {
    validateMedia: validateImportedAudioVideo,
    async inspectFont(absolutePath) {
      return inspectFontNative({ path: absolutePath });
    },
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
