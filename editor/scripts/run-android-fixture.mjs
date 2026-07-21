import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync('pnpm', ['exec', 'vp', 'pack'], {
  cwd: editorRoot,
  stdio: 'inherit',
});
if (result.status !== 0) process.exit(result.status ?? 1);
const tool = path.join(
  editorRoot,
  'dist-electron',
  'tools',
  'materialize-android-export-fixture.mjs',
);
const run = spawnSync(process.execPath, [tool, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: 'inherit',
  env: process.env,
});
process.exit(run.status ?? 1);
