import { spawnSync } from 'node:child_process';
import type { ShaderCompileResponse } from '../shared/editor-tooling';
import type { LocalizationFontCoverageResponse } from '../shared/localization-font-coverage';
import {
  invokeNovelTeaNativeOperation,
  resolveNovelTeaCliPath,
} from '../shared/noveltea-cli-subprocess';
import type { NovelTeaCliNativeToolService } from './native-tool-service';

function runRawNativeTool(command: 'shaderc' | 'texturec', arguments_: readonly string[]): number {
  // Raw tools preserve their native stdio contract, so they cannot use the JSON operation bridge.
  const result = spawnSync(resolveNovelTeaCliPath(), [command, ...arguments_], {
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status === null)
    throw new Error(
      `Native ${command} terminated without an exit code${result.signal ? ` (${result.signal})` : ''}.`,
    );
  return result.status;
}

export function createNodeNovelTeaCliNativeToolService(): NovelTeaCliNativeToolService {
  return {
    async compileShaders(shaderProject, options) {
      return (await invokeNovelTeaNativeOperation('compile-shaders', {
        shaderProject,
        options,
      })) as ShaderCompileResponse;
    },
    runHeadlessTest(request) {
      return invokeNovelTeaNativeOperation('run-test', request);
    },
    runTestSuite(request) {
      return invokeNovelTeaNativeOperation('run-test-suite', request);
    },
    runUiTest(request) {
      return invokeNovelTeaNativeOperation('run-ui-test', request);
    },
    exportPackage(request) {
      return invokeNovelTeaNativeOperation('export-package', request);
    },
    async validateFontCoverage(request) {
      return (await invokeNovelTeaNativeOperation(
        'font-coverage',
        request,
      )) as LocalizationFontCoverageResponse;
    },
    shaderc(arguments_) {
      return runRawNativeTool('shaderc', arguments_);
    },
    texturec(arguments_) {
      return runRawNativeTool('texturec', arguments_);
    },
  };
}
