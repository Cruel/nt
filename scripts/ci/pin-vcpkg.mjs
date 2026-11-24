#!/usr/bin/env node
// Source-owned immutable vcpkg bootstrap for Linux, macOS and Windows CI.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function pinnedVcpkgRevision(repository) {
  const config = JSON.parse(await readFile(path.join(repository, 'vcpkg-configuration.json'), 'utf8'));
  const revision = config['default-registry']?.baseline;
  if (config['default-registry']?.kind !== 'builtin' || !/^[a-f0-9]{40}$/.test(revision ?? '')) {
    throw new Error('vcpkg requires an immutable 40-character built-in registry revision pin.');
  }
  return revision;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

async function main() {
  const sha = await pinnedVcpkgRevision(root);
  if (process.argv[2] === 'print') {
    process.stdout.write(`${sha}\n`);
    return;
  }
  if (process.argv.length > 2) throw new Error('Usage: pin-vcpkg.mjs [print]');
  const destination = process.env.VCPKG_ROOT;
  if (!destination || !path.isAbsolute(destination)) throw new Error('Set an absolute VCPKG_ROOT.');
  try {
    git('-C', destination, 'rev-parse', '--is-inside-work-tree');
  } catch {
    git('clone', 'https://github.com/microsoft/vcpkg.git', destination);
  }
  // A cache may contain a newer vcpkg Git checkout; it must not silently change
  // the bootstrap/port-resolution toolchain without changing the declared pin.
  git('-C', destination, 'checkout', '--detach', sha);
  const actual = git('-C', destination, 'rev-parse', 'HEAD');
  if (actual !== sha) throw new Error(`vcpkg SDK pin mismatch: ${actual} != ${sha}`);
  process.stdout.write(`vcpkg source pin verified: ${sha}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`vcpkg bootstrap rejected: ${error.message}\n`);
    process.exitCode = 1;
  });
}
