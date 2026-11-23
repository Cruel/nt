import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  planCachePrune,
  rollingCacheWindow,
  canPublishCompilerCache,
  planCiCacheAllocation,
} from '../../scripts/ci/cache-budget.mjs';

const GiB = 1024 ** 3;
const shaA = 'a'.repeat(40);
const shaB = 'b'.repeat(40);
const shaC = 'c'.repeat(40);

function entry(id, key, sizeInBytes, lastAccessedAt) {
  return { id, key, sizeInBytes, lastAccessedAt };
}

test('cache rotation is weekly and does not key per source SHA', () => {
  assert.equal(rollingCacheWindow(new Date('2026-11-19T10:00:00Z')), rollingCacheWindow(new Date('2026-11-20T10:00:00Z')));
  assert.notEqual(rollingCacheWindow(new Date('2026-11-19T10:00:00Z')), rollingCacheWindow(new Date('2026-11-26T10:00:00Z')));
});

test('only trusted pushes publish shared compiler caches', () => {
  assert.equal(canPublishCompilerCache('push', 'refs/heads/master', 'Cruel/nt'), true);
  assert.equal(canPublishCompilerCache('push', 'refs/heads/ci/build-release-refactor-641', 'Cruel/nt'), true);
  assert.equal(canPublishCompilerCache('push', 'refs/tags/v1.2.0', 'Cruel/nt'), true);
  assert.equal(canPublishCompilerCache('pull_request', 'refs/heads/master', 'Cruel/nt'), false);
  assert.equal(canPublishCompilerCache('push', 'refs/heads/master', 'someone/nt'), false);
  assert.equal(canPublishCompilerCache('workflow_dispatch', 'refs/heads/master', 'Cruel/nt'), false);
});

test('coverage and Extended allocation leaves production headroom below the 10 GiB limit', () => {
  // Captured 2026-11-20 inventory; not a promise of post-cutover cache residency.
  const observed = 10_066_130_683;
  const plan = planCiCacheAllocation(observed);
  assert.equal(plan.coverageBytes, 384 * 1024 ** 2);
  assert.equal(plan.extendedBytes, 0);
  assert.equal(plan.safetyBytes, 128 * 1024 ** 2);
  assert.equal(plan.withinLimit, true);
  assert.ok(plan.remainingProductionBytes > 0);
  assert.ok(plan.remainingProductionBytes < 256 * 1024 ** 2);
  assert.equal(planCiCacheAllocation(10 * GiB).withinLimit, false);
  assert.throws(() => planCiCacheAllocation(1, { coverageBytes: -1 }));
  assert.throws(() => planCiCacheAllocation(Number.POSITIVE_INFINITY));
});

test('prune only superseded immutable generations; preserve last compatible key per family', () => {
  const caches = [
    entry(1, `Linux-ccache-coverage-${shaA}`, 2 * GiB, '2026-10-01T00:00:00Z'),
    entry(2, `Linux-ccache-coverage-${shaB}`, 2 * GiB, '2026-11-01T00:00:00Z'),
    entry(3, `Linux-ccache-host-${shaA}`, 2 * GiB, '2026-10-01T00:00:00Z'),
    entry(4, `Linux-ccache-host-${shaC}`, 2 * GiB, '2026-11-17T00:00:00Z'),
    entry(5, 'windows-x64-vcpkg-policy-hash', 2 * GiB, '2026-08-01T00:00:00Z'),
  ];
  const plan = planCachePrune(caches, 7 * GiB);
  assert.deepEqual(plan.deleteIds, [1, 3]);
  assert.equal(plan.projectedBytes, 6 * GiB);
  assert.equal(plan.satisfied, true);
  assert.equal(plan.protectedIds.includes(5), true);
});

test('identical cache keys on different GitHub refs are not interchangeable', () => {
  const caches = [
    { ...entry(1, `Linux-ccache-host-${shaA}`, 2 * GiB, '2026-11-01T00:00:00Z'), ref: 'refs/heads/master' },
    { ...entry(2, `Linux-ccache-host-${shaA}`, 2 * GiB, '2026-11-20T00:00:00Z'), ref: 'refs/heads/integration' },
    { ...entry(3, `Linux-ccache-host-${shaB}`, 2 * GiB, '2026-11-21T00:00:00Z'), ref: 'refs/heads/master' },
  ];
  const plan = planCachePrune(caches, 4 * GiB);
  assert.deepEqual(plan.deleteIds, [1]);
  assert.ok(plan.protectedIds.includes(2));
  assert.ok(plan.protectedIds.includes(3));
});

test('cache budget fails visibly rather than evicting unique or last-needed configurations', () => {
  const caches = [
    entry(1, `Linux-ccache-host-${shaA}`, 2 * GiB, '2026-11-01T00:00:00Z'),
    entry(2, 'windows-x64-vcpkg-policy-hash', 9 * GiB, '2026-11-01T00:00:00Z'),
  ];
  const plan = planCachePrune(caches, 10 * GiB);
  assert.equal(plan.satisfied, false);
  assert.deepEqual(plan.deleteIds, []);
  assert.equal(plan.projectedBytes, 11 * GiB);
});
