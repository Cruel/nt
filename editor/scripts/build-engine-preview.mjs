import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: false,
    });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (error) => {
      console.error(error);
      resolve(1);
    });
  });
}

const configure = await run('cmake', ['--preset', 'web-debug']);
if (configure !== 0) {
  process.exit(configure);
}

const build = await run('cmake', [
  '--build',
  '--preset',
  'web-debug',
  '--target',
  'noveltea-sandbox',
]);
process.exit(build);
