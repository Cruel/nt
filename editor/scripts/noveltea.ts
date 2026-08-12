import { readFileSync } from 'node:fs';
import { runNovelTeaCli } from '../src/cli/application';
import { createInProcessNovelTeaCliNativeToolService } from '../src/cli/native-tool-service';
import { createNodeNovelTeaCliPlatformToolService } from '../src/cli/platform-tool-service-node';
import { configureSharpPlatformImageService } from '../src/main/services/platform-image-sharp-service';

function readStdinText(): string {
  return readFileSync(0, 'utf8');
}

const arguments_ = process.argv.slice(2);
const json = arguments_.includes('--json');
configureSharpPlatformImageService();
const nativeTools = createInProcessNovelTeaCliNativeToolService();
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
process.exit(result.exitCode);
