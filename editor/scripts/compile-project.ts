import {
  compileProjectExitCodes,
  runCompileProjectCommand,
} from '../src/cli/compile-project-command';

async function main(): Promise<void> {
  try {
    const commandArguments = process.argv.slice(2);
    if (commandArguments[0] === '--') commandArguments.shift();
    const result = await runCompileProjectCommand(commandArguments);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[error] PROJECT_COMPILE_OUTPUT_WRITE /: Unexpected project compiler failure: ${message}\n`,
    );
    process.exitCode = compileProjectExitCodes.output;
  }
}

void main();
