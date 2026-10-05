import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function createDisposableGate(runtimeRoot, name, environment) {
  const directory = path.join(runtimeRoot, 'certification-gates');
  await mkdir(directory, { recursive: true });
  const gatePath = path.join(directory, name);
  await writeFile(gatePath, 'hold\n');
  return {
    environment: {
      ...environment,
      NOVELTEA_CLI_CERTIFICATION_DISPOSABLE_GATE_PATH: gatePath,
    },
    async release() {
      await rm(gatePath, { force: true });
    },
  };
}

export async function waitForDisposableAdmission(
  label,
  status,
  invocation,
  { standby = false, timeoutMs = 60000, pollMs = 25 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  const transitions = [];
  let latest = null;
  while (Date.now() < deadline) {
    latest = status();
    if (latest.disposableBusyWorkers >= 1 && (!standby || latest.disposableStandbyWorkers >= 1))
      return latest;
    const state = JSON.stringify(latest);
    if (transitions.at(-1) !== state) {
      transitions.push(state);
      if (transitions.length > 8) transitions.shift();
    }
    const command = invocation.snapshot();
    if (command.status !== null || command.signal !== null)
      throw new Error(
        `${label}: command exited before disposable admission.\n` +
          `command: ${JSON.stringify(command)}\ndaemon transitions: ${transitions.join('\n')}`,
      );
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(
    `${label} timed out waiting for disposable admission.\n` +
      `command: ${JSON.stringify(invocation.snapshot())}\n` +
      `daemon transitions: ${transitions.join('\n')}`,
  );
}
