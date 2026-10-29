import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { waitForDaemonState } from '../../editor/scripts/cli-certification-synchronization.mjs';

const candidate = readFileSync(
  new URL('../../editor/scripts/certify-native-candidate-contracts.mjs', import.meta.url),
  'utf8',
);
const build = readFileSync(
  new URL('../../editor/scripts/build-noveltea-cli.mjs', import.meta.url),
  'utf8',
);
const release = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');

test('daemon state wait resolves only after the requested postcondition', async () => {
  const states = [
    { disposableBusyWorkers: 1, disposableStandbyWorkers: 0 },
    { disposableBusyWorkers: 0, disposableStandbyWorkers: 0 },
    { disposableBusyWorkers: 0, disposableStandbyWorkers: 1 },
  ];
  let polls = 0;
  const result = await waitForDaemonState(
    'standby replenishment',
    () => states[polls++],
    (status) => status.disposableBusyWorkers === 0 && status.disposableStandbyWorkers >= 1,
    { pollMs: 1 },
  );
  assert.deepEqual(result, states[2]);
  assert.equal(polls, 3);
});

test('native production qualification retains every independent behavior witness', () => {
  for (const script of [
    'certify-native-cli-public-contracts.mjs',
    'certify-native-production-lifecycle.mjs',
    'certify-native-cli-owner-lifecycle.mjs',
    'certify-native-cli-package.mjs',
    'certify-native-cli-platform.mjs',
    'certify-native-cli-comfyui-contracts.mjs',
    'certify-native-cli-comfyui-race.mjs',
    'certify-native-cli-production-regressions.mjs',
    'certify-native-authoring-cross-system.mjs',
  ]) {
    assert.ok(candidate.includes(script), `Production qualification omitted ${script}`);
  }
  assert.doesNotMatch(candidate, /certify-noveltea-cli\.mjs|dist-scriptc-island/);
});

test('release builder only links and installs native CLI, without a ScriptC compilation lane', () => {
  assert.match(build, /--target', 'noveltea-native-cli'/);
  assert.match(build, /native-cli-production-build\.v2/);
  assert.match(build, /smoke-project/);
  assert.doesNotMatch(build, /scriptcEntrypoint|SCRIPTC_CC|SCRIPTC_TARGET|JS_RunGC/);
});

test('release host certification requires native editor/CLI integration and only builders opt into CLI-only', () => {
  const cliOnly = /pnpm -C editor run noveltea:certify -- --cli-only/g;
  assert.equal(
    [...release.matchAll(cliOnly)].length,
    2,
    'Only the standalone Linux/Windows CLI builders may select the reduced certification subset.',
  );
  const hostGate = release.match(
    /- name: Certify full native production lifecycle and editor\/CLI authority\n([\s\S]*?)(?=\n\s+- name:)/,
  );
  assert.ok(hostGate, 'The three-host editor matrix must execute full production qualification.');
  assert.match(hostGate[1], /NOVELTEA_AUTHORING_NODE_ADDON:/);
  assert.match(hostGate[1], /pnpm -C editor run noveltea:certify -- /);
  assert.doesNotMatch(hostGate[1], /--cli-only|--candidate|NOVELTEA_CLI_CERTIFICATION/);
});

test('daemon state timeout reports observed transitions', async () => {
  let polls = 0;
  await assert.rejects(
    waitForDaemonState(
      'worker retirement',
      () => ({ disposableWorkers: polls++ === 0 ? 2 : 1 }),
      (status) => status.disposableWorkers === 0,
      { timeoutMs: 25, pollMs: 1 },
    ),
    (error) => {
      assert.match(error.message, /timed out waiting for daemon state/);
      assert.match(error.message, /"disposableWorkers":2/);
      assert.match(error.message, /"disposableWorkers":1/);
      return true;
    },
  );
});
