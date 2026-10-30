import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const executable = process.argv[2];
assert.ok(executable && path.isAbsolute(executable), 'Pass an absolute installed native CLI.');
const python = process.platform === 'win32' ? 'python' : 'python3';
const result = spawnSync(
  python,
  [path.join(root, 'tests/native_cli/production_regressions.py'), executable, root],
  { cwd: root, encoding: 'utf8', timeout: 420_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
);
assert.ifError(result.error);
process.stdout.write(result.stdout);
assert.equal(
  result.status,
  0,
  `Production regression contracts failed:\n${result.stderr}\n${result.stdout}`,
);
assert.equal(result.stderr, '', `Production regressions wrote stderr: ${result.stderr}`);
