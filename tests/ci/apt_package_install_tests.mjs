import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const installer = fileURLToPath(new URL('../../scripts/ci/install-apt-packages.sh', import.meta.url));
const linux = { skip: process.platform !== 'linux' };

function run(packages, scenario, { hosted = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'noveltea-apt-test-'));
  const log = path.join(dir, 'log');
  try {
    writeFileSync(log, '');
    const fake = (name, content) => writeFileSync(path.join(dir, name),
      '#!/bin/bash\nset -eu\n' + content + '\n', { mode: 0o755 });
    fake('id', 'echo 0');
    fake('dpkg', 'echo amd64');
    fake('sleep', 'exit 0');
    fake('dpkg-query', 'if [[ "$SCENARIO" == installed || "${@: -1}" == present ]]; then echo installed; else exit 1; fi');
    fake('timeout', [
      'printf "deadline %s %s\\n" "$1" "$2" >> "$APT_LOG"',
      'shift 2',
      'exec "$@"',
    ].join('\n'));
    fake('apt-get', [
      'printf "apt %s\\n" "$*" >> "$APT_LOG"',
      'mirror=default',
      'for arg in "$@"; do',
      '  if [[ "$arg" == Dir::Etc::sourcelist=* ]]; then',
      '    mirror="$(sed -n "s/^URIs: //p" "${arg#*=}")"',
      '    grep -q "^Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg$" "${arg#*=}"',
      '    grep -q "^Suites: noble noble-updates noble-backports noble-security$" "${arg#*=}"',
      '  fi',
      'done',
      'printf "mirror %s\\n" "$mirror" >> "$APT_LOG"',
      'case " $* " in',
      '  *" update "*)',
      '    if [[ "$SCENARIO" == index-fail ]]; then exit 124; fi',
      '    if [[ "$SCENARIO" == index-retry ]] && [[ $(grep -c " update$" "$APT_LOG") == 1 ]]; then exit 124; fi ;;',
      '  *" --download-only "*)',
      '    if [[ "$SCENARIO" == mirror-stall && "$mirror" != https://mirrors.mit.edu/ubuntu ]]; then exit 124; fi',
      '    if [[ "$SCENARIO" == download-fail ]]; then exit 124; fi',
      '    if [[ "$SCENARIO" == download-retry ]] && [[ $(grep -c " --download-only " "$APT_LOG") == 1 ]]; then exit 124; fi ;;',
      '  *" --no-download "*) if [[ "$SCENARIO" == install-fail ]]; then exit 42; fi ;;',
      '  *) exit 99 ;;',
      'esac',
    ].join('\n'));
    const result = spawnSync('bash', [installer, ...packages], {
      env: { ...process.env, PATH: dir + ':' + process.env.PATH, APT_LOG: log, SCENARIO: scenario,
        GITHUB_ACTIONS: hosted ? 'true' : 'false', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64' },
      encoding: 'utf8', timeout: 5000,
    });
    return { result, log: readFileSync(log, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('preinstalled host prerequisites do not access apt or the network', linux, () => {
  const { result, log } = run(['cmake', 'curl', 'tar'], 'installed');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(log, '');
  assert.match(result.stdout, /already installed/);
});

test('only missing packages are downloaded and installed with network and wall deadlines', linux, () => {
  const { result, log } = run(['present', 'missing'], 'success');
  assert.equal(result.status, 0, result.stderr);
  assert.match(log, /Acquire::http::Timeout=15/);
  assert.match(log, /Acquire::https::Timeout=15/);
  assert.match(log, /APT::Update::Error-Mode=any update/);
  assert.match(log, /deadline --kill-after=10s 120s/);
  assert.match(log, /deadline --kill-after=10s 360s/);
  assert.match(log, /deadline --kill-after=10s 180s/);
  assert.match(log, /install -y --download-only missing/);
  assert.match(log, /install -y --no-download missing/);
  assert.doesNotMatch(log, /present/);
});

test('stalled index refresh retries once and then stops before installing', linux, () => {
  const { result, log } = run(['missing'], 'index-fail');
  assert.equal(result.status, 124);
  assert.equal((log.match(/ update\n/g) || []).length, 2);
  assert.doesNotMatch(log, /install -y/);
  assert.match(result.stderr, /two bounded attempts/);
});

test('transient index and download failures recover without restarting installation', linux, () => {
  for (const scenario of ['index-retry', 'download-retry']) {
    const { result, log } = run(['missing'], scenario);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((log.match(/ update\n/g) || []).length, 2);
    assert.equal((log.match(/ --download-only /g) || []).length, scenario === 'download-retry' ? 2 : 1);
    assert.equal((log.match(/ --no-download /g) || []).length, 1);
  }
});

test('persistent download failure never invokes dpkg; installation failure is not retried', linux, () => {
  const stalled = run(['missing'], 'download-fail');
  assert.equal(stalled.result.status, 124);
  assert.equal((stalled.log.match(/ --download-only /g) || []).length, 2);
  assert.doesNotMatch(stalled.log, / --no-download /);
  const failed = run(['missing'], 'install-fail');
  assert.equal(failed.result.status, 42);
  assert.equal((failed.log.match(/ --no-download /g) || []).length, 1);
});

test('hosted Noble package download stall switches to an independent signed mirror', {
  skip: process.platform !== 'linux' ||
    !readFileSync('/etc/os-release', 'utf8').includes('VERSION_CODENAME=noble'),
}, () => {
  const { result, log } = run(['missing'], 'mirror-stall', { hosted: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(log, /mirror https:\/\/archive\.ubuntu\.com\/ubuntu/);
  assert.match(log, /mirror https:\/\/mirrors\.mit\.edu\/ubuntu/);
  assert.equal((log.match(/ update\n/g) || []).length, 2);
  assert.equal((log.match(/ --download-only /g) || []).length, 2);
  assert.equal((log.match(/ --no-download /g) || []).length, 1);
  assert.match(log.trim(), /mirror https:\/\/mirrors\.mit\.edu\/ubuntu$/);
});

test('invalid package options cannot be injected', linux, () => {
  const { result, log } = run(['--no-download'], 'success');
  assert.equal(result.status, 2);
  assert.equal(log, '');
});
