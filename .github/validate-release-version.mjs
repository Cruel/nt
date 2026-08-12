#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tag = process.argv[2] ?? '';
const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
if (!match) throw new Error(`Release tag '${tag}' must use vMAJOR.MINOR.PATCH[-prerelease].`);

const packageVersion = JSON.parse(
  readFileSync(path.join(root, 'editor', 'package.json'), 'utf8'),
).version;
const staticContracts = readFileSync(
  path.join(root, 'editor', 'src', 'cli', 'static-contracts.ts'),
  'utf8',
);
const cliVersion = /NOVELTEA_CLI_VERSION\s*=\s*'([^']+)'/.exec(staticContracts)?.[1];
const cmakeProject = readFileSync(path.join(root, 'CMakeLists.txt'), 'utf8');
const cmakeVersion = /project\(noveltea\s+VERSION\s+([^\s)]+)/.exec(cmakeProject)?.[1];
const vcpkgVersion = JSON.parse(readFileSync(path.join(root, 'vcpkg.json'), 'utf8'))[
  'version-string'
];
for (const [owner, version] of [
  ['editor/package.json', packageVersion],
  ['NOVELTEA_CLI_VERSION', cliVersion],
  ['CMake project', cmakeVersion],
  ['vcpkg.json', vcpkgVersion],
]) {
  if (version !== match[1]) {
    throw new Error(`${owner} version '${version ?? 'missing'}' does not match release ${tag}.`);
  }
}

process.stdout.write(`${tag} metadata is consistent.\n`);
