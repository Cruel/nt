import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { makeReceipt, qualifyResults, verifyReceipt, verifyTrustedQualificationRun, selectWindowsTestArtifact } from '../../scripts/ci/extended-qualification.mjs';

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
  assert.equal(build.jobs['linux-native-build'].steps.find((step) => step.name === 'Configure')
    .run.includes('-DNOVELTEA_ENABLE_COVERAGE=OFF'), true);
  assert.equal(build.jobs.editor.steps.find((step) => step.name === 'Test').run,
    'pnpm -C editor run test');
  assert.equal(coverage.jobs.native.steps.find((step) => step.name === 'Configure')
    .run.includes('-DNOVELTEA_ENABLE_COVERAGE=ON'), true);
  assert.ok(coverage.jobs.editor.steps.find((step) => step.name === 'Test and instrument editor')
    .run.includes('test:coverage'));
  for (const job of Object.values(coverage.jobs)) {
    assert.ok([job.needs ?? []].flat().every((dependency) => Object.hasOwn(coverage.jobs, dependency)),
      'Coverage cannot depend on Build artifacts or statuses');
  }
  assert.ok(!Object.keys(build.jobs).some((name) =>
    ['linux-sanitize', 'web-benchmark', 'android-emulator'].includes(name)));
  assert.equal(coverage.jobs['native-combined'].permissions['id-token'], 'write');
  assert.equal(coverage.jobs.editor.permissions['id-token'], 'write');
  for (const jobName of ['native-combined', 'editor']) {
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
  assert.equal(cacheSteps.length, 4);
  for (const step of cacheSteps) {
    assert.equal(step.if,
      step.uses === 'actions/cache/restore@v5'
        ? "inputs['read-only'] == 'true'" : "inputs['read-only'] != 'true'");
  }
  assert.equal(coverage.env.CCACHE_MAXSIZE, '2048M');
  assert.equal(coverage.jobs.native.steps.find(s => s.uses === './.github/actions/setup-ccache').with.storage, 'coverage-artifact');
  assert.ok(!coverage.jobs.native.steps.some(s => s.uses === './.github/actions/save-ccache'));
  assert.equal(coverage.permissions.actions, 'read');
  assert.ok(coverage.jobs.native.steps.some((step) =>
    step.run?.includes('scripts/ci/install-coverage-ccache.sh')));
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
  assert.equal(restoredCli.with['artifact-ids'], '${{ needs.native.outputs.cli-id }}');
  assert.equal(coverage.jobs.native.outputs['cli-id'], '${{ steps.native-cli.outputs.artifact-id }}');
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


test('production consumers wait only for their platform and preserve all qualification steps', () => {
  for (const platform of ['linux', 'windows', 'macos']) {
    const cli = platform === 'linux' ? 'production-linux-release-cli' : `production-host-cli-${platform}`;
    const player = `production-desktop-player-${platform}`;
    const editor = build.jobs[`production-editor-host-${platform}`];
    const launch = build.jobs[`production-desktop-launch-${platform}`];
    assert.deepEqual(editor.needs, ['web-preview', cli]);
    assert.deepEqual(launch.needs, [player, cli]);
    assert.equal(editor.strategy.matrix.include.length, 1);
    assert.deepEqual(launch.strategy.matrix.include.map(row => row.variant), ['release', 'devtools']);
    assert.deepEqual(build.jobs[player].strategy.matrix.include.map(row => row.variant), ['release', 'devtools']);
    for (const job of [editor, launch, build.jobs[player]])
      assert.ok(job.strategy.matrix.include.every(row => row.platform === platform));
    assert.ok(editor.env.NOVELTEA_AUTHORING_NODE_ADDON);
    assert.ok(editor.steps.some(s => s.name === 'Certify permanent installed Editor package smoke'));
    assert.ok(launch.steps.some(s => s.name === `Export and launch actual ${platform === 'macos' ? 'macOS' : platform === 'linux' ? 'Linux' : 'Windows'} production player`));
  }
  assert.deepEqual(build.jobs['production-host-cli-windows'].steps, build.jobs['production-host-cli-macos'].steps);
});

test('compiled production host CLIs require independent exact-byte certification before Build can pass', () => {
  for (const platform of ['windows', 'macos']) {
    const producerName = `production-host-cli-${platform}`;
    const producer = build.jobs[producerName];
    const cert = build.jobs[`production-host-cli-certify-${platform}`];
    assert.equal(cert.name, `Production host CLI (${platform})`);
    assert.equal(cert.needs, producerName);
    assert.match(cert.if, /always\(\)/);
    assert.match(cert.steps[0].run, /test "\$CLI_BUILD_RESULT" = success/);
    assert.equal(cert.env.CLI_ARTIFACT_ID, `${'\x24'}{{ needs.${producerName}.outputs.cli-id }}`);
    assert.ok(producer.outputs['cli-id']);
    assert.equal(cert.steps.find(s => s.name === 'Restore exact compiled host CLI').with['artifact-ids'], '${{ env.CLI_ARTIFACT_ID }}');
    assert.match(cert.steps.find(s => s.name === 'Certify production CLI native Project transactions and public commands').run, /--cli-only/);
    assert.ok(cert.steps.find(s => s.name === 'Verify certified host CLI bytes remain identical'));
  }
  for (const platform of ['linux', 'windows', 'macos']) {
    const editor = build.jobs[`production-editor-host-${platform}`];
    const witness = editor.steps.find(s => s.name === 'Qualify native CLI and Electron authoring authority together');
    assert.match(witness.run, /release-candidate\.mjs verify/);
    assert.match(witness.run, /check-native-production-closure\.mjs/);
    assert.match(witness.run, /certify-native-authoring-cross-system\.mjs/);
    assert.doesNotMatch(witness.run, /noveltea:certify/);
  }
});

test('Windows policy and Android export retain required fail-closed producer/consumer boundaries', () => {
  const native = build.jobs['windows-native-build'];
  const policy = build.jobs['windows-native-policy'];
  const tests = build.jobs['windows-native-tests'];
  const aggregate = build.jobs.windows;
  assert.equal(native.needs, 'shader-assets');
  assert.equal(policy.needs, 'shader-assets');
  assert.deepEqual(policy.steps, native.steps);
  assert.equal(native.env.WINDOWS_NATIVE_LANE, 'build');
  assert.equal(policy.env.WINDOWS_NATIVE_LANE, 'policy');
  assert.equal(native.env.WINDOWS_NATIVE_CACHE_SCOPE, 'windows-msvc-release');
  assert.equal(policy.env.WINDOWS_NATIVE_CACHE_SCOPE, 'windows-msvc-policy-release');
  assert.equal(native.env.CCACHE_MAXSIZE, '1280M');
  assert.equal(policy.env.CCACHE_MAXSIZE, '256M');
  assert.equal(native.steps.find(s => s.name === 'Restore Windows compiler outputs').with.scope,
    '${{ env.WINDOWS_NATIVE_CACHE_SCOPE }}');
  const save = native.steps.find(s => s.name === 'Save Windows compiler outputs');
  assert.equal(save.if, undefined);
  assert.equal(save.uses, './.github/actions/save-ccache');
  assert.ok(native.steps.indexOf(save) > native.steps.findIndex(s => s.name === 'Enforce Windows C++ runtime and dependency policy'));
  assert.equal(native.steps.find(s => s.name === 'Cache Windows compiled vcpkg dependencies').if,
    "env.WINDOWS_NATIVE_LANE == 'build'");
  assert.equal(native.steps.find(s => s.name === 'Enforce Windows C++ runtime and dependency policy').if, "env.WINDOWS_NATIVE_LANE == 'policy'");
  assert.equal(tests.needs, 'windows-native-build');
  assert.equal(tests.env.PYTHONUTF8, '1', 'Native CLI certification must use UTF-8 even on Windows with a legacy ANSI code page');
  assert.equal(tests.strategy['fail-fast'], false);
  assert.deepEqual(tests.strategy.matrix.suite, ['lightweight', 'validation', 'platform', 'interop']);
  assert.equal(tests.steps.find(s => s.name === 'Download exact Windows MSVC native test closure').with['artifact-ids'], '${{ needs.windows-native-build.outputs.test-id }}');
  for (const [name, suite] of [
    ['Test Windows lightweight native suites', 'lightweight'],
    ['Certify Windows native Project transaction commit and recovery', 'lightweight'],
    ['Certify native Windows incremental validation, external stages and recovery', 'validation'],
    ['Certify native Windows platform exports and publication recovery', 'platform'],
    ['Certify Windows installed CLI candidate repair and unsafe paths', 'platform'],
    ['Launch exact current Windows player template through native C++ export', 'platform'],
    ['Certify Windows CLI/editor cache-writer handoff', 'interop'],
  ]) assert.equal(tests.steps.find(s => s.name === name).if, `matrix.suite == '${suite}'`);
  assert.deepEqual(aggregate.needs, ['windows-native-build', 'windows-native-policy', 'windows-native-tests']);
  assert.equal(aggregate.name, 'Windows C++ policy');
  assert.match(aggregate.if, /always\(\)/);
  for (const result of ['BUILD_RESULT', 'POLICY_RESULT', 'TEST_RESULT'])
    assert.ok(aggregate.steps[0].run.includes(`test "$${result}" = success`));

  const androidBuild = build.jobs['android-debug-build'];
  const android = build.jobs.android;
  assert.equal(androidBuild.needs, 'shader-assets');
  assert.deepEqual(android.needs, ['android-debug-build', 'linux-cli']);
  assert.match(android.if, /always\(\)/);
  assert.ok(!androidBuild.steps.some(s => s.name === 'Download NovelTea host CLI'));
  assert.ok(androidBuild.steps.some(s => s.name === 'Build Android debug APK'));
  assert.ok(!android.steps.some(s => s.name === 'Build Android debug APK'));
  assert.equal(android.steps.find(s => s.name === 'Download NovelTea host CLI').with['artifact-ids'], '${{ needs.linux-cli.outputs.cli-id }}');
  assert.equal(android.steps.find(s => s.name === 'Restore exact original debug template archive and reports').with['artifact-ids'], '${{ needs.android-debug-build.outputs.template-id }}');
  assert.match(android.steps.find(s => s.name === 'Export fixture revisions through public project export CLI').run, /for revision in 1 2/);
});

test('Extended authorizes only the exact successful Windows Build producer attempt, including on reruns', () => {
  const id = 42, attempt = 2, now = Date.now();
  const run = { id, name: 'Build', path: contract.producerWorkflow, head_sha: sha,
    head_branch: 'master', event: 'push', status: 'completed', conclusion: 'success', run_attempt: 3,
    repository: { id: 123, full_name: 'Cruel/nt' }, head_repository: { id: 123, full_name: 'Cruel/nt' } };
  const jobs = ['Windows MSVC native test build', 'Windows C++ policy'].map((name, index) =>
    ({ name, run_id: id, head_sha: sha, run_attempt: attempt + index, status: 'completed', conclusion: 'success' }));
  const artifact = { id: 777, name: 'noveltea-windows-native-test-build-2', expired: false,
    size_in_bytes: 100, expires_at: new Date(now + 86400000).toISOString(),
    workflow_run: { id, head_sha: sha, head_branch: 'master', repository_id: 123, head_repository_id: 123 } };
  const select = (r = run, j = jobs, a = [artifact], preview = false) =>
    selectWindowsTestArtifact(r, j, a, sha, id, preview, now);
  assert.deepEqual(select(run, jobs, [{ ...artifact, id: 776, name: 'noveltea-windows-native-test-build-1' }, artifact]),
    { id: 777, attempt: 2 });
  for (const update of [{ head_sha: selected }, { head_branch: 'feature' }, { conclusion: 'failure' },
    { status: 'in_progress' }, { event: 'pull_request' }, { path: '.github/workflows/coverage.yml' },
    { head_repository: { id: 999, full_name: 'Other/nt' } }, { run_attempt: 1 }])
    assert.throws(() => select({ ...run, ...update }));
  for (const invalidJobs of [jobs.slice(0, 1), [jobs[0], { ...jobs[1], conclusion: 'failure' }],
    [{ ...jobs[0], run_id: 99 }, jobs[1]], [...jobs, jobs[0]]])
    assert.throws(() => select(run, invalidJobs));
  for (const update of [{ expired: true }, { expires_at: new Date(now - 1).toISOString() },
    { name: 'noveltea-windows-native-test-build-3' }, { workflow_run: { ...artifact.workflow_run, id: 99 } },
    { workflow_run: { ...artifact.workflow_run, head_sha: selected } },
    { workflow_run: { ...artifact.workflow_run, head_repository_id: 999 } }])
    assert.throws(() => select(run, jobs, [{ ...artifact, ...update }]));
  assert.throws(() => select(run, jobs, []));
  assert.throws(() => select(run, jobs, [artifact, { ...artifact, id: 888 }]));
  const branch = 'ci/build-release-refactor-641';
  const previewRun = { ...run, head_branch: branch, event: 'workflow_dispatch' };
  const previewArtifact = { ...artifact, workflow_run: { ...artifact.workflow_run, head_branch: branch } };
  assert.deepEqual(select(previewRun, jobs, [previewArtifact], true), { id: 777, attempt: 2 });
  assert.throws(() => select(previewRun, jobs, [previewArtifact]));
});

test('Extended Windows stress runs on authenticated Build bytes and all repetitions remain mandatory', () => {
  const source = extended.jobs.source;
  const job = extended.jobs['windows-stress'];
  assert.equal(job.needs, 'source');
  assert.equal(job.strategy['fail-fast'], false);
  assert.deepEqual(job.strategy.matrix.suite, ['core', 'incremental', 'portable', 'interop']);
  assert.equal(job.env.PYTHONUTF8, '1');
  assert.equal(job.steps.find(s => s.uses === 'actions/setup-python@v6').with['python-version'],
    build.jobs['windows-native-build'].steps.find(s => s.uses === 'actions/setup-python@v6').with['python-version']);
  assert.equal(source.outputs.windows_test_artifact_id, '${{ steps.windows-test-artifact.outputs.artifact_id }}');
  assert.equal(source.outputs.windows_test_attempt, '${{ steps.windows-test-artifact.outputs.attempt }}');
  assert.ok(source.steps.some(s => s.run?.includes('extended-qualification.mjs windows-test-artifact')));
  const download = job.steps.find(s => s.uses === 'actions/download-artifact@v7');
  assert.equal(download.with['run-id'], '${{ needs.source.outputs.build_run_id }}');
  assert.equal(download.with['artifact-ids'], '${{ needs.source.outputs.windows_test_artifact_id }}');
  assert.equal(download.with['github-token'], '${{ github.token }}');
  assert.ok(job.steps.some(s => s.run?.includes('windows-native-test-build.py" restore-build')));
  const verifier = job.steps.find(s => s.name === 'Stage immutable workflow transport verifier');
  assert.equal(verifier.env.WORKFLOW_SHA, '${{ github.workflow_sha }}');
  assert.match(verifier.run, /git show "\$WORKFLOW_SHA:scripts\/ci\/windows-native-test-build\.py"/);
  assert.ok(!job.steps.some(s => /cmake --build|cmake --preset|PackageNovelTeaPlayerTemplate|ccache|bootstrap-vcpkg/.test(s.run ?? '')));
  for (const [lane, name] of [['incremental', 'incremental_validation_certification'], ['portable', 'portable_validation_cache']]) {
    const matching = job.steps.filter(s => s.if === `matrix.suite == '${lane}'` && s.run?.includes(`^native_cli_${name}$`));
    assert.equal(matching.length, 2);
    assert.ok(matching.every(s => s.run.includes('--no-tests=error')));
    assert.ok(matching.some(s => s.run.includes('--repeat until-fail:3')));
  }
  const broker = job.steps.find(s => s.name === 'Stress Windows broker proof and source mutation invalidation');
  assert.match(broker.run, /--repeat until-fail:10/);
  assert.match(broker.run, /--no-tests=error/);
  assert.equal(broker.if, "matrix.suite == 'core'");
  assert.ok(job.steps.some(s => s.run?.includes('windows_release_smoke.py') && s.run.includes('needs.source.outputs.source_sha')));
  assert.ok(job.steps.some(s => s.run?.includes('cache_writer_cli_editor.py') && s.if === "matrix.suite == 'interop'"));
  assert.ok(contract.jobs.includes('windows-stress'));
  const failed = results();
  failed['windows-stress'] = { result: 'failure' };
  assert.throws(() => makeReceipt(context, failed), /windows-stress must succeed/);
});
