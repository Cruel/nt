import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { makeReceipt, verifyTrustedQualificationRun } from '../../scripts/ci/extended-qualification.mjs';
import {
  authorizePremerge, previewBranch, previewRef, requirePreviewInvocation,
  verifyPreviewAuthority, verifyPreviewBuild, verifyPreviewExtended,
} from '../../scripts/ci/premerge-qualification.mjs';

const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const buildRun = {
  id: 902, run_attempt: 1, name: 'Build',
  path: '.github/workflows/build.yml',
  repository: { full_name: 'Cruel/nt' },
  head_repository: { full_name: 'Cruel/nt' },
  head_branch: previewBranch, head_sha: sha,
  event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
};
const extendedRun = {
  id: 903, run_attempt: 1, name: 'Extended Qualification',
  path: '.github/workflows/extended-qualification.yml',
  repository: { full_name: 'Cruel/nt' },
  head_repository: { full_name: 'Cruel/nt' },
  head_branch: previewBranch, head_sha: sha,
  event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
};
const jobNames = JSON.parse(await readFile(
  new URL('../../scripts/ci/extended-qualification-contract.json', import.meta.url),
  'utf8',
)).jobs;
const receipt = makeReceipt({
  sourceSha: sha, workflowSha: sha, repository: 'Cruel/nt',
  workflow: 'Extended Qualification', ref: previewRef, event: 'workflow_dispatch',
  runId: 903, attempt: 1, buildRunId: 902,
}, Object.fromEntries(jobNames.filter((name) => name !== 'source')
  .map((name) => [name, { result: 'success' }])));
const artifact = (name, id = 1) => ({
  name, id, size_in_bytes: 100, expired: false,
});
const catalog = {
  format: 'noveltea-candidate-catalog', version: 1,
  candidates: {
    example: {
      id: 'example', kind: 'native-player', target: 'linux-x64-player',
      variant: 'standard', preset: 'linux-release', compilerId: 'GNU',
      abiFloor: 'glibc-2.28', executable: 'bin/noveltea-player',
      artifactName: 'noveltea-candidate-example',
    },
  },
};
const artifacts = [
  artifact('noveltea-candidate-example'),
  artifact('noveltea-web-editor-preview', 2),
  artifact('noveltea-shader-assets', 3),
  artifact('noveltea-build-windows-tooling-bridge-release', 4),
  artifact('noveltea-build-windows-tooling-bridge-devtools', 5),
];
const client = (options = {}) => ({
  call: async (route) => route.endsWith('/902') ?
    (options.build ?? buildRun) : (options.extended ?? extendedRun),
  artifacts: async (runId) => runId === 902 ?
    (options.artifacts ?? artifacts) :
    (options.extendedArtifacts ?? [artifact('noveltea-extended-qualification-preview', 6)]),
  receipt: async () => options.receipt ?? receipt,
});

test('preview requires an explicitly authorized integration branch manual dispatch', () => {
  assert.deepEqual(requirePreviewInvocation('workflow_dispatch', previewRef, '902', '903'),
    { buildRunId: 902, extendedRunId: 903 });
  for (const args of [
    ['push', previewRef, '902', '903'],
    ['workflow_dispatch', 'refs/heads/master', '902', '903'],
    ['workflow_dispatch', 'refs/tags/v1.0.0', '902', '903'],
    ['workflow_dispatch', previewRef, '0', '903'],
  ]) assert.throws(() => requirePreviewInvocation(...args));
});

test('branch preview evidence never becomes authoritative master Release input', () => {
  assert.equal(receipt.mode, 'preview');
  assert.equal(receipt.ref, previewRef);
  assert.equal(verifyPreviewBuild(buildRun, sha), 902);
  assert.equal(verifyPreviewExtended(receipt, extendedRun, sha, 902), 903);
  const pushed = makeReceipt({
    sourceSha: sha, workflowSha: sha, repository: 'Cruel/nt',
    workflow: 'Extended Qualification', ref: previewRef, event: 'push',
    runId: 903, attempt: 1, buildRunId: 902,
  }, Object.fromEntries(jobNames.filter((name) => name !== 'source')
    .map((name) => [name, { result: 'success' }])));
  assert.equal(verifyPreviewExtended(pushed, { ...extendedRun, event: 'push' }, sha, 902), 903);
  assert.throws(() => verifyTrustedQualificationRun(receipt, extendedRun, sha));
});

test('complete nonpublishing candidate and Extended IDs must match source and run attempts', async () => {
  const authority = await authorizePremerge(client(), {
    sourceSha: sha, catalog, buildRunId: 902, extendedRunId: 903,
  });
  assert.equal(authority.canPublish, false);
  assert.equal(authority.format, 'noveltea-premerge-qualification');
  assert.equal(authority.ref, previewRef);
  assert.deepEqual(await verifyPreviewAuthority(client(), authority, sha, catalog), authority);
  await assert.rejects(verifyPreviewAuthority(client({ build: { ...buildRun, head_sha: otherSha } }),
    authority, sha, catalog));
  await assert.rejects(verifyPreviewAuthority(client({ build: { ...buildRun, event: 'pull_request' } }),
    authority, sha, catalog));
  await assert.rejects(verifyPreviewAuthority(client({ build: { ...buildRun, head_branch: 'master' } }),
    authority, sha, catalog));
  await assert.rejects(verifyPreviewAuthority(client({ artifacts: artifacts.slice(1) }),
    authority, sha, catalog));
  await assert.rejects(verifyPreviewAuthority(client({ extendedArtifacts: [] }),
    authority, sha, catalog), /Missing nonpublishing/);
  await assert.rejects(verifyPreviewAuthority(client({ extended: { ...extendedRun, conclusion: 'failure' } }),
    authority, sha, catalog));
  await assert.rejects(verifyPreviewAuthority(client({ receipt: { ...receipt, trustedBuildRunId: 99 } }),
    authority, sha, catalog));
  await assert.rejects(verifyPreviewAuthority(client({ extended: { ...extendedRun, run_attempt: 2 } }),
    authority, sha, catalog));
  await assert.rejects(verifyPreviewAuthority(client(), { ...authority, canPublish: true }, sha, catalog));
});
