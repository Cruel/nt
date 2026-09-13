import { chmodSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { prepareSnapshot, publishSnapshot } from '../scripts/development-snapshot.mjs';
import { r2Store } from '../scripts/development-snapshot-r2.mjs';
import { readNovelTeaVersion } from '../scripts/noveltea-version.mjs';

const run = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).workflow_run;
if (
  run.conclusion !== 'success' ||
  run.event !== 'push' ||
  run.head_branch !== 'master' ||
  run.head_repository.full_name !== 'Cruel/nt'
)
  throw new Error('Only successful Cruel/nt master push builds may publish');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (revision !== run.head_sha) throw new Error('Checkout does not match the successful Build run');
const cliPath = path.resolve('build/snapshot-input/cli/noveltea');
const archivePath = path.resolve(
  `build/snapshot-input/player/noveltea-player-template-dev-${revision}-web-wasm32-threads-release.zip`,
);
const descriptorPath = 'build/snapshot-input/player/web-wasm32-threads-release.template.json';
const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
const embedded = JSON.parse(
  execFileSync(
    'unzip',
    ['-p', archivePath, 'noveltea-player-web-wasm32-threads-release/template.json'],
    { encoding: 'utf8' },
  ),
);
if (JSON.stringify(embedded) !== JSON.stringify(descriptor))
  throw new Error('Player archive descriptor mismatch');
chmodSync(cliPath, 0o755);
const snapshot = prepareSnapshot({
  revision,
  runNumber: run.run_number,
  createdAt: run.created_at,
  version: readNovelTeaVersion().version,
  cli: readFileSync(cliPath),
  cliIdentity: JSON.parse(execFileSync(cliPath, ['--version', '--json'], { encoding: 'utf8' })),
  player: readFileSync(archivePath),
  descriptor,
});
// The same preparation path runs without credentials for CI/local artifact inspection.
if (process.argv.includes('--dry-run')) {
  mkdirSync('build/development-snapshot', { recursive: true });
  writeFileSync(
    'build/development-snapshot/snapshot.json',
    snapshot.files.get(snapshot.manifestKey),
  );
} else {
  await publishSnapshot(
    r2Store({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      token: process.env.CLOUDFLARE_API_TOKEN,
    }),
    snapshot,
  );
}
console.log(
  `Validated development toolchain ${revision}${process.argv.includes('--dry-run') ? ' (dry run)' : ' and completed publication'}`,
);
