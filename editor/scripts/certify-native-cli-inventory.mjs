// #551: The authoritative public inventory is the help embedded in C++, not
// the retired TypeScript CLI parser or command implementations.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const help = read('tools/editor_tool/native_cli_help.txt');
const section = help.split('\nCommands:\n')[1]?.split('\nGlobal options:\n')[0];
assert.ok(section, 'Native help must enumerate all public commands.');
const paths = [
  ...new Set(
    section
      .split('\n')
      .filter((line) => /^  [a-z]/.test(line))
      .map((line) => line.trim().match(/^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*/)?.[0]),
  ),
];
const comparePaths = (left, right) => left.localeCompare(right);
assert.ok(paths.every(Boolean));
const witnesses = {
  'project create': 'certify-native-cli-project-routing.mjs',
  'project export': 'certify-native-cli-project-routing.mjs',
  'project import': 'certify-native-project-command-differential.mjs',
  'agent sync': 'certify-native-cli-public-contracts.mjs',
  'comfyui status': 'certify-native-cli-comfyui-contracts.mjs',
  'comfyui workflows': 'certify-native-cli-comfyui-contracts.mjs',
  'comfyui verify': 'certify-native-cli-comfyui-contracts.mjs',
  'comfyui run': 'certify-native-cli-comfyui-contracts.mjs',
  validate: 'certify-native-daemon-validation.mjs',
  'narrative validate': 'certify-native-cli-public-contracts.mjs',
  'narrative context': 'certify-native-cli-public-contracts.mjs',
  fmt: 'certify-native-cli-project-routing.mjs',
  'localization sync': 'certify-native-cli-project-routing.mjs',
  'localization reconcile': 'certify-native-cli-mutations.mjs',
  'localization view': 'certify-native-cli-commands.mjs',
  'localization accept': 'certify-native-cli-mutations.mjs',
  'localization review': 'certify-native-cli-mutations.mjs',
  'asset audit': 'certify-native-cli-project-routing.mjs',
  'asset import': 'certify-native-cli-mutations.mjs',
  'entity create': 'certify-native-cli-mutations.mjs',
  'entity inspect': 'certify-native-cli-commands.mjs',
  'entity rename': 'certify-native-cli-mutations.mjs',
  'entity delete': 'certify-native-cli-mutations.mjs',
  usages: 'certify-native-cli-project-routing.mjs',
  'shaders compile': 'certify-native-cli-project-routing.mjs',
  shaderc: 'certify-native-cli-public-contracts.mjs',
  texturec: 'certify-native-cli-public-contracts.mjs',
  'media-tool check': 'certify-native-cli-public-contracts.mjs',
  'daemon status': 'certify-native-cli-owner-lifecycle.mjs',
  'daemon stop': 'certify-native-cli-owner-lifecycle.mjs',
  'test run': 'certify-native-cli-tests.mjs',
  'test run-spec': 'certify-native-cli-tests.mjs',
  'test run-ui-spec': 'certify-native-cli-tests.mjs',
  'package export': 'certify-native-cli-package.mjs',
  'platform profiles': 'certify-native-cli-platform.mjs',
  'platform export': 'certify-native-cli-platform.mjs',
  'platform template list': 'certify-native-cli-platform.mjs',
  'platform template inspect': 'certify-native-cli-platform.mjs',
  'platform template install': 'certify-native-cli-platform.mjs',
  'platform template remove': 'certify-native-cli-platform.mjs',
  'platform config init': 'certify-native-cli-platform.mjs',
};
assert.deepEqual(
  paths.sort(comparePaths),
  Object.keys(witnesses).sort(comparePaths),
  'Native public command inventory changed without an installed-CLI certification owner.',
);
for (const witness of Object.values(witnesses))
  assert.ok(
    statSync(path.join(root, 'editor/scripts', witness)).isFile(),
    `Missing native CLI command witness: ${witness}`,
  );

const nativeCli = read('tools/editor_tool/native_cli.cpp');
assert.match(nativeCli, /bool known_command\(/);
assert.match(nativeCli, /help\.find\("\\nCommands:/);
const dispatcher = read('tools/editor_tool/tooling_native_project_commands.cpp');
const actions = [
  ...new Set([...dispatcher.matchAll(/\baction\s*==\s*"([a-z-]+)"/g)].map((match) => match[1])),
].sort(comparePaths);
const ownedActions = [
  'project-create',
  'project-import',
  'project-export',
  'project-diagnostic-locations',
  'project-validate',
  'source-generation-proof',
  'validation-source-generation-proof',
  'workspace-preflight',
  'platform-profiles-preparation',
  'asset-audit',
  'asset-import',
  'comfyui-assets',
  'comfyui-admission',
  'entity-inspect',
  'entity-usages',
  'entity-create',
  'entity-rename',
  'entity-delete',
  'scoped-edit',
  'fmt-strip-defaults',
  'fmt',
  'localization-targets',
  'localization-view',
  'localization-sync',
  'localization-reconcile',
  'shader-preparation',
  'runtime-package-preparation',
  'platform-export-preparation',
  'export-preparation',
].sort(comparePaths);
assert.deepEqual(
  actions,
  ownedActions,
  'C++ native Project action inventory changed without explicit certification.',
);

const ipcText = read('editor/src/shared/ipc-channels.ts');
const ipc = [...ipcText.matchAll(/^\s+(NATIVE_PROJECT_[A-Z_]+):/gm)]
  .map((m) => m[1])
  .sort(comparePaths);
const ipcWitnesses = {
  NATIVE_PROJECT_PATCH: 'native-editor-session-controller.test.ts',
  NATIVE_PROJECT_SAVE_UNIT: 'project-save-coordinator.test.ts',
  NATIVE_PROJECT_SAVE_TEXT: 'native-project-source-transactions.test.ts',
  NATIVE_PROJECT_STAGE_TEXT: 'native-project-source-transactions.test.ts',
  NATIVE_PROJECT_RECONCILE: 'native-authoring-reconciliation.test.ts',
  NATIVE_PROJECT_USE_DISK_UNIT: 'native-authoring-reconciliation.test.ts',
  NATIVE_PROJECT_VALIDATE: 'native-editor-session-controller.test.ts',
  NATIVE_PROJECT_SEMANTIC_GRAPH: 'native-renderer-graph-runtime.test.ts',
  NATIVE_PROJECT_PREPARE_RUNTIME: 'native-authoring-worker.test.ts',
  NATIVE_PROJECT_TEST_READINESS: 'native-editor-test-readiness.test.ts',
  NATIVE_PROJECT_RUN_TEST: 'native-authoring-worker.test.ts',
  NATIVE_PROJECT_RUN_SUITE: 'native-authoring-worker.test.ts',
  NATIVE_PROJECT_PREPARE_EXPORT: 'native-editor-export-service.test.ts',
  NATIVE_PROJECT_EXPORT_PACKAGE: 'native-editor-export-service.test.ts',
};
assert.deepEqual(ipc, Object.keys(ipcWitnesses).sort(comparePaths));
for (const [channel, witness] of Object.entries(ipcWitnesses))
  assert.ok(
    existsSync(path.join(root, 'editor/src/renderer/test', witness)),
    `Missing native IPC ${channel} witness ${witness}`,
  );

// No second Project engine may silently creep into the editor or installed CLI.
assert.equal(
  existsSync(path.join(root, 'editor/src/cli')),
  false,
  'Retired TypeScript CLI implementation must not be restored.',
);

const binary = process.argv[2] || process.env.NOVELTEA_NATIVE_CLI_BINARY;
if (binary) {
  const probe = spawnSync(path.resolve(binary), ['--help'], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr || probe.error?.message);
  assert.equal(
    probe.stdout.trim(),
    help.trim(),
    'Installed native help differs from C++ contract.',
  );
}
console.log(
  `Native C++ CLI inventory PASSED: ${paths.length} public paths, ${actions.length} native actions, ${ipc.length} editor IPC routes.`,
);
