import { readFileSync } from 'node:fs';
import { bootstrapNovelTeaCli } from '../src/cli/bootstrap';

function readStdinText(): string {
  return readFileSync(0, 'utf8');
}

const arguments_ = process.argv.slice(2);
const bootstrap = bootstrapNovelTeaCli(arguments_);
if (bootstrap.complete) {
  if (bootstrap.result.stdout) process.stdout.write(bootstrap.result.stdout);
  if (bootstrap.result.stderr) process.stderr.write(bootstrap.result.stderr);
  process.exitCode = bootstrap.result.exitCode;
} else {
  const command = bootstrap.globals.command;
  const family = command[0];
  const operation = command[1];
  const needsNativeTools =
    family === 'shaderc' ||
    family === 'texturec' ||
    family === 'validate' ||
    family === 'shaders' ||
    family === 'test' ||
    family === 'package' ||
    (family === 'platform' && operation === 'export');
  const needsSharp =
    family === 'comfyui' ||
    (family === 'asset' && operation === 'import') ||
    (family === 'platform' && operation === 'export');

  const nativeTools = needsNativeTools
    ? (await import('../src/cli/native-tool-service-node')).createNodeNovelTeaCliNativeToolService()
    : undefined;
  if (needsSharp) {
    const { configureSharpPlatformImageService } =
      await import('../src/main/services/platform-image-sharp-service');
    configureSharpPlatformImageService();
  }

  const platformTools =
    family === 'platform'
      ? (
          await import('../src/cli/platform-tool-service-node')
        ).createNodeNovelTeaCliPlatformToolService(nativeTools)
      : undefined;
  const { runNovelTeaCli } = await import('../src/cli/application');
  const result = await runNovelTeaCli(arguments_, {
    readStdinText,
    ...(nativeTools ? { nativeTools } : {}),
    ...(platformTools ? { platformTools } : {}),
    onPlatformProgress: bootstrap.globals.json
      ? undefined
      : (stage, message) => process.stderr.write(`[${stage}] ${message}\n`),
    onAuthoringValidationInstrumentation:
      process.env.NOVELTEA_CLI_VALIDATION_PROFILE === '1'
        ? (instrumentation) =>
            process.stderr.write(`[validation-profile] ${JSON.stringify(instrumentation)}\n`)
        : undefined,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
