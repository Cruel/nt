import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { waitForDaemonState } from "../../editor/scripts/cli-certification-synchronization.mjs";

const certificationSource = readFileSync(
  new URL("../../editor/scripts/certify-noveltea-cli.mjs", import.meta.url),
  "utf8",
);

test("daemon state wait resolves only after the requested postcondition", async () => {
  const states = [
    { disposableBusyWorkers: 1, disposableStandbyWorkers: 0 },
    { disposableBusyWorkers: 0, disposableStandbyWorkers: 0 },
    { disposableBusyWorkers: 0, disposableStandbyWorkers: 1 },
  ];
  let polls = 0;
  const result = await waitForDaemonState(
    "standby replenishment",
    () => states[polls++],
    (status) => status.disposableBusyWorkers === 0 && status.disposableStandbyWorkers >= 1,
    { pollMs: 1 },
  );
  assert.deepEqual(result, states[2]);
  assert.equal(polls, 3);
});

test("resident daemon certification does not hide scheduler lifecycle suites", () => {
  const residentStart = certificationSource.indexOf("async function certifyResidentDaemon");
  const residentEnd = certificationSource.indexOf("async function certifyPerformanceEnvelope");
  assert.notEqual(residentStart, -1);
  assert.notEqual(residentEnd, -1);
  const residentBody = certificationSource.slice(residentStart, residentEnd);
  for (const nested of [
    "certifyProjectOwnerScheduling(",
    "certifyDisposableTestScheduling(",
    "certifyDisposableOutputScheduling(",
    "certifyDaemonBuildProtocolIsolation(",
    "certifyStandaloneAuthorityAndMutationHandling(",
    "certifyComfyUiDisposableOwnerIsolation(",
  ]) {
    assert.doesNotMatch(residentBody, new RegExp(nested.replace("(", "\\(")));
  }
  for (const section of [
    "project-owner-scheduling",
    "disposable-tests",
    "disposable-output",
    "build-protocol-isolation",
    "authority-mutation",
    "comfyui-owner-isolation",
    "resident-daemon",
  ]) {
    assert.match(certificationSource, new RegExp(`runTimedSection\\('${section}'`));
  }
});

test("disposable CLI certification avoids real-process scheduler races", () => {
  const start = certificationSource.indexOf("async function certifyDisposableTestScheduling");
  const end = certificationSource.indexOf("async function certifyDisposableOutputScheduling");
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const body = certificationSource.slice(start, end);
  assert.doesNotMatch(body, /disposable-test-concurrent/);
  assert.doesNotMatch(body, /runAsync\(/);
  assert.doesNotMatch(body, /disposableWorkers === 1/);
  assert.doesNotMatch(body, /queuedRuns/);
  assert.match(body, /schedulerConcurrencyCertifiedNatively: true/);
});

test("daemon state timeout reports observed transitions", async () => {
  let polls = 0;
  await assert.rejects(
    waitForDaemonState(
      "worker retirement",
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
