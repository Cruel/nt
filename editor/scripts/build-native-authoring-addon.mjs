import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  editorRoot,
  repositoryRoot,
  runCommand,
  runPnpmCommand,
} from './editor-distribution-lib.mjs';

// Node-API is ABI-stable, but the Windows import library must come from the
// *Electron* headers, not the separately installed Node executable.
const require = createRequire(path.join(editorRoot, 'package.json'));
const version = require('electron/package.json').version;
const devdir = path.join(repositoryRoot, 'build', 'electron-authoring-headers');
const headers = path.join(devdir, version, 'include', 'node');
const buildRoot = path.join(repositoryRoot, 'build', 'native-authoring-host');
const addon = path.join(buildRoot, 'noveltea-authoring-node.node');
const addonOnly = process.argv.slice(2).includes('--addon-only');
const headersOnly = process.argv.slice(2).includes('--headers-only');
if (
  process.argv.slice(2).some((arg) => !['--addon-only', '--headers-only'].includes(arg)) ||
  (addonOnly && headersOnly)
) {
  throw new Error('Usage: node build-native-authoring-addon.mjs [--addon-only | --headers-only]');
}

await runPnpmCommand(
  [
    'exec',
    'node-gyp',
    'install',
    `--target=${version}`,
    '--dist-url=https://electronjs.org/headers',
    `--devdir=${devdir}`,
  ],
  { cwd: editorRoot, label: 'electron-authoring-headers' },
);
if (!existsSync(path.join(headers, 'node_api.h'))) {
  throw new Error(`Electron ${version} Node-API headers were not installed: ${headers}`);
}
if (headersOnly) process.exit(0);

const configure = [
  '-S',
  path.join(repositoryRoot, 'tools', 'project_authoring'),
  '-B',
  buildRoot,
  '-G',
  'Ninja',
  '-DCMAKE_BUILD_TYPE=Release',
  `-DBUILD_TESTING=${addonOnly ? 'OFF' : 'ON'}`,
  '-DNOVELTEA_BUILD_AUTHORING_NODE_ADDON=ON',
  `-DNOVELTEA_NODE_API_INCLUDE_DIR=${headers}`,
];
if (process.platform === 'darwin') {
  configure.push('-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0');
}
if (process.platform === 'win32') {
  const importLibrary = path.join(devdir, version, process.arch, 'node.lib');
  if (!existsSync(importLibrary)) {
    throw new Error(
      `Electron ${version} Windows Node-API import library is missing: ${importLibrary}`,
    );
  }
  configure.push(`-DNOVELTEA_NODE_API_IMPORT_LIBRARY=${importLibrary}`);
}
await runCommand('cmake', configure, { label: 'configure-native-authoring-host' });
await runCommand(
  'cmake',
  ['--build', buildRoot, ...(addonOnly ? ['--target', 'noveltea-authoring-node'] : [])],
  { label: 'build-native-authoring-host' },
);
if (!existsSync(addon)) throw new Error(`Native authoring addon not produced: ${addon}`);
console.log(`[native-authoring-addon] ${addon}`);
