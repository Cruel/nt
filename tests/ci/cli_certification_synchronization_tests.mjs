import assert from "node:assert/strict";
import { test } from "node:test";

import { waitForDaemonState } from "../../editor/scripts/cli-certification-synchronization.mjs";

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
    (status) =>
      status.disposableBusyWorkers === 0 && status.disposableStandbyWorkers >= 1,
    { pollMs: 1 },
  );
  assert.deepEqual(result, states[2]);
  assert.equal(polls, 3);
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
