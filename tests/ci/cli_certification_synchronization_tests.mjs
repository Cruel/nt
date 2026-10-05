import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createDisposableGate,
  waitForDisposableAdmission,
} from "../../editor/scripts/cli-certification-synchronization.mjs";

const idle = {
  disposableBusyWorkers: 0,
  disposableStandbyWorkers: 1,
  disposableQueuedJobs: 0,
};
const running = { ...idle, disposableBusyWorkers: 1 };
const invocation = (snapshot) => ({ snapshot: () => snapshot });
const pending = { status: null, signal: null, stdout: "", stderr: "" };

test("disposable admission waits for a busy worker and the required standby", async () => {
  const states = [idle, { ...running, disposableStandbyWorkers: 0 }, running];
  let polls = 0;
  const admitted = await waitForDisposableAdmission(
    "warm standby",
    () => states[polls++],
    invocation(pending),
    { standby: true, pollMs: 1 },
  );
  assert.deepEqual(admitted, running);
  assert.equal(polls, 3);
});

test("early command failure reports the exit code, output, and daemon state", async () => {
  await assert.rejects(
    waitForDisposableAdmission(
      "output admission",
      () => idle,
      invocation({ status: 4, signal: null, stdout: "invalid project", stderr: "worker failed" }),
    ),
    (error) => {
      assert.match(error.message, /command exited before disposable admission/);
      assert.match(error.message, /"status":4/);
      assert.match(error.message, /invalid project/);
      assert.match(error.message, /worker failed/);
      assert.match(error.message, /"disposableBusyWorkers":0/);
      return true;
    },
  );
});

test("admission timeout preserves pending command output and status transitions", async () => {
  let polls = 0;
  await assert.rejects(
    waitForDisposableAdmission(
      "slow preparation",
      () => ({ ...idle, disposableQueuedJobs: polls++ === 0 ? 0 : 1 }),
      invocation({ ...pending, stderr: "preparing snapshot" }),
      { timeoutMs: 50, pollMs: 1 },
    ),
    (error) => {
      assert.match(error.message, /timed out waiting for disposable admission/);
      assert.match(error.message, /preparing snapshot/);
      assert.match(error.message, /"disposableQueuedJobs":0/);
      assert.match(error.message, /"disposableQueuedJobs":1/);
      return true;
    },
  );
});

test("a disposable gate survives a delayed observer and releases explicitly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nt-certification-gate-test-"));
  let child;
  try {
    const gate = await createDisposableGate(root, "generation", {
      ...process.env,
      NOVELTEA_CLI_CERTIFICATION: "1",
    });
    const gatePath = gate.environment.NOVELTEA_CLI_CERTIFICATION_DISPOSABLE_GATE_PATH;
    child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { existsSync } from 'node:fs';
         process.stdout.write('ready');
         while (existsSync(process.env.NOVELTEA_CLI_CERTIFICATION_DISPOSABLE_GATE_PATH))
           await new Promise(resolve => setTimeout(resolve, 5));`,
      ],
      { env: gate.environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    const completion = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    await new Promise((resolve) => child.stdout.once("data", resolve));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(child.exitCode, null);
    assert.equal(await readFile(gatePath, "utf8"), "hold\n");
    await gate.release();
    assert.equal(await completion, 0);
    await gate.release();
  } finally {
    child?.kill();
    await rm(root, { recursive: true, force: true });
  }
});
