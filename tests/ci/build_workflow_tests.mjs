import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/build.yml', import.meta.url), 'utf8');
const vcpkg = readFileSync(
  new URL('../../.github/actions/setup-linux-vcpkg/action.yml', import.meta.url),
  'utf8',
);

function job(name) {
  const match = workflow.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [\\w-]+:|$(?![\\s\\S]))`, 'm'));
  assert.ok(match, `Missing job ${name}`);
  return match[0];
}

function step(source, name) {
  const start = source.indexOf(`- name: ${name}\n`);
  assert.notEqual(start, -1, `Missing step ${name}`);
  const end = source.indexOf('- name: ', start + 1);
  return source.slice(start, end === -1 ? undefined : end);
}

function field(source, name) {
  const match = source.match(new RegExp(`^\\s+${name}: (.+)$`, 'm'));
  assert.ok(match, `Missing field ${name}`);
  return match[1];
}

test('CLI certification receives same-run shader headers without depending on caches', () => {
  const producer = job('linux-cli');
  const consumer = job('linux-cli-certify');
  const upload = step(producer, 'Upload CLI certification shader headers');
  const download = step(consumer, 'Download CLI certification shader headers');
  const cliUpload = step(producer, 'Upload NovelTea host CLI');
  const cliDownload = step(consumer, 'Download NovelTea host CLI');
  const artifact = 'noveltea-cli-certification-shader-headers';
  const includePath = 'build/linux-release/vcpkg_installed/x64-linux-noveltea/include/bgfx';
  assert.match(upload, /uses: actions\/upload-artifact@/);
  assert.match(download, /uses: actions\/download-artifact@/);
  assert.ok(upload.includes(`name: ${artifact}`));
  assert.ok(download.includes(`name: ${artifact}`));
  assert.equal(field(upload, 'path'), includePath);
  assert.equal(field(download, 'path'), includePath);
  assert.equal(field(upload, 'if-no-files-found'), 'error');
  assert.equal(field(cliUpload, 'path'), 'build/cli/linux');
  assert.equal(field(cliDownload, 'path'), 'build/cli/linux');
  assert.equal(field(consumer, 'needs'), 'linux-cli');
  assert.doesNotMatch(consumer, /setup-linux-vcpkg|actions\/cache|run-id:/);
  assert.ok(consumer.indexOf(download) < consumer.indexOf('- name: Certify NovelTea host CLI'));
});

test('vcpkg binary caches have independent configuration writers and refresh on new commits', () => {
  const sdk = step(vcpkg, 'Cache vcpkg SDK');
  const binaries = step(vcpkg, 'Cache vcpkg binaries');
  const installed = step(vcpkg, 'Cache vcpkg installed tree');
  assert.equal(field(sdk, 'path'), '.cache/vcpkg');
  assert.equal(field(binaries, 'path'), '.cache/vcpkg-binary');
  assert.ok(field(binaries, 'key').includes("${{ inputs['binary-scope'] }}"));
  assert.ok(field(binaries, 'key').endsWith('${{ github.sha }}'));
  assert.ok(
    binaries.includes(
      "restore-keys: |\n          ubuntu-24.04-x64-vcpkg-binary-${{ inputs['binary-scope'] }}-",
    ),
  );
  assert.match(binaries, /binary-fallback-scope/);
  assert.doesNotMatch(installed, /fallback|vcpkg-binary/);

  const expectedWriters = new Map([
    ['linux', 'linux-debug'],
    ['linux-cli', 'linux-release'],
    ['linux-cooperative', 'linux-no-threads'],
    ['linux-sanitize', 'linux-sanitize'],
  ]);
  const writers = new Set();
  for (const [jobName, scope] of expectedWriters) {
    const setup = step(job(jobName), 'Set up vcpkg');
    assert.equal(field(setup, 'binary-scope'), scope);
    assert.ok(!writers.has(scope), `vcpkg binary writer '${scope}' is shared by parallel jobs`);
    writers.add(scope);
  }
  assert.equal(field(step(job('linux-cooperative'), 'Set up vcpkg'), 'scope'), 'linux-debug');
  assert.equal(
    field(step(job('linux-cooperative'), 'Set up vcpkg'), 'binary-fallback-scope'),
    'linux-debug',
  );
});

test('artifact consumers do not wait for unrelated test and cooperative build jobs', () => {
  assert.equal(field(job('editor'), 'needs'), '[linux-cli, web-preview]');
  assert.equal(field(job('android'), 'needs'), '[shader-assets, linux-cli]');
  assert.equal(field(job('linux-cooperative'), 'needs'), 'shader-assets');
  assert.equal(field(job('android-cooperative'), 'needs'), 'shader-assets');
});

test('CI keeps shared-display CTest runs serial until their isolation is established', () => {
  assert.doesNotMatch(workflow, /CTEST_PARALLEL_LEVEL:/);
  for (const name of ['linux', 'linux-sanitize']) {
    const commands = job(name).split('\n').filter((line) => line.includes('ctest --test-dir'));
    assert.equal(commands.length, 1);
    assert.doesNotMatch(commands[0], /--parallel|\s-j/);
  }
});

test('CI leaves compile concurrency automatic while serializing heavyweight Linux links', () => {
  assert.doesNotMatch(workflow, /CMAKE_BUILD_PARALLEL_LEVEL:/);
  assert.doesNotMatch(workflow, /VCPKG_MAX_CONCURRENCY:/);

  const configure = step(job('linux'), 'Configure');
  assert.match(configure, /-DCMAKE_JOB_POOLS=link_pool=1/);
  assert.match(configure, /-DCMAKE_JOB_POOL_LINK=link_pool/);
  assert.doesNotMatch(step(job('linux'), 'Build'), /--parallel|\s-j\d*/);
});

test('examples pin and standalone compiler checks tolerate canonical file formatting', () => {
  const pin = step(job('examples'), 'Resolve pinned examples revision');
  assert.match(pin, /\.trim\(\)/);
  assert.match(pin, /\^\[0-9a-f\]\{40\}\$/);
  assert.doesNotMatch(pin, /\\\\n\?\$/);

  const compiler = step(job('editor'), 'Verify standalone project compiler');
  assert.match(compiler, /assert\.deepStrictEqual/);
  assert.doesNotMatch(compiler, /const expected=JSON\.stringify/);
});
