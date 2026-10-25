import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platform =
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const executablePath = path.join(
  editorRoot,
  '..',
  'build',
  'cli',
  platform,
  process.platform === 'win32' ? 'noveltea.exe' : 'noveltea',
);
const commandArguments = process.argv.slice(2);
if (commandArguments[0] === '--') commandArguments.shift();
if (!existsSync(executablePath)) {
  process.stderr.write(
    'Native NovelTea CLI is not installed. Run pnpm run noveltea:build first.\n',
  );
  process.exitCode = 1;
} else {
  const result = spawnSync(executablePath, commandArguments, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    process.stderr.write(`Unable to execute the NovelTea CLI: ${result.error.message}\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}
