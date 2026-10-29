// Certify the exact installed native CLI, independently from the editor's
// build-time JS modules and without an alternate Project implementation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyNativeProductionClosure } from './native-production-closure.mjs';
import {
  assertInstalledNativeCliBuild,
  assertProductionInputs,
} from './native-production-qualification.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
if (argv[0] === '--') argv.shift(); // pnpm run forwards an explicit option separator.
const cli = path.resolve(argv[0] ?? path.join(root, 'build/cli/linux/noveltea'));
const cliOnly = argv.includes('--cli-only');
const production = argv.includes('--production');
if (
  argv.length > 1 + Number(cliOnly) + Number(production) ||
  argv.some((argument, index) => index > 0 && !['--cli-only', '--production'].includes(argument))
)
  throw new Error(
    'Usage: certify-native-candidate-contracts.mjs [installed-cli] [--cli-only] [--production]',
  );
await assertProductionInputs(cli);
const mode = production ? 'production' : 'candidate';
const roots = production
  ? ['main', 'preload', 'authoring-worker', 'tools', 'renderer'].map((name) =>
      path.join(root, 'editor/dist-electron', name),
    )
  : [];
await assertInstalledNativeCliBuild(cli);
if (production) {
  const violations = await verifyNativeProductionClosure(roots, { requireManifestRoots: roots });
  assert.deepEqual(
    violations,
    [],
    `Unretired Project authority prevents production qualification:\n${violations.join('\n')}`,
  );
}

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
  [
    'Native emitted module provenance',
    production ? 'check-native-production-closure.mjs' : 'check-native-cli-closure.mjs',
    [],
  ],
  [
    'Native public command goldens and negatives',
    'certify-native-cli-public-contracts.mjs',
    production ? [cli, '--production'] : [cli],
  ],
  [
    'Native Feature Lab, source/cache, Tests and archive contracts',
    'certify-native-production-lifecycle.mjs',
    production ? [cli] : [cli, '--candidate'],
  ],
  [
    'Native resident restart and worker cancellation',
    'certify-native-cli-owner-lifecycle.mjs',
    [
      cli,
      path.join(root, 'tests/projects/feature-lab'),
      production ? '--production' : '--candidate',
    ],
  ],
  [
    'Native Runtime Package bytes and pinned source race',
    'certify-native-cli-package.mjs',
    [
      cli,
      path.join(root, 'tests/projects/feature-lab'),
      production ? '--production' : '--candidate',
    ],
  ],
  [
    'Native Web platform preflight and publication',
    'certify-native-cli-platform.mjs',
    [cli, production ? '--production' : '--candidate'],
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
if (production)
  steps.push([
    'Installed native stdin, output parent and HTTPS early-exit regressions',
    'certify-native-cli-production-regressions.mjs',
    [cli],
  ]);
if (!cliOnly)
  steps.push([
    'Independent native editor/CLI disk interaction',
    'certify-native-authoring-cross-system.mjs',
    [cli, production ? '--production' : '--candidate'],
  ]);

for (const [label, script, args] of steps) {
  console.log(`[native ${mode}] ${label}: START`);
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
  console.log(`[native ${mode}] ${label}: PASS`);
}
console.log(`Native-only ${mode} contracts PASSED (${steps.length} independent stages).`);
