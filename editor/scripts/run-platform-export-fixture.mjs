import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The old build-only TypeScript Project fixture generator was retired with
// native authoring. Never require dist-build-tools or republish that oracle.
const tool = path.join(editorRoot, 'scripts/materialize-native-platform-export-fixture.mjs');
const forwardedArgs = process.argv.slice(2);
const targetIndex = forwardedArgs.indexOf('--target');
const target = targetIndex >= 0 ? forwardedArgs[targetIndex + 1] : 'android';
const fixtureArgs = forwardedArgs.includes('--root')
  ? forwardedArgs
  : [
      '--root',
      path.resolve(editorRoot, '..', 'build', 'platform-export-fixtures', target),
      ...forwardedArgs,
    ];
if (targetIndex < 0) fixtureArgs.push('--target', target);
const run = spawnSync(process.execPath, [tool, ...fixtureArgs], {
  cwd: process.cwd(),
  stdio: 'inherit',
  env: process.env,
});
process.exit(run.status ?? 1);
