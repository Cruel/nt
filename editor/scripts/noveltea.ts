import { readFileSync } from 'node:fs';
import './zod-jitless';
import { runNovelTeaCli } from '../src/cli/application';
import { createInProcessNovelTeaCliNativeToolService } from '../src/cli/native-tool-service';
import {
  createHostProjectWorkspaceService,
  createPerryProjectWorkspaceFileSystem,
} from '../src/shared/project-workspace';

function readStdinText(): string {
  return readFileSync(process.platform === 'win32' ? 0 : '/dev/stdin', 'utf8');
}

function writeBeforeExit(stream: NodeJS.WriteStream, value: string): Promise<void> {
  if (!value) return Promise.resolve();
  // Perry writes immediately but never invokes the stream callback, which would strand top-level await.
  if ('perry' in process.versions) {
    stream.write(value);
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    stream.write(value, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

const argv = process.argv.slice(2);
let finalExitCode = 0;
let finalStdout = '';
let finalStderr = '';
if (argv[0] === '__shaderc-batch') {
  if (argv.length !== 1) {
    finalStderr = 'Internal shaderc batch bridge accepts no arguments.\n';
    finalExitCode = 2;
  } else {
    const parsed = JSON.parse(readStdinText() || '[]') as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.some(
        (entry) => !Array.isArray(entry) || entry.some((argument) => typeof argument !== 'string'),
      )
    ) {
      finalStderr = 'Internal shaderc batch bridge requires an array of string arrays.\n';
      finalExitCode = 2;
    } else {
      const nativeTools = createInProcessNovelTeaCliNativeToolService();
      for (const command of parsed as string[][]) {
        const exitCode = nativeTools.shaderc(command);
        if (exitCode !== 0) {
          finalExitCode = exitCode;
          break;
        }
      }
    }
  }
} else if (argv[0] === '__editor-native') {
  const operation = argv[1];
  if (argv.length !== 2 || !operation) {
    finalStderr = 'Internal editor native bridge requires exactly one operation.\n';
    finalExitCode = 2;
  } else {
    const input = JSON.parse(readStdinText() || '{}') as Record<string, unknown>;
    const nativeTools = createInProcessNovelTeaCliNativeToolService();
    let response: unknown;
    if (operation === 'compile-shaders') {
      response = await nativeTools.compileShaders(input.shaderProject, input.options ?? {});
    } else if (operation === 'run-test') {
      response = await nativeTools.runHeadlessTest(input);
    } else if (operation === 'run-ui-test') {
      response = await nativeTools.runUiTest(input);
    } else if (operation === 'export-package') {
      response = await nativeTools.exportPackage(input);
    } else {
      finalStderr = `Unknown internal editor native operation '${operation}'.\n`;
      finalExitCode = 2;
    }
    if (response !== undefined) {
      finalStdout = `${JSON.stringify(response)}\n`;
      const record =
        response && typeof response === 'object' ? (response as Record<string, unknown>) : {};
      finalExitCode = record.ok === true ? 0 : 1;
    }
  }
} else {
  const fileSystem = createPerryProjectWorkspaceFileSystem();
  const nativeTools = createInProcessNovelTeaCliNativeToolService();
  const result = await runNovelTeaCli(argv, {
    fileSystem,
    workspace: createHostProjectWorkspaceService(fileSystem),
    nativeTools,
    readStdinText,
  });
  finalStdout = result.stdout;
  finalStderr = result.stderr;
  finalExitCode = result.exitCode;
}

await writeBeforeExit(process.stdout, finalStdout);
await writeBeforeExit(process.stderr, finalStderr);
process.exit(finalExitCode);
