import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packed = spawnSync('pnpm', ['exec', 'vp', 'pack'], { cwd: editorRoot, stdio: 'inherit' });
if (packed.status !== 0) process.exit(packed.status ?? 1);
const tool = path.join(editorRoot, 'dist-electron', 'tools', 'stage-android-project.mjs');
const result = spawnSync(process.execPath, [tool, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
