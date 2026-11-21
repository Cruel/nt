import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { makeReceipt, qualifyResults, verifyReceipt, verifyTrustedQualificationRun } from '../../scripts/ci/extended-qualification.mjs';

const require = createRequire(new URL('../../editor/package.json', import.meta.url));
const YAML = require('yaml');
const contract = JSON.parse(readFileSync(
  new URL('../../scripts/ci/extended-qualification-contract.json', import.meta.url), 'utf8',
));
const build = YAML.parse(readFileSync(new URL('../../.github/workflows/build.yml', import.meta.url), 'utf8'));
const coverage = YAML.parse(readFileSync(new URL('../../.github/workflows/coverage.yml', import.meta.url), 'utf8'));
const extended = YAML.parse(readFileSync(new URL('../../.github/workflows/extended-qualification.yml', import.meta.url), 'utf8'));

const sha = 'a'.repeat(40);
const selected = 'b'.repeat(40);
const context = {
  sourceSha: sha, workflowSha: selected, repository: 'Cruel/nt',
  workflow: 'Extended Qualification', event: 'workflow_dispatch',
  ref: 'refs/heads/master', runId: 108, attempt: 2, buildRunId: 42,
};
const required = contract.jobs.filter((name) => name !== 'source');
const results = () => Object.fromEntries(required.map((name) => [name, { result: 'success' }]));

test('coverage starts on each PR and master push independently of Build', () => {
  assert.deepEqual(coverage.on.pull_request.branches, ['master', 'main']);
  assert.ok(coverage.on.push.branches.includes('master'));
  assert.ok(build.on.pull_request.branches.includes('master'));
  assert.ok(build.on.push.branches.includes('master'));
  assert.equal(coverage.name, 'Coverage');
  assert.notEqual(coverage.concurrency.group, build.concurrency.group);
  assert.equal(build.jobs.linux.steps.find((step) => step.name === 'Configure')
    .run.includes('-DNOVELTEA_ENABLE_COVERAGE=OFF'), true);
  assert.equal(build.jobs.editor.steps.find((step) => step.name === 'Test').run,
    'pnpm -C editor run test');
  assert.equal(coverage.jobs.native.steps.find((step) => step.name === 'Configure')
    .run.includes('-DNOVELTEA_ENABLE_COVERAGE=ON'), true);
  assert.ok(coverage.jobs.editor.steps.find((step) => step.name === 'Test and instrument editor')
    .run.includes('test:coverage'));
  for (const job of Object.values(coverage.jobs)) {
    assert.ok(!job.needs || Object.keys(coverage.jobs).includes(job.needs),
      'Coverage cannot depend on Build artifacts or statuses');
  }
  assert.ok(!Object.keys(build.jobs).some((name) =>
    ['linux-sanitize', 'web-benchmark', 'android-emulator'].includes(name)));
  assert.equal(coverage.jobs.native.permissions['id-token'], 'write');
  assert.equal(coverage.jobs.editor.permissions['id-token'], 'write');
  for (const jobName of ['native', 'editor']) {
    const job = coverage.jobs[jobName];
    const codecov = job.steps.find((step) => String(step.uses).startsWith('codecov/codecov-action@'));
    const upload = job.steps.find((step) => step.name?.startsWith('Upload') && step.uses === 'actions/upload-artifact@v7');
    assert.ok(codecov.if.includes("github.event.pull_request.head.repo.full_name == github.repository"));
    assert.equal(codecov.with.use_oidc, true);
    assert.equal(codecov.with.fail_ci_if_error, false);
    assert.equal(upload.with['if-no-files-found'], 'error');
    assert.ok(!upload.if?.includes('github.event.pull_request.head.repo.full_name'),
      'Fork PR report artifact must remain available');
  }
});

test('instrumented coverage and Extended restore dependency caches without creating new long-lived scopes', () => {
  const vcpkg = YAML.parse(readFileSync(
    new URL('../../.github/actions/setup-linux-vcpkg/action.yml', import.meta.url), 'utf8'));
  for (const [name, action] of [
    ['native', coverage.jobs.native],
    ['linux-cooperative', extended.jobs['linux-cooperative']],
    ['linux-sanitize', extended.jobs['linux-sanitize']],
  ]) {
    const setup = action.steps.find((step) => step.uses === './.github/actions/setup-linux-vcpkg');
    assert.equal(setup?.with?.['read-only'], 'true', name);
  }
  const cacheSteps = vcpkg.runs.steps.filter((step) => step.uses?.startsWith('actions/cache'));
  assert.equal(cacheSteps.length, 6);
  for (const step of cacheSteps) {
    assert.equal(step.if,
      step.uses === 'actions/cache/restore@v5'
        ? "inputs['read-only'] == 'true'" : "inputs['read-only'] != 'true'");
  }
  assert.equal(coverage.env.CCACHE_MAXSIZE, '128M');
  for (const job of Object.values(extended.jobs)) {
    for (const step of job.steps) {
      assert.ok(!step.uses?.includes('actions/cache/save'), 'Extended cache writing is forbidden');
      assert.notEqual(step.uses, './.github/actions/save-ccache');
      assert.notEqual(step.uses, 'actions/cache@v5');
    }
  }
  const editor = coverage.jobs.editor;
  assert.ok(editor.env.NOVELTEA_AUTHORING_NODE_ADDON.includes('noveltea-authoring-node.node'));
  assert.ok(editor.env.NOVELTEA_FFMPEG.includes('ffmpeg'));
  assert.ok(editor.steps.some((step) => step.run?.includes('private-media-tools.mjs')));
  assert.equal(editor.needs, 'native', 'Editor coverage must consume the real compiled CLI from native Coverage');
  const nativeCli = coverage.jobs.native.steps.find((step) => step.name?.startsWith('Export exact instrumented native CLI'));
  assert.equal(nativeCli.with.name, 'noveltea-coverage-native-cli');
  assert.equal(nativeCli.with.path, 'build/linux-debug/tools/editor_tool/native-cli');
  const restoredCli = editor.steps.find((step) => step.name?.startsWith('Download instrumented native CLI'));
  assert.equal(restoredCli.with.name, nativeCli.with.name);
  assert.equal(restoredCli.with.path, 'build/cli/linux');
  assert.ok(editor.steps.find((step) => step.name?.startsWith('Restore executable mode'))?.run.includes('build/cli/linux/noveltea'));
});

test('repeated Windows native worker stress uses PowerShell and fails on any iteration', () => {
  const worker = extended.jobs['windows-worker-stress'];
  assert.equal(worker['runs-on'], 'windows-2025');
  const repeat = worker.steps.find((step) => step.name === 'Repeat native worker lifetime tests');
  assert.ok(repeat, 'The complete native worker stress requirement must remain enabled');
  assert.equal(repeat.shell, 'pwsh');
  assert.match(repeat.run, /foreach\s*\(\$attempt in 1\.\.3\)/u);
  assert.match(repeat.run, /pnpm -C editor exec vp test run src\/renderer\/test\/native-authoring-worker\.test\.ts/u);
  assert.match(repeat.run, /if\s*\(\$LASTEXITCODE -ne 0\)\s*\{\s*exit \$LASTEXITCODE\s*\}/u);
  assert.doesNotMatch(repeat.run, /for\s+attempt\s+in\s+.*;\s*do/u);
});

test('the Extended job inventory remains complete with a narrowly scoped premerge push trigger', () => {
  assert.equal(extended.name, 'Extended Qualification');
  assert.equal(extended.on.schedule.length, 1);
  assert.ok(extended.on.schedule[0].cron);
  assert.ok(extended.on.workflow_dispatch.inputs.sha);
  assert.ok(!extended.on.pull_request);
  assert.deepEqual(extended.on.push.branches, ['ci/build-release-refactor-641']);
  assert.deepEqual(extended.on.push.paths, ['docs/build/ATOMIC_CUTOVER_ACCEPTANCE.md']);
  assert.deepEqual(new Set(Object.keys(extended.jobs)), new Set([...contract.jobs, 'qualification']));
  const seal = extended.jobs.qualification;
  assert.equal(seal.if, "${{ always() && needs.source.result == 'success' }}");
  assert.deepEqual(new Set(seal.needs), new Set(contract.jobs));
  const receipt = seal.steps.find((step) =>
    step.run?.includes('extended-qualification.mjs receipt'));
  assert.ok(receipt);
  assert.ok(receipt.env.NEEDS_JSON.includes('toJSON(needs)'));
  const upload = seal.steps.find((step) => step.name?.includes('Upload exact-SHA trusted master qualification'));
  assert.equal(upload.with.name, contract.evidenceArtifact);
  assert.equal(upload.with['if-no-files-found'], 'error');
  const preview = seal.steps.find((step) => step.name?.includes('Upload explicitly nonpublishing'));
  assert.equal(preview.with.name, 'noveltea-extended-qualification-preview');
  assert.equal(preview.if, "needs.source.outputs.preview == 'true'");
  for (const [name, job] of Object.entries(extended.jobs)) {
    if (name === 'source') continue;
    assert.ok(job.steps.some((step) => step.uses === 'actions/checkout@v6' &&
      step.with?.ref === '${{ needs.source.outputs.source_sha }}'),
    `${name} must use selected SHA, not moving master`);
  }
  const sourceJob = extended.jobs.source;
  assert.ok(sourceJob.if.includes("github.ref == 'refs/heads/master'"));
  const resolve = sourceJob.steps.find((step) => step.name?.startsWith('Resolve trusted Build'));
  assert.match(resolve.run, /git merge-base --is-ancestor/);
  assert.match(resolve.run, /gh run list.*--workflow build.yml/);
  assert.match(resolve.run, /gh api "repos\/\$GITHUB_REPOSITORY\/actions\/runs\/\$run_id"/);
  assert.match(resolve.run, /"completed"/);
  assert.match(resolve.run, /"success"/);
  const candidate = extended.jobs['native-cli-performance'].steps.find((step) =>
    step.name?.includes('Download exact trusted Build CLI'));
  assert.match(candidate.run, /stage=promote/);
  assert.match(candidate.run, /stage=preview/);
  assert.equal(candidate.env.GITHUB_SHA, '${{ needs.source.outputs.source_sha }}');
  assert.ok(extended.jobs['android-emulator'].steps.some((step) =>
    step.run?.includes('needs.source.outputs.build_run_id')));
});

test('a successful exact-SHA qualification seals only the complete required job set', () => {
  const receipt = makeReceipt(context, results());
  assert.equal(receipt.sourceSha, sha);
  assert.equal(receipt.workflowSha, selected);
  assert.equal(receipt.trustedBuildRunId, 42);
  assert.equal(receipt.runId, 108);
  assert.equal(receipt.attempt, 2);
  assert.equal(receipt.contractSha256.length, 64);
  assert.deepEqual(Object.keys(receipt.jobs).sort(), required.slice().sort());
  assert.ok(verifyReceipt(receipt, sha, 108));
  assert.throws(() => verifyReceipt(receipt, selected), /different commit/);
  assert.throws(() => verifyReceipt(receipt, sha, 109), /run ID mismatch/);
});

test('Release acceptance rejects an unsigned or unsuccessful Actions run even with a valid receipt', () => {
  const receipt = makeReceipt(context, results());
  const run = {
    id: receipt.runId, run_attempt: receipt.attempt,
    name: 'Extended Qualification', path: contract.workflow,
    repository: { full_name: 'Cruel/nt' }, head_repository: { full_name: 'Cruel/nt' },
    head_branch: 'master', head_sha: context.workflowSha, event: 'workflow_dispatch',
    status: 'completed', conclusion: 'success',
  };
  assert.ok(verifyTrustedQualificationRun(receipt, run, sha));
  for (const update of [
    { conclusion: 'failure' }, { conclusion: 'skipped' }, { status: 'in_progress' },
    { head_branch: 'feature' }, { head_sha: sha }, { id: 9999 },
    { event: 'pull_request' }, { run_attempt: 1 },
    { path: '.github/workflows/build.yml' },
    { repository: { full_name: 'attacker/nt' } },
    { head_repository: { full_name: 'attacker/nt' } },
  ]) assert.throws(() => verifyTrustedQualificationRun(receipt, { ...run, ...update }, sha));
});

test('skipped, cancelled, failed and missing Extended jobs cannot produce valid evidence', () => {
  for (const result of ['failure', 'skipped', 'cancelled', 'neutral', 'in_progress']) {
    const needs = results();
    needs['linux-sanitize'] = { result };
    assert.throws(() => qualifyResults(needs), /must succeed/);
    assert.throws(() => makeReceipt(context, needs), /must succeed/);
  }
  const needs = results();
  delete needs['android-emulator'];
  assert.throws(() => makeReceipt(context, needs), /needs set differs/);
  const augmented = results();
  augmented.unexpected = { result: 'success' };
  assert.throws(() => makeReceipt(context, augmented), /needs set differs/);
});

test('receipt verification rejects forged authority, invalid contract and partial results', () => {
  const base = makeReceipt(context, results());
  for (const update of [
    { sourceSha: selected }, { repository: 'attacker/nt' },
    { ref: 'refs/heads/feature' }, { event: 'pull_request' },
    { workflow: 'Build' }, { workflowPath: '.github/workflows/coverage.yml' },
    { attempt: 0 }, { trustedBuildRunId: 0 }, { contractSha256: '0'.repeat(64) },
    { jobs: { ...base.jobs, 'linux-sanitize': 'skipped' } },
    { version: 1 },
    { unrecognizedField: 'forged' },
  ]) assert.throws(() => verifyReceipt({ ...base, ...update }, sha));
  for (const update of [
    { ...context, ref: 'refs/heads/feature' },
    { ...context, repository: 'attacker/nt' },
    { ...context, workflow: 'Build' },
    { ...context, event: 'pull_request' },
    { ...context, runId: 0 },
  ]) assert.throws(() => makeReceipt(update, results()));
});
