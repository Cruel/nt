// #519: the checked public command inventory is deliberately independent of
// command-routing.ts. Derive the public surface from help, route branches and
// concrete command definitions, then fail when any surface lacks a test owner.
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = async (relative) => readFile(path.join(root, relative), 'utf8');
const { classifyNovelTeaCliCommand } = await import(
  pathToFileURL(path.join(root, 'src/cli/command-routing.ts')).href
);

// The owner is the native candidate entrypoint, or the independently retained
// tool entrypoint. The witness is an executable installed-CLI check, not a
// source-only assertion. A new command must be classified before this passes.
const coverage = {
  'project create': ['native-project-lifecycle-cli', 'certify-native-cli-project-routing.mjs'],
  'project export': ['native-project-lifecycle-cli', 'certify-native-cli-project-routing.mjs'],
  'project import': [
    'native-project-lifecycle-cli',
    'certify-native-project-command-differential.mjs',
  ],
  'agent sync': ['agent-sync-cli', 'certify-noveltea-cli.mjs'],
  'comfyui status': ['comfyui-catalog-commands', 'certify-noveltea-cli.mjs'],
  'comfyui workflows': ['comfyui-catalog-commands', 'certify-noveltea-cli.mjs'],
  'comfyui verify': ['comfyui-catalog-commands', 'certify-noveltea-cli.mjs'],
  'comfyui run': ['comfyui-catalog-commands', 'certify-noveltea-cli.mjs'],
  validate: ['native-project-validation-cli', 'certify-native-daemon-validation.mjs'],
  fmt: ['native-project-fmt-cli', 'certify-native-cli-project-routing.mjs'],
  'localization sync': [
    'native-project-localization-cli',
    'certify-native-cli-project-routing.mjs',
  ],
  'localization reconcile': ['native-project-reconcile-cli', 'certify-native-cli-mutations.mjs'],
  'localization view': ['native-project-localization-cli', 'certify-native-cli-commands.mjs'],
  'localization accept': ['native-project-localization-cli', 'certify-native-cli-mutations.mjs'],
  'localization review': ['native-project-localization-cli', 'certify-native-cli-mutations.mjs'],
  'asset audit': ['native-project-reads-cli', 'certify-native-cli-project-routing.mjs'],
  'asset import': ['native-project-mutations-cli', 'certify-native-cli-mutations.mjs'],
  'entity create': ['native-project-mutations-cli', 'certify-native-cli-mutations.mjs'],
  'entity inspect': ['native-project-reads-cli', 'certify-native-cli-commands.mjs'],
  'entity rename': ['native-project-mutations-cli', 'certify-native-cli-mutations.mjs'],
  'entity delete': ['native-project-mutations-cli', 'certify-native-cli-mutations.mjs'],
  usages: ['native-project-reads-cli', 'certify-native-cli-project-routing.mjs'],
  'shaders compile': ['native-project-shaders-cli', 'certify-native-cli-project-routing.mjs'],
  shaderc: ['native-tool', 'certify-noveltea-cli.mjs'],
  texturec: ['native-tool', 'certify-noveltea-cli.mjs'],
  'media-tool check': ['media-tool', 'certify-noveltea-cli.mjs'],
  'daemon status': ['daemon-control', 'certify-noveltea-cli.mjs'],
  'daemon stop': ['daemon-control', 'certify-noveltea-cli.mjs'],
  'test run': ['native-project-tests-cli', 'certify-native-cli-tests.mjs'],
  'test run-spec': ['native-project-tests-cli', 'certify-native-cli-tests.mjs'],
  'test run-ui-spec': ['native-project-tests-cli', 'certify-native-cli-tests.mjs'],
  'package export': ['native-project-package-cli', 'certify-native-cli-package.mjs'],
  'platform profiles': ['native-project-platform-cli', 'certify-noveltea-cli.mjs'],
  'platform export': ['native-project-platform-cli', 'certify-native-cli-platform.mjs'],
  'platform template list': ['platform-independent-commands', 'certify-noveltea-cli.mjs'],
  'platform template inspect': ['platform-independent-commands', 'certify-noveltea-cli.mjs'],
  'platform template install': ['platform-independent-commands', 'certify-noveltea-cli.mjs'],
  'platform template remove': ['platform-independent-commands', 'certify-noveltea-cli.mjs'],
  'platform config init': ['platform-independent-commands', 'certify-noveltea-cli.mjs'],
};

const help = await source('src/cli/static-contracts.ts');
const section = help.split('\nCommands:\n')[1]?.split('\nGlobal options:\n')[0];
assert.ok(section, 'Cannot derive CLI public surface from the static help contract.');
const publicPaths = new Set();
for (const line of section.split('\n')) {
  // Wrapped options (indented below the command) do not define a new path.
  if (!/^  [a-z]/.test(line)) continue;
  const words = line.trim().match(/^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*/)?.[0];
  assert.ok(words, `Unrecognized CLI help line: ${line}`);
  publicPaths.add(words);
}
assert.deepEqual(
  Object.keys(coverage).sort((a, b) => a.localeCompare(b)),
  [...publicPaths].sort((a, b) => a.localeCompare(b)),
  'Public help added/removed a command without assigning a certification owner.',
);

const routes = await source('src/cli/command-routing.ts');
const routeBranches = routes
  .split(/(?=^[ \t]*if \(family ===)/m)
  .filter((branch) => /^[ \t]*if \(family ===/.test(branch));
const discriminants = new Map();
for (const branch of routeBranches) {
  const families = [...branch.matchAll(/\bfamily === '([^']+)'/g)].map((match) => match[1]);
  assert.ok(families.length, `Cannot derive command-routing family: ${branch.slice(0, 90)}`);
  const operations = [...branch.matchAll(/\boperation\s*(?:===|!==)\s*'([^']+)'/g)].map(
    (match) => match[1],
  );
  for (const family of families) {
    assert.ok(!discriminants.has(family), `Duplicated routing branch: ${family}`);
    discriminants.set(family, new Set(operations));
  }
}
const routedPaths = new Set();
for (const [family, operations] of discriminants) {
  const candidates = [...publicPaths].filter((item) => item.split(' ')[0] === family);
  assert.ok(candidates.length, `New routing family '${family}' lacks a public inventory row.`);
  for (const operation of operations) {
    assert.ok(
      candidates.some((item) => item.split(' ')[1] === operation),
      `Routing operation '${family} ${operation}' has no public inventory row.`,
    );
  }
  for (const item of candidates) routedPaths.add(item);
}
assert.deepEqual(
  [...routedPaths].sort((a, b) => a.localeCompare(b)),
  [...publicPaths].sort((a, b) => a.localeCompare(b)),
  'Public command path has no matching command-routing family.',
);

// All concrete parser definitions must be reachable through a public route.
const definitions = await readdir(path.join(root, 'src/cli/commands'));
definitions.push('../platform-commands.ts');
const parsedDefinitions = new Set();
for (const filename of definitions.filter((name) => name.endsWith('.ts'))) {
  const body = await source(`src/cli/commands/${filename}`);
  for (const match of body.matchAll(/\bpath:\s*\[([^\]]+)\]/g)) {
    const pieces = match[1].split(',').map((part) => part.trim());
    if (pieces.some((part) => !/^'[^']+'$/.test(part))) continue; // parametric command factories
    parsedDefinitions.add(pieces.map((part) => part.slice(1, -1)).join(' '));
  }
}
for (const item of parsedDefinitions)
  assert.ok(publicPaths.has(item), `Command definition '${item}' is not in the public inventory.`);

// Several CLI paths are dispatched before the ordinary command-definition
// parser and the ScriptC island has its own scoped native host entrypoints.
// Neither may introduce an unclassified family merely because the help and
// routing table were not edited in the same change.
for (const filename of ['src/cli/application.ts', 'scripts/noveltea-scriptc-island.ts']) {
  const body = await source(filename);
  const specialFamilies = new Set([
    ...[...body.matchAll(/globals\.command\[0\] === '([^']+)'/g)].map((item) => item[1]),
    ...[...body.matchAll(/\bfamily === '([^']+)'/g)].map((item) => item[1]),
  ]);
  for (const family of specialFamilies)
    assert.ok(
      [...publicPaths].some((item) => item.split(' ')[0] === family),
      `${filename} added a private dispatch for unknown CLI family '${family}'.`,
    );
}

// Native C++ command actions and editor-to-native IPC routes are two more
// entrypoint inventories. Their owners are independent of the public CLI,
// and missing entries here must be a hard failure, not a silent skip.
const nativeActionOwners = {
  'project-create': 'native-project-lifecycle-cli',
  'project-import': 'native-project-lifecycle-cli',
  'project-export': 'native-project-lifecycle-cli',
  'project-diagnostic-locations': 'native-project-validation-cli',
  'project-validate': 'native-project-validation-cli',
  'source-generation-proof': 'native-project-validation-cli',
  'workspace-preflight': 'workspace-preflight',
  'platform-profiles-preparation': 'project-preparation',
  'asset-audit': 'native-project-reads-cli',
  'asset-import': 'native-project-mutations-cli',
  'comfyui-assets': 'native-comfyui-asset-publication',
  'comfyui-admission': 'comfyui-catalog-commands',
  'entity-inspect': 'native-project-reads-cli',
  'entity-usages': 'native-project-reads-cli',
  'entity-create': 'native-project-mutations-cli',
  'entity-rename': 'native-project-mutations-cli',
  'entity-delete': 'native-project-mutations-cli',
  'scoped-edit': ':native-only',
  'fmt-strip-defaults': ':native-only',
  fmt: 'native-project-fmt-cli',
  'localization-targets': 'native-project-localization-cli',
  'localization-view': 'native-project-reads-cli',
  'localization-sync': 'native-project-localization-cli',
  'localization-reconcile': 'native-project-reconcile-cli',
  'shader-preparation': 'native-project-shaders-cli',
  'runtime-package-preparation': 'native-project-package-cli',
  'platform-export-preparation': 'native-project-platform-cli',
  'export-preparation': 'native-project-platform-cli',
};
const nativeDispatcher = await source('../tools/editor_tool/tooling_native_project_commands.cpp');
const nativeActions = new Set(
  [...nativeDispatcher.matchAll(/\baction\s*==\s*"([a-z-]+)"/g)].map((match) => match[1]),
);
assert.deepEqual(
  [...nativeActions].sort(),
  Object.keys(nativeActionOwners).sort(),
  'Native Project C++ bridge introduced an unowned private command action.',
);
for (const [action, owner] of Object.entries(nativeActionOwners)) {
  const ownerFile =
    owner === ':native-only'
      ? '../tools/editor_tool/tooling_native_project_commands_certify.cpp'
      : owner === 'native-comfyui-asset-publication'
        ? `src/main/services/${owner}.ts`
        : `src/cli/${owner}.ts`;
  const ownerText = await source(ownerFile);
  const claimed =
    ownerText.includes(action) ||
    (owner === 'native-project-mutations-cli' &&
      action.startsWith('entity-') &&
      ownerText.includes('entity-${operation}'));
  assert.ok(
    claimed,
    `Private native action '${action}' is not claimed by its documented owner '${owner}'.`,
  );
}

const nativeIpcOwners = {
  NATIVE_PROJECT_PATCH: 'native-project-session-parity.test.ts',
  NATIVE_PROJECT_SAVE_UNIT: 'project-save-coordinator.test.ts',
  NATIVE_PROJECT_SAVE_TEXT: 'native-project-source-transactions.test.ts',
  NATIVE_PROJECT_STAGE_TEXT: 'native-project-source-transactions.test.ts',
  NATIVE_PROJECT_RECONCILE: 'native-authoring-reconciliation.test.ts',
  NATIVE_PROJECT_USE_DISK_UNIT: 'native-authoring-reconciliation.test.ts',
  NATIVE_PROJECT_VALIDATE: 'native-project-session-parity.test.ts',
  NATIVE_PROJECT_SEMANTIC_GRAPH: 'native-renderer-graph-runtime.test.ts',
  NATIVE_PROJECT_PREPARE_RUNTIME: 'native-authoring-worker.test.ts',
  NATIVE_PROJECT_RUN_TEST: 'native-authoring-worker.test.ts',
  NATIVE_PROJECT_RUN_SUITE: 'native-authoring-worker.test.ts',
  NATIVE_PROJECT_PREPARE_EXPORT: 'native-editor-export-service.test.ts',
  NATIVE_PROJECT_EXPORT_PACKAGE: 'native-editor-export-service.test.ts',
};
const ipc = await source('src/shared/ipc-channels.ts');
const nativeIpc = [...ipc.matchAll(/^\s+(NATIVE_PROJECT_[A-Z_]+):/gm)].map((item) => item[1]);
assert.deepEqual(
  nativeIpc.sort(),
  Object.keys(nativeIpcOwners).sort(),
  'Editor introduced an unowned native Project IPC surface.',
);
for (const [channel, witness] of Object.entries(nativeIpcOwners)) {
  assert.ok(
    (await stat(path.join(root, 'src/renderer/test', witness))).isFile(),
    `Native editor IPC '${channel}' lacks the expected regression test: ${witness}`,
  );
}

const retiredIpc = await source('src/main/services/native-editor-ipc-routing.ts');
const rejectedLegacyIpc = [...retiredIpc.matchAll(/IPC_CHANNELS\.([A-Z_]+)/g)].map(
  (item) => item[1],
);
assert.deepEqual(
  rejectedLegacyIpc.sort(),
  [
    'SAVE_PROJECT_CONTENT',
    'WRITE_PROJECT_SOURCE',
    'PURGE_PROJECT_TRASH',
    'VALIDATE_PROJECT',
    'PREPARE_EDITOR_RUNTIME',
    'RUN_PLAYBACK_TEST',
    'RUN_PLAYBACK_SUITE',
    'RUN_PLAYBACK_SPEC',
    'RUN_UI_PLAYBACK_SPEC',
  ].sort(),
  'Editor legacy-authoring rejection list changed; reconcile its #506 cutover boundary.',
);

// Exercise the actual lightweight routing contract, including options which
// affect write authority, stdin, transport, replay safety or native tool tier.
for (const item of publicPaths) {
  const route = classifyNovelTeaCliCommand(item.split(' '));
  assert.ok(route, `The classifier rejected public path '${item}'.`);
  assert.ok(coverage[item]?.every(Boolean), `Missing native owner or executable witness: ${item}`);
  const [, witness] = coverage[item];
  assert.ok(
    (await stat(path.join(root, 'scripts', witness))).isFile(),
    `Missing installed-CLI witness for '${item}': ${witness}`,
  );
}
for (const [command, option, expected] of [
  ['asset import asset.png', '--dry-run', 'read'],
  ['entity create rooms sample', '--dry-run', 'read'],
  ['entity rename rooms before after', '--dry-run', 'read'],
  ['entity delete rooms sample', '--dry-run', 'read'],
  ['localization sync', '--dry-run', 'read'],
  ['localization accept fr message', '--dry-run', 'read'],
  ['localization review fr message', '--dry-run', 'read'],
  ['localization reconcile', '--apply', 'transactional-write'],
  ['platform export', '--check', 'read'],
  ['fmt', '--check', 'read'],
]) {
  assert.equal(
    classifyNovelTeaCliCommand([...command.split(' '), option])?.projectAccess,
    expected,
    `${command} ${option} lost its Project access classification.`,
  );
}
for (const command of ['test run-spec', 'test run-ui-spec', 'localization reconcile --apply'])
  assert.equal(classifyNovelTeaCliCommand(command.split(' '))?.stdin, 'json', command);
for (const command of ['shaderc', 'texturec', 'media-tool check', 'daemon status', 'daemon stop'])
  assert.equal(
    classifyNovelTeaCliCommand(command.split(' '))?.quickJsRequiredAfterStaticMiss,
    false,
    `${command} must not initialize the authoring engine.`,
  );

console.log(
  `Native CLI routing inventory PASSED: ${publicPaths.size} public paths, ` +
    `${parsedDefinitions.size} concrete definitions, ${discriminants.size} routing families, ` +
    `${nativeActions.size} native bridge actions and ${nativeIpc.length} editor IPC entrypoints.`,
);
