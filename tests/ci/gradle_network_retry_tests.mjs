import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const runner = fileURLToPath(new URL('../../scripts/ci/retry-gradle-network.sh', import.meta.url));
const run = async (text, code, { attempts = '3' } = {}) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'noveltea-gradle-network-'));
  try {
    const count = path.join(dir, 'attempts');
    const program = path.join(dir, 'fake-gradle.sh');
    await writeFile(program, `#!/usr/bin/env bash
set -euo pipefail
count=0
if [[ -f "$1" ]]; then count="$(cat "$1")"; fi
count=$((count+1))
printf '%s' "$count" > "$1"
${text}
exit ${code}
`);
    const result = spawnSync('bash', [runner, 'bash', program, count], {
      cwd: dir,
      env: { ...process.env, NOVELTEA_GRADLE_NETWORK_ATTEMPTS: attempts,
        NOVELTEA_GRADLE_NETWORK_BACKOFF_SECONDS: '0', RUNNER_TEMP: dir },
      encoding: 'utf8',
    });
    return { result, attempts: existsSync(count) ? Number(await readFile(count, 'utf8')) : 0 };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('compilation errors are propagated immediately, without retry', async () => {
  const { result, attempts } = await run('echo "error: use of undeclared identifier" >&2', '17');
  assert.equal(result.status, 17);
  assert.equal(attempts, 1);
  assert.match(result.stderr, /non-throttling/);
});

test('HTTP 429 throttling is bounded and fails visibly at the retry ceiling', async () => {
  const { result, attempts } = await run(
    'echo "Received status code 429 from server: Too Many Requests" >&2', '19');
  assert.equal(result.status, 19);
  assert.equal(attempts, 3);
  assert.match(result.stderr, /persisted after 3 attempts/);
});

test('transient Maven 429 is allowed to recover without suppressing the original error class', async () => {
  const { result, attempts } = await run(
    'if [[ "$count" -lt 2 ]]; then echo "Received status code 429" >&2; exit 1; fi',
    '0');
  assert.equal(result.status, 0);
  assert.equal(attempts, 2);
  assert.match(result.stderr, /retrying after 0s/);
});

test('mass repository classpath disappearance retries with fresh dependency metadata', async () => {
  const missing = Array.from({ length: 6 }, (_, i) =>
    `echo '> Could not find org.example:dependency${i}:1.2.3.' >&2`).join('\n');
  const { result, attempts } = await run(`
if [[ "$count" -ge 2 && "\${2:-}" != '--refresh-dependencies' ]]; then
  echo 'Retry did not refresh Gradle dependency metadata' >&2
  exit 21
fi
if [[ "$count" -lt 2 ]]; then
  echo "Could not resolve all artifacts for configuration ':classpath'" >&2
  ${missing}
  echo 'https://repo.maven.apache.org/maven2/org/example/dependency0/1.2.3/pom' >&2
  echo 'https://dl.google.com/dl/android/maven2/org/example/dependency0/1.2.3/pom' >&2
  exit 1
fi`, '0');
  assert.equal(result.status, 0);
  assert.equal(attempts, 2);
  assert.match(result.stderr, /Transient Maven dependency resolution/);
});

test('one genuinely missing Maven coordinate does not trigger a retry', async () => {
  const { result, attempts } = await run(`
  echo "Could not resolve all artifacts for configuration ':classpath'" >&2
  echo '> Could not find com.invalid:removed:0.0.1.' >&2
  echo 'https://repo.maven.apache.org/maven2/com/invalid/removed/0.0.1/pom' >&2
  echo 'https://dl.google.com/dl/android/maven2/com/invalid/removed/0.0.1/pom' >&2
`, '17');
  assert.equal(result.status, 17);
  assert.equal(attempts, 1);
});

test('retry parameters are strictly bounded', async () => {
  const { result } = await run('echo ok', '0', { attempts: '20' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Invalid retry budget/);
});
