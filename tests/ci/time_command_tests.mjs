import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnOptions } from '../../scripts/ci/time-command.mjs';

test('Windows pnpm/npm/yarn shims use cmd.exe shell resolution, not direct spawn', () => {
  for (const command of ['pnpm', 'npm', 'yarn']) {
    assert.deepEqual(spawnOptions(command, ['-C', 'editor', 'run', 'noveltea:build'], 'win32'),
      { stdio: 'inherit', shell: true });
  }
});

test('native tools and every non-Windows command retain direct spawn safety', () => {
  assert.deepEqual(spawnOptions('cmake', ['--build', '--preset', 'windows-release'], 'win32'),
    { stdio: 'inherit', shell: false });
  assert.deepEqual(spawnOptions('pnpm', ['-C', 'editor', 'run', 'noveltea:build'], 'linux'),
    { stdio: 'inherit', shell: false });
  assert.deepEqual(spawnOptions('cmake', ['--build', '--preset', 'linux-release'], 'linux'),
    { stdio: 'inherit', shell: false });
});

test('Windows package-manager shim arguments cannot inject shell metacharacters', () => {
  for (const value of ['editor & echo injected', 'a|b', 'x>foo', 'x%TEMP%', 'x\ny', 'x^y']) {
    assert.throws(() => spawnOptions('pnpm', [value], 'win32'), /metacharacters/);
  }
});
