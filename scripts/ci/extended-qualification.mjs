#!/usr/bin/env node
// The workflow run's head_sha is the dispatch ref, not necessarily the
// manually selected older master commit. Bind explicit checkout SHA and every
// job result to the run ID; consumers must also verify the run's success.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const contract = JSON.parse(readFileSync(path.join(root, 'scripts/ci/extended-qualification-contract.json'), 'utf8'));
const shaPattern = /^[a-f0-9]{40}$/;

export function qualifyResults(needs, expected = contract.jobs) {
  assert.deepEqual(Object.keys(needs).sort(), expected.filter((job) => job !== 'source').sort(),
    'Extended Qualification needs set differs from the source-owned job contract');
  for (const name of expected.filter((job) => job !== 'source')) {
    assert.equal(needs[name]?.result, 'success', `Required Extended job ${name} must succeed (not fail, skip or cancel)`);
  }
}

export function makeReceipt(context, needs, expected = contract.jobs) {
  qualifyResults(needs, expected);
  assert.equal(context.repository, 'Cruel/nt', 'Extended producer repository must be Cruel/nt');
  assert.equal(context.workflow, 'Extended Qualification', 'Unexpected Extended workflow identity');
  const previewRef = 'refs/heads/ci/build-release-refactor-641';
  const preview = context.ref === previewRef;
  assert.ok(context.ref === 'refs/heads/master' || (preview && ['workflow_dispatch', 'push'].includes(context.event)),
    'Extended source must be master, except explicit nonpublishing integration-branch preview');
  assert.ok(['schedule', 'workflow_dispatch', ...(preview ? ['push'] : [])].includes(context.event), 'Unexpected Extended trigger');
  for (const key of ['sourceSha', 'workflowSha']) {
    assert.ok(shaPattern.test(context[key]), `Invalid ${key}`);
  }
  assert.ok(Number.isSafeInteger(context.runId) && context.runId > 0, 'Missing run ID');
  assert.ok(Number.isSafeInteger(context.attempt) && context.attempt > 0, 'Missing run attempt');
  assert.ok(Number.isSafeInteger(context.buildRunId) && context.buildRunId > 0, 'Missing trusted Build run ID');
  const qualified = Object.fromEntries(expected.filter((name) => name !== 'source').map((name) => [name, 'success']));
  return {
    format: 'noveltea-extended-qualification',
    sourceSha: context.sourceSha, workflowSha: context.workflowSha,
    repository: context.repository, workflow: context.workflow,
    workflowPath: contract.workflow, event: context.event, ref: context.ref,
    runId: context.runId, attempt: context.attempt,
    trustedBuildRunId: context.buildRunId,
    contractSha256: createHash('sha256').update(readFileSync(path.join(root, 'scripts/ci/extended-qualification-contract.json'))).digest('hex'),
    jobs: qualified,
    ...(preview ? { mode: 'preview' } : {}),
  };
}

export function verifyReceipt(receipt, sourceSha, runId) {
  assert.ok(shaPattern.test(sourceSha), 'Invalid expected source SHA');
  assert.deepEqual(Object.keys(receipt).sort(), [
    'format', 'sourceSha', 'workflowSha', 'repository', 'workflow',
    'workflowPath', 'event', 'ref', 'runId', 'attempt',
    'trustedBuildRunId', 'contractSha256', 'jobs',
  ].sort(), 'Unknown or missing Extended receipt fields');
  assert.equal(receipt.format, 'noveltea-extended-qualification');
  assert.equal(receipt.sourceSha, sourceSha, 'Extended certificate is for a different commit');
  assert.equal(receipt.repository, 'Cruel/nt');
  assert.equal(receipt.workflow, 'Extended Qualification');
  assert.equal(receipt.workflowPath, contract.workflow);
  assert.equal(receipt.ref, 'refs/heads/master');
  assert.ok(['schedule', 'workflow_dispatch'].includes(receipt.event));
  assert.ok(shaPattern.test(receipt.workflowSha));
  assert.ok(Number.isSafeInteger(receipt.runId) && receipt.runId > 0);
  if (runId !== undefined) assert.equal(receipt.runId, Number(runId), 'Extended workflow run ID mismatch');
  assert.ok(Number.isSafeInteger(receipt.attempt) && receipt.attempt > 0);
  assert.ok(Number.isSafeInteger(receipt.trustedBuildRunId) && receipt.trustedBuildRunId > 0);
  assert.equal(receipt.contractSha256,
    createHash('sha256').update(readFileSync(path.join(root, 'scripts/ci/extended-qualification-contract.json'))).digest('hex'),
    'Extended contract identity mismatch');
  qualifyResults(Object.fromEntries(Object.entries(receipt.jobs).map(([key, value]) => [key, { result: value }])),
    contract.jobs.filter((name) => name !== 'source'));
  return true;
}

// Release must establish this independently from the authenticated Actions API.
// workflow_dispatch run head_sha is the workflow definition's master commit,
// not necessarily the selected older master source commit.
export function verifyTrustedQualificationRun(receipt, run, sourceSha) {
  verifyReceipt(receipt, sourceSha, run?.id);
  assert.equal(run.run_attempt, receipt.attempt, 'Extended run attempt mismatch');
  assert.equal(run.name, 'Extended Qualification', 'Unexpected Extended run name');
  assert.equal(run.path, contract.workflow, 'Unexpected Extended workflow path');
  assert.equal(run.repository?.full_name, 'Cruel/nt', 'Extended run repository mismatch');
  assert.equal(run.head_repository?.full_name, 'Cruel/nt', 'Extended source repository mismatch');
  assert.equal(run.head_branch, 'master', 'Extended run is not from master');
  assert.equal(run.head_sha, receipt.workflowSha, 'Extended workflow source mismatch');
  assert.equal(run.event, receipt.event, 'Extended event mismatch');
  assert.equal(run.status, 'completed', 'Extended run has not completed');
  assert.equal(run.conclusion, 'success', 'Extended run did not succeed');
  return true;
}

// Resolve the exact artifact of the successful MSVC producer, not the
// newest similarly named artifact or the consumer's own run attempt.
export function selectWindowsTestArtifact(run, jobs, artifacts, sourceSha, runId, preview, now = Date.now()) {
  assert.ok(shaPattern.test(sourceSha));
  assert.ok(Number.isSafeInteger(runId) && runId > 0);
  assert.equal(run.id, runId);
  assert.equal(run.name, 'Build');
  assert.equal(run.path, contract.producerWorkflow);
  assert.equal(run.repository?.full_name, 'Cruel/nt');
  assert.equal(run.head_repository?.full_name, 'Cruel/nt');
  assert.ok(Number.isSafeInteger(run.repository.id) && run.repository.id > 0);
  assert.equal(run.head_repository.id, run.repository.id);
  assert.ok(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
  assert.equal(run.head_branch, preview ? 'ci/build-release-refactor-641' : 'master');
  assert.ok((preview ? ['push', 'workflow_dispatch'] : ['push']).includes(run.event));
  assert.equal(run.head_sha, sourceSha);
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  for (const name of ['Windows MSVC native test build', 'Windows C++ policy']) {
    const matching = jobs.filter(job => job.name === name);
    assert.equal(matching.length, 1, `Missing or ambiguous Build job: ${name}`);
    const job = matching[0];
    assert.equal(job.run_id, runId);
    assert.equal(job.head_sha, sourceSha);
    assert.equal(job.status, 'completed');
    assert.equal(job.conclusion, 'success');
    assert.ok(Number.isSafeInteger(job.run_attempt) && job.run_attempt > 0 && job.run_attempt <= run.run_attempt);
  }
  const attempt = jobs.find(job => job.name === 'Windows MSVC native test build').run_attempt;
  const candidates = artifacts.filter(a => a.name === `noveltea-windows-native-test-build-${attempt}`);
  assert.equal(candidates.length, 1, 'Missing or ambiguous exact MSVC test-build artifact; rerun Build if expired');
  const artifact = candidates[0];
  assert.equal(artifact.expired, false);
  assert.ok(Date.parse(artifact.expires_at) > now, 'MSVC test-build artifact expired');
  assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0 && artifact.size_in_bytes > 0);
  assert.equal(artifact.workflow_run?.id, runId);
  assert.equal(artifact.workflow_run?.head_sha, sourceSha);
  assert.equal(artifact.workflow_run?.head_branch, run.head_branch);
  assert.equal(artifact.workflow_run?.repository_id, run.repository.id);
  assert.equal(artifact.workflow_run?.head_repository_id, run.head_repository.id);
  return { id: artifact.id, attempt };
}

function api(endpoint) {
  return JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8' }));
}

function apiRows(endpoint, collection) {
  const rows = execFileSync('gh', ['api', endpoint, '--paginate', '--jq', `.${collection}[]`],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
  return rows ? rows.split('\n').map(line => JSON.parse(line)) : [];
}

function main(argv) {
  if (argv[0] === 'windows-test-artifact' && argv.length === 4) {
    const [, sha, id, mode] = argv;
    const runId = Number(id);
    assert.ok(Number.isSafeInteger(runId) && runId > 0);
    assert.ok(mode === 'true' || mode === 'false');
    const endpoint = `repos/Cruel/nt/actions/runs/${runId}`;
    const artifact = selectWindowsTestArtifact(api(endpoint),
      apiRows(`${endpoint}/jobs?filter=latest&per_page=100`, 'jobs'),
      apiRows(`${endpoint}/artifacts?per_page=100`, 'artifacts'),
      sha, runId, mode === 'true');
    appendFileSync(process.env.GITHUB_OUTPUT, `artifact_id=${artifact.id}\nattempt=${artifact.attempt}\n`);
    console.log(`Authorized exact Build MSVC test artifact ${artifact.id} (producer attempt ${artifact.attempt}).`);
  } else if (argv[0] === 'receipt' && argv.length === 1) {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: root }).trim();
    assert.equal(sha, process.env.QUALIFIED_SHA, 'Checked-out source does not match selected master SHA');
    const context = {
      sourceSha: sha, workflowSha: process.env.GITHUB_SHA,
      repository: process.env.GITHUB_REPOSITORY, workflow: process.env.GITHUB_WORKFLOW,
      event: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF,
      runId: Number(process.env.GITHUB_RUN_ID), attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      buildRunId: Number(process.env.BUILD_RUN_ID),
    };
    const needs = JSON.parse(process.env.NEEDS_JSON);
    assert.equal(needs.source?.result, 'success', 'Source authorization must have succeeded');
    assert.equal(needs.source?.outputs?.source_sha, sha, 'Source selection output mismatch');
    assert.equal(Number(needs.source?.outputs?.build_run_id), context.buildRunId, 'Build selection output mismatch');
    const { source: _, ...qualifications } = needs;
    const receipt = makeReceipt(context, qualifications);
    const report = path.join(root, 'build/reports/extended-qualification/receipt.json');
    mkdirSync(path.dirname(report), { recursive: true });
    writeFileSync(report, JSON.stringify(receipt, null, 2) + '\n');
    process.stdout.write(`Extended Qualification: source ${sha}, trusted Build run ${context.buildRunId}, run ${context.runId} attempt ${context.attempt} fully qualified.\n`);
  } else if (argv[0] === 'verify' && (argv.length === 3 || argv.length === 4)) {
    const report = JSON.parse(readFileSync(argv[1], 'utf8'));
    verifyReceipt(report, argv[2], argv[3]);
    process.stdout.write(`Verified Extended receipt for ${argv[2]}. Check the enclosing Actions workflow run's successful conclusion independently.\n`);
  } else {
    throw new Error('Usage: extended-qualification.mjs receipt | verify <receipt.json> <source-sha> [run-id] | windows-test-artifact <sha> <run-id> <preview>');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`Extended Qualification: ${error.message}\n`); process.exitCode = 1; }
}
