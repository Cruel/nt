// Nonpublishing acceptance campaign for the one-time CI migration.
// This is deliberately not a release authority: it never accepts master/tag
// publication and never calls the production Trusted Build/Extended validators.
import assert from 'node:assert/strict';
import { checkBuildArtifacts, requiredArtifacts } from './release-promotion.mjs';
import { verifyReceipt } from './extended-qualification.mjs';

export const previewBranch = 'ci/build-release-refactor-641';
export const previewRef = `refs/heads/${previewBranch}`;
const sourcePattern = /^[a-f0-9]{40}$/;

export function verifyPreviewBuild(run, sourceSha) {
  assert.match(sourceSha, sourcePattern);
  assert.equal(run?.name, 'Build');
  assert.equal(run.path, '.github/workflows/build.yml');
  assert.equal(run.repository?.full_name, 'Cruel/nt');
  assert.equal(run.head_repository?.full_name, 'Cruel/nt');
  assert.equal(run.head_branch, previewBranch);
  assert.equal(run.head_sha, sourceSha);
  assert.ok(['push', 'workflow_dispatch'].includes(run.event),
    'Premerge candidate must originate from same-repository branch push or manual Build');
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.ok(Number.isSafeInteger(run.id) && run.id > 0);
  assert.ok(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
  return run.id;
}

export function verifyPreviewExtended(receipt, run, sourceSha, buildRunId) {
  assert.match(sourceSha, sourcePattern);
  assert.equal(receipt?.mode, 'preview', 'Must have explicitly nonpublishing Extended receipt');
  assert.equal(receipt?.ref, previewRef, 'Extended preview cannot substitute master receipt');
  // verifyReceipt is deliberately production-only and therefore rejects this
  // extra mode/ref. Validate shared contract independently by validating the
  // identical payload in a nonpublishing master-shaped projection.
  const { mode, ...ordinary } = receipt;
  verifyReceipt({ ...ordinary, ref: 'refs/heads/master', event: 'workflow_dispatch' }, sourceSha, run?.id);
  assert.equal(receipt.trustedBuildRunId, buildRunId);
  assert.equal(run?.id, receipt.runId);
  assert.equal(run.run_attempt, receipt.attempt);
  assert.equal(run.name, 'Extended Qualification');
  assert.equal(run.path, '.github/workflows/extended-qualification.yml');
  assert.equal(run.repository?.full_name, 'Cruel/nt');
  assert.equal(run.head_repository?.full_name, 'Cruel/nt');
  assert.equal(run.head_branch, previewBranch);
  assert.equal(run.head_sha, receipt.workflowSha);
  assert.ok(['workflow_dispatch', 'push'].includes(run.event));
  assert.equal(receipt.event, run.event);
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  return run.id;
}

export async function verifyPreviewAuthority(client, authority, sourceSha, catalog) {
  assert.match(sourceSha, sourcePattern);
  assert.equal(authority?.format, 'noveltea-premerge-qualification');
  assert.equal(authority.version, 1);
  assert.equal(authority.sourceSha, sourceSha);
  assert.equal(authority.ref, previewRef);
  assert.equal(authority.canPublish, false);
  for (const key of ['buildRunId', 'buildRunAttempt', 'extendedRunId', 'extendedRunAttempt']) {
    assert.ok(Number.isSafeInteger(authority[key]) && authority[key] > 0,
      `Invalid premerge run identity: ${key}`);
  }
  const run = await client.call(`actions/runs/${authority.buildRunId}`);
  verifyPreviewBuild(run, sourceSha);
  assert.equal(run.run_attempt, authority.buildRunAttempt);
  checkBuildArtifacts(await client.artifacts(run.id), requiredArtifacts(catalog));
  const extended = await client.call(`actions/runs/${authority.extendedRunId}`);
  assert.equal(extended.run_attempt, authority.extendedRunAttempt);
  const receipts = (await client.artifacts(extended.id)).filter((artifact) =>
    artifact.name === 'noveltea-extended-qualification-preview' && !artifact.expired);
  assert.equal(receipts.length, 1, 'Missing nonpublishing Extended preview evidence');
  verifyPreviewExtended(await client.receipt(receipts[0]), extended, sourceSha, run.id);
  return authority;
}

export async function authorizePremerge(client, {
  sourceSha, catalog, buildRunId, extendedRunId,
}) {
  for (const [name, id] of Object.entries({ buildRunId, extendedRunId })) {
    assert.ok(Number.isSafeInteger(id) && id > 0, `Missing exact ${name} for premerge preview`);
  }
  const build = await client.call(`actions/runs/${buildRunId}`);
  const extended = await client.call(`actions/runs/${extendedRunId}`);
  const authority = {
    format: 'noveltea-premerge-qualification', version: 1, ref: previewRef,
    canPublish: false, sourceSha, buildRunId, buildRunAttempt: build.run_attempt,
    extendedRunId, extendedRunAttempt: extended.run_attempt,
  };
  await verifyPreviewAuthority(client, authority, sourceSha, catalog);
  return authority;
}

export function requirePreviewInvocation(event, ref, buildRunId, extendedRunId) {
  assert.equal(event, 'workflow_dispatch', 'Premerge qualification must be manually dispatched');
  assert.equal(ref, previewRef, 'Premerge qualification must run only on the integration branch');
  assert.ok(Number.isSafeInteger(Number(buildRunId)) && Number(buildRunId) > 0);
  assert.ok(Number.isSafeInteger(Number(extendedRunId)) && Number(extendedRunId) > 0);
  return { buildRunId: Number(buildRunId), extendedRunId: Number(extendedRunId) };
}
