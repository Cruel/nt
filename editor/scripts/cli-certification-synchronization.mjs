export async function waitForDaemonState(
  label,
  status,
  predicate,
  { timeoutMs = 15000, pollMs = 25 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  const transitions = [];
  let latest = null;
  while (Date.now() < deadline) {
    latest = status();
    if (predicate(latest)) return latest;
    const state = JSON.stringify(latest);
    if (transitions.at(-1) !== state) {
      transitions.push(state);
      if (transitions.length > 8) transitions.shift();
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(
    `${label} timed out waiting for daemon state.\n` +
      `daemon transitions: ${transitions.join('\n')}\n` +
      `last daemon status: ${JSON.stringify(latest)}`,
  );
}
