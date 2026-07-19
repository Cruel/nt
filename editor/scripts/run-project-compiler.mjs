import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compilerPath = path.join(editorRoot, 'dist-electron', 'tools', 'project-compile.mjs');
const commandArguments = process.argv.slice(2);
const structuredOutput = commandArguments.includes('--json');
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

const buildResult = spawnSync(pnpmCommand, ['exec', 'vp', 'pack'], {
  cwd: editorRoot,
  env: process.env,
  stdio: structuredOutput ? ['inherit', 2, 2] : 'inherit',
});
if (buildResult.error) {
  process.stderr.write(`Unable to build the project compiler: ${buildResult.error.message}\n`);
  process.exitCode = 1;
} else if (buildResult.status !== 0) {
  process.exitCode = buildResult.status ?? 1;
} else {
  const compilerResult = spawnSync(process.execPath, [compilerPath, ...commandArguments], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (compilerResult.error) {
    process.stderr.write(
      `Unable to execute the project compiler: ${compilerResult.error.message}\n`,
    );
    process.exitCode = 1;
  } else {
    process.exitCode = compilerResult.status ?? 1;
  }
}
