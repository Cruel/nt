import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trustedCoverageSnapshots, snapshotName, legacyCoverageCachePrefix } from '../../scripts/ci/coverage-cache.mjs';
const prefix = `Linux-X64-ccache-v2-linux-debug-coverage-v3-${'a'.repeat(16)}-${'b'.repeat(64)}-`;
const now = Date.parse('2026-11-25T00:00:00Z');
const repo = { full_name: 'Cruel/nt' };
const run = { id: 123, event: 'push', head_branch: 'master', status: 'completed', conclusion: 'success', head_repository: repo, repository: repo, path: '.github/workflows/coverage.yml', head_sha: 'c'.repeat(40) };
const artifact = { id: 456, name: snapshotName(prefix), expired: false, created_at: '2026-11-22T00:00:00Z', expires_at: '2026-11-29T00:00:00Z', size_in_bytes: 100, workflow_run: { id: 123, head_branch: 'master', head_sha: run.head_sha } };
test('only a completed trusted compatible Coverage run can seed compiler objects', () => {
  assert.deepEqual(trustedCoverageSnapshots([artifact], () => run, prefix, now), [artifact]);
  for (const change of [{ event: 'pull_request' }, { conclusion: 'failure' }, { head_branch: 'other' }, { path: '.github/workflows/build.yml' }, { head_repository: { full_name: 'fork/nt' } }, { status: 'in_progress' }, { id: 124 }, { head_sha: 'd'.repeat(40) }])
    assert.deepEqual(trustedCoverageSnapshots([artifact], () => ({ ...run, ...change }), prefix, now), []);
  for (const change of [{ expired: true }, { expires_at: '2026-11-24T00:00:00Z' }, { name: artifact.name.replace('coverage-v3', 'coverage-v2') }, { workflow_run: { ...artifact.workflow_run, head_branch: 'pr' } }])
    assert.deepEqual(trustedCoverageSnapshots([{ ...artifact, ...change }], () => { throw Error('unrelated artifact inspected'); }, prefix, now), []);
  const newer = { ...artifact, id: 789, created_at: '2026-11-24T00:00:00Z' };
  assert.deepEqual(trustedCoverageSnapshots([artifact, newer], () => run, prefix, now), [newer, artifact]);
  assert.throws(() => snapshotName('other-cache'));
});
test('only the retired master Coverage compiler-cache generations are eligible for migration', () => {
  const entry = { key: prefix + 'r123-a1', ref: 'refs/heads/master' };
  assert.equal(legacyCoverageCachePrefix(entry), prefix);
  assert.equal(legacyCoverageCachePrefix({ ...entry, ref: 'refs/heads/other' }), null);
  assert.equal(legacyCoverageCachePrefix({ ...entry, key: entry.key.replace('coverage-v3', 'release') }), null);
  assert.equal(legacyCoverageCachePrefix({ ...entry, key: entry.key + 'bad' }), null);
});
