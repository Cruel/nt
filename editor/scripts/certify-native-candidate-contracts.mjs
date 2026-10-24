// #534 staged #521 certification: independently exercise native production
// seams on an installed native-only ScriptC candidate, without a Node Project
// implementation, retired Project oracle, or certification routing flags.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertProductionInputs } from './native-production-qualification.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
if (argv[0] === '--') argv.shift(); // pnpm run forwards an explicit option separator.
const cli = path.resolve(argv[0] ?? path.join(root, 'build/cli/linux/noveltea'));
const cliOnly = argv[1] === '--cli-only';
if (argv.length > (cliOnly ? 2 : 1))
  throw new Error('Usage: certify-native-candidate-contracts.mjs [installed-cli] [--cli-only]');
await assertProductionInputs(cli);

// Bind the checked native-only island to the installed CLI bytes. Merely
// finding a valid candidate island alongside a rebuilt legacy CLI must not
// constitute native production certification.
const provenance = JSON.parse(
  await readFile(path.join(path.dirname(cli), 'native-candidate-build.json'), 'utf8'),
);
const fingerprint = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
assert.equal(provenance.contract, 'noveltea.native-cli-candidate-build.v1');
assert.equal(
  provenance.executableSha256,
  fingerprint(await readFile(cli)),
  'Installed CLI differs from candidate build.',
);
assert.equal(
  provenance.islandProvenanceSha256,
  fingerprint(
    await readFile(
      path.join(root, 'editor/dist-scriptc-native-island/native-production-provenance.json'),
    ),
  ),
  'Installed CLI was built from different native candidate provenance.',
);

const addon = process.env.NOVELTEA_AUTHORING_NODE_ADDON;
assert.ok(
  cliOnly || addon,
  'Pass NOVELTEA_AUTHORING_NODE_ADDON for the independent editor/CLI disk witness, or explicitly --cli-only.',
);
const environment = { ...process.env };
for (const key of Object.keys(environment))
  if (
    key.startsWith('NOVELTEA_CLI_CERTIFICATION') ||
    key.startsWith('NOVELTEA_EDITOR_CERTIFICATION')
  )
    throw new Error(`Certification routing flag is forbidden: ${key}`);

/** @type {Array<[string, string, string[]]>} */
const steps = [
  ['Native ScriptC emitted module provenance', 'check-native-cli-candidate-closure.mjs', []],
  ['Native public command goldens and negatives', 'certify-native-cli-public-contracts.mjs', [cli]],
  [
    'Native Feature Lab, source/cache, Tests and archive contracts',
    'certify-native-production-lifecycle.mjs',
    [cli, '--candidate'],
  ],
  [
    'Native resident restart and worker cancellation',
    'certify-native-cli-owner-lifecycle.mjs',
    [cli, path.join(root, 'tests/projects/feature-lab'), '--candidate'],
  ],
  [
    'Native Runtime Package bytes and pinned source race',
    'certify-native-cli-package.mjs',
    [cli, path.join(root, 'tests/projects/feature-lab'), '--candidate'],
  ],
  [
    'Native Web platform preflight and publication',
    'certify-native-cli-platform.mjs',
    [cli, '--candidate'],
  ],
  [
    'Native ComfyUI transport and Asset publication',
    'certify-native-cli-comfyui-contracts.mjs',
    [cli],
  ],
  [
    'Native ComfyUI source drift and Asset publication rollback',
    'certify-native-cli-comfyui-race.mjs',
    [cli],
  ],
];
if (!cliOnly)
  steps.push([
    'Independent native editor/CLI disk interaction',
    'certify-native-authoring-cross-system.mjs',
    [cli, '--candidate'],
  ]);

for (const [label, script, args] of steps) {
  console.log(`[native candidate] ${label}: START`);
  const result = spawnSync(process.execPath, [path.join(root, 'editor/scripts', script), ...args], {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.ifError(result.error);
  if (result.status !== 0)
    throw new Error(
      `${label} failed (exit ${result.status}, signal ${result.signal}):\n${result.stdout}\n${result.stderr}`,
    );
  process.stdout.write(result.stdout);
  assert.equal(result.stderr, '', `${label} wrote unexpected stderr: ${result.stderr}`);
  console.log(`[native candidate] ${label}: PASS`);
}
console.log(`Native-only candidate contracts PASSED (${steps.length} independent stages).`);
