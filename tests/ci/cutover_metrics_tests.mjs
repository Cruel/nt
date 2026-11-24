import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatReport, percentile, summarizeBuild } from '../../scripts/ci/cutover-metrics.mjs';

const sha = 'a'.repeat(40);
const build = (attempt = 1, event = 'push') => ({
  id: 17, name: 'Build', path: '.github/workflows/build.yml',
  repository: { full_name: 'Cruel/nt' },
  head_repository: { full_name: 'Cruel/nt' },
  head_branch: 'master', head_sha: sha, event, run_attempt: attempt,
  status: 'completed', conclusion: 'success',
  created_at: '2026-11-20T10:00:00Z',
  run_started_at: '2026-11-20T10:02:00Z',
  updated_at: '2026-11-20T10:24:00Z',
});

const jobs = [{
  name: 'Editor', status: 'completed', conclusion: 'success',
  started_at: '2026-11-20T10:03:00Z',
  completed_at: '2026-11-20T10:22:00Z',
  steps: [{
    name: 'Restore compiler cache',
    started_at: '2026-11-20T10:03:00Z',
    completed_at: '2026-11-20T10:03:30Z',
  }],
}, {
  name: 'Windows', status: 'completed', conclusion: 'success',
  started_at: '2026-11-20T10:05:00Z',
  completed_at: '2026-11-20T10:23:00Z',
  steps: [{ name: 'Save compiler cache outputs',
    started_at: '2026-11-20T10:22:30Z',
    completed_at: '2026-11-20T10:23:00Z',
  }],
}];

test('percentiles use a stable sorted nearest-rank method', () => {
  assert.equal(percentile([28, 12, 5, 19, 30], 50), 19);
  assert.equal(percentile([28, 12, 5, 19, 30], 90), 30);
  assert.equal(percentile([28, 12, 5, 19, 30], 100), 30);
  assert.deepEqual([28, 12, 5, 19, 30], [28, 12, 5, 19, 30]);
  assert.throws(() => percentile([], 90));
});

test('exact trusted source run reports queue separately from runner wall', () => {
  const summary = summarizeBuild(build(), jobs);
  assert.equal(summary.id, 17);
  assert.equal(summary.firstAttempt, true);
  assert.equal(summary.wholeSeconds, 1440);
  assert.equal(summary.queueSeconds, 120);
  assert.equal(summary.executionSeconds, 1320);
  assert.equal(summary.lastFinishingJob, 'Windows');
  assert.equal(summary.maxJob.name, 'Editor');
  assert.equal(summary.cacheStages.length, 2);
  assert.equal(summary.cacheStages[0].seconds, 30);
  assert.equal(summarizeBuild(build(2), jobs).firstAttempt, false);
});

test('preview, manual, fork, wrong origin and status cannot be counted as trusted master runs', () => {
  assert.throws(() => summarizeBuild(build(1, 'workflow_dispatch'), jobs), /Only push/);
  assert.throws(() => summarizeBuild({ ...build(), head_branch: 'feature' }, jobs));
  assert.throws(() => summarizeBuild({ ...build(), repository: { full_name: 'fork/nt' } }, jobs));
  assert.throws(() => summarizeBuild({ ...build(), path: '.github/workflows/other.yml' }, jobs));
  assert.equal(summarizeBuild({ ...build(), head_branch: 'ci/build-release-refactor-641' },
    jobs, 'ci/build-release-refactor-641').branch, 'ci/build-release-refactor-641');
});

test('report refuses to certify p90 with insufficient first-attempt successful warm samples', () => {
  const sample = summarizeBuild(build(), jobs);
  const usage = { active_caches_count: 34, active_caches_size_in_bytes: 10066130683 };
  const report = formatReport([sample], usage, { warmIds: [17] });
  assert.match(report, /9\.37 GiB/);
  assert.match(report, /Queue \(min\)/);
  assert.match(report, /22\.00/);
  assert.match(report, /insufficient completed first-attempt warm Build samples/);
  const full = formatReport([1, 2, 3, 4, 5].map((id) => ({ ...sample, id })),
    usage, { warmIds: [1, 2, 3, 4, 5] });
  assert.match(full, /p50 \*\*22\.00 min\*\*/);
  assert.match(full, /p90 \*\*22\.00 min\*\*/);
});
