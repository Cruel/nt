import { readFileSync } from 'node:fs';
import {
  bootstrapNovelTeaCli,
  novelTeaCliCommandNeedsZod,
  novelTeaCliUsageFailure,
} from '../src/cli/bootstrap';
import { runNovelTeaAgentSyncCli } from '../src/cli/agent-sync-cli';
import { createPerryProjectWorkspaceFileSystem } from '../src/shared/project-workspace/perry-project-workspace-file-system';

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
      const { createInProcessNovelTeaCliNativeToolService } =
        await import('../src/cli/native-tool-service');
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
    const { createInProcessNovelTeaCliNativeToolService } =
      await import('../src/cli/native-tool-service');
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
  const bootstrap = bootstrapNovelTeaCli(argv);
  if (bootstrap.complete) {
    finalStdout = bootstrap.result.stdout;
    finalStderr = bootstrap.result.stderr;
    finalExitCode = bootstrap.result.exitCode;
  } else {
    const fileSystem = createPerryProjectWorkspaceFileSystem();
    if (bootstrap.globals.command[0] === 'agent') {
      const result = await runNovelTeaAgentSyncCli(bootstrap.globals, fileSystem);
      finalStdout = result.stdout;
      finalStderr = result.stderr;
      finalExitCode = result.exitCode;
    } else if (bootstrap.globals.command[0] === 'shaderc') {
      if (bootstrap.globals.json) {
        const result = novelTeaCliUsageFailure(
          "Raw 'shaderc' does not support NovelTea --json mode.",
          true,
        );
        finalStdout = result.stdout;
        finalStderr = result.stderr;
        finalExitCode = result.exitCode;
      } else {
        const nativeTools = (
          await import('../src/cli/native-tool-service')
        ).createInProcessNovelTeaCliNativeToolService();
        try {
          finalExitCode = nativeTools.shaderc(bootstrap.globals.command.slice(1));
        } catch (error) {
          finalStderr = `${error instanceof Error ? error.message : String(error)}\n`;
          finalExitCode = 70;
        }
      }
    } else {
      if (novelTeaCliCommandNeedsZod(bootstrap.globals.command)) await import('./zod-jitless');
      const [{ runNovelTeaCli }, { createHostProjectWorkspaceService }] = await Promise.all([
        import('../src/cli/application'),
        import('../src/shared/project-workspace/node-project-workspace-service'),
      ]);
      const needsNativeTools =
        bootstrap.globals.command[0] === 'validate' ||
        bootstrap.globals.command[0] === 'shaders' ||
        bootstrap.globals.command[0] === 'test' ||
        bootstrap.globals.command[0] === 'package';
      const nativeTools = needsNativeTools
        ? (
            await import('../src/cli/native-tool-service')
          ).createInProcessNovelTeaCliNativeToolService()
        : undefined;
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
  }
}

await writeBeforeExit(process.stdout, finalStdout);
await writeBeforeExit(process.stderr, finalStderr);
process.exit(finalExitCode);
