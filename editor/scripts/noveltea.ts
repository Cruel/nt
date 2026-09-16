import { readFileSync } from 'node:fs';
import { runNovelTeaCli } from '../src/cli/application';
import { createInProcessNovelTeaCliNativeToolService } from '../src/cli/native-tool-service';
import { invokeNovelTeaNativeOperation } from '../src/shared/noveltea-cli-subprocess';
import { createNodeNovelTeaCliPlatformToolService } from '../src/cli/platform-tool-service-node';
import { runLocalizationFontCoverage } from '../src/shared/localization-font-coverage-subprocess';
import { configureSharpPlatformImageService } from '../src/main/services/platform-image-sharp-service';

function readStdinText(): string {
  return readFileSync(0, 'utf8');
}

const arguments_ = process.argv.slice(2);
const json = arguments_.includes('--json');
configureSharpPlatformImageService();
const nativeTools = createInProcessNovelTeaCliNativeToolService();
if (process.env.NOVELTEA_CLI) {
  nativeTools.compileShaders = async (shaderProject, options) =>
    (await invokeNovelTeaNativeOperation('compile-shaders', {
      shaderProject,
      options,
    })) as Awaited<ReturnType<typeof nativeTools.compileShaders>>;
  nativeTools.runHeadlessTest = (request) => invokeNovelTeaNativeOperation('run-test', request);
  nativeTools.runTestSuite = (request) => invokeNovelTeaNativeOperation('run-test-suite', request);
  nativeTools.runUiTest = (request) => invokeNovelTeaNativeOperation('run-ui-test', request);
  nativeTools.exportPackage = (request) => invokeNovelTeaNativeOperation('export-package', request);
}
nativeTools.validateFontCoverage = runLocalizationFontCoverage;
const result = await runNovelTeaCli(arguments_, {
  readStdinText,
  nativeTools,
  platformTools: createNodeNovelTeaCliPlatformToolService(nativeTools),
  onPlatformProgress: json
    ? undefined
    : (stage, message) => process.stderr.write(`[${stage}] ${message}\n`),
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
