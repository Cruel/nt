#!/usr/bin/env node
// Read-only hosted performance and cache evidence for the one-time #646 cutover.
// Reports observed GitHub timestamps; never infers compiler hit rates from a
// successful cache restore or conflates queue time with runner execution.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repository = 'Cruel/nt';
const gib = 1024 ** 3;
const gb = (bytes) => (bytes / gib).toFixed(2);
const seconds = (start, end) => {
  const a = Date.parse(start ?? '');
  const b = Date.parse(end ?? '');
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? (b - a) / 1000 : null;
};
const minutes = (sec) => sec == null ? 'n/a' : (sec / 60).toFixed(2);

export function percentile(numbers, p) {
  assert.ok(numbers.length > 0 && numbers.every((n) => Number.isFinite(n) && n >= 0));
  assert.ok(p >= 0 && p <= 100);
  const values = [...numbers].sort((a, b) => a - b);
  return values[Math.max(0, Math.ceil((p / 100) * values.length) - 1)];
}

export function summarizeBuild(run, jobs, requestedBranch = 'master') {
  assert.equal(run?.name, 'Build', 'Not a Build workflow');
  assert.equal(run.path, '.github/workflows/build.yml', 'Build workflow identity drift');
  assert.equal(run.repository?.full_name, repository, 'Build repository mismatch');
  assert.equal(run.head_repository?.full_name, repository, 'Fork Build cannot qualify');
  assert.equal(run.head_branch, requestedBranch, 'Build branch differs from requested acceptance cohort');
  assert.equal(run.event, 'push', 'Only push-triggered Build runs count toward warm/master acceptance');
  assert.match(run.head_sha, /^[0-9a-f]{40}$/);
  const suite = jobs.filter((job) => job.status === 'completed');
  const whole = seconds(run.created_at, run.updated_at);
  const queue = seconds(run.created_at, run.run_started_at);
  const execution = seconds(run.run_started_at, run.updated_at);
  const durations = suite.map((job) => ({
    name: job.name,
    seconds: seconds(job.started_at, job.completed_at),
    conclusion: job.conclusion,
    steps: (job.steps ?? []).map((step) => ({
      name: step.name, seconds: seconds(step.started_at, step.completed_at),
    })),
  }));
  const last = [...suite].filter((job) => job.completed_at)
    .sort((a, b) => Date.parse(b.completed_at) - Date.parse(a.completed_at))[0];
  const cacheStages = durations.flatMap((job) => job.steps
    .filter((step) => /cache|ccache|vcpkg/i.test(step.name ?? '') &&
      /restore|save|publication|setup|cached/i.test(step.name ?? ''))
    .map((step) => ({ job: job.name, ...step })));
  return {
    id: run.id, sha: run.head_sha, branch: run.head_branch,
    link: run.html_url ?? `https://github.com/${repository}/actions/runs/${run.id}`,
    status: run.status, conclusion: run.conclusion,
    firstAttempt: run.run_attempt === 1,
    wholeSeconds: whole, queueSeconds: queue, executionSeconds: execution,
    lastFinishingJob: last?.name ?? null,
    maxJob: durations.filter((job) => job.seconds !== null)
      .sort((a, b) => b.seconds - a.seconds)[0] ?? null,
    cacheStages,
  };
}

export function formatReport(samples, cacheUsage, {
  warmIds = [], coldIds = [], invalidationIds = [],
} = {}) {
  const byId = new Map(samples.map((sample) => [sample.id, sample]));
  const warm = warmIds.map((id) => byId.get(id)).filter(Boolean);
  const durations = warm.filter((sample) =>
    sample.status === 'completed' && sample.conclusion === 'success' &&
    sample.firstAttempt && sample.executionSeconds != null)
    .map((sample) => sample.executionSeconds);
  const lines = [
    '# #646 Build/Release CI timing evidence', '',
    `Data: GitHub Actions API. Cache occupancy: **${gb(cacheUsage.active_caches_size_in_bytes)} GiB**` +
      ` (${cacheUsage.active_caches_count} entries; ${cacheUsage.active_caches_size_in_bytes} bytes).`, '',
    '| Cohort | Run | Source SHA | Status | Attempt | Queue (min) | Runner wall (min) | End-to-end (min) | Longest job (min) | Last finisher |',
    '| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |',
  ];
  for (const sample of samples) {
    const cohort = warmIds.includes(sample.id) ? 'warm' :
      coldIds.includes(sample.id) ? 'cold' :
        invalidationIds.includes(sample.id) ? 'invalidation' : 'other';
    lines.push(`| ${cohort} | [${sample.id}](${sample.link}) | \`${sample.sha.slice(0, 10)}\` | ${sample.conclusion || sample.status} | ${sample.firstAttempt ? 'first' : 'rerun'} | ${minutes(sample.queueSeconds)} | ${minutes(sample.executionSeconds)} | ${minutes(sample.wholeSeconds)} | ${sample.maxJob ? `${sample.maxJob.name} (${minutes(sample.maxJob.seconds)})` : 'n/a'} | ${sample.lastFinishingJob ?? 'n/a'} |`);
  }
  lines.push('', 'Warm cohort: ' + durations.length + ' first-attempt successful completed run(s) of at least five required.');
  if (durations.length >= 5) {
    lines.push(`Observed execution p50 **${minutes(percentile(durations, 50))} min**, p90 **${minutes(percentile(durations, 90))} min**, max **${minutes(Math.max(...durations))} min** (nearest-rank method).`);
  } else {
    lines.push('p50/p90/max **not certified**: insufficient completed first-attempt warm Build samples.');
  }
  lines.push('', '## Cache phase evidence (GitHub job step timestamps)', '');
  for (const sample of samples) {
    lines.push(`- Run ${sample.id}: ${sample.cacheStages.length} observable cache-related job step(s).`);
    for (const step of sample.cacheStages) {
      lines.push(`  - ${step.job}: ${step.name}: ${minutes(step.seconds)} min`);
    }
  }
  lines.push('', 'Compiler **hit/miss rates are not derivable** from the Actions cache-hit flag or job timestamps; extract pinned ccache summaries/logs for the same run IDs before claiming a hit rate.');
  lines.push('The reported last-finishing job is an observed wall-clock bottleneck, not a fictional computed DAG critical path. Check source-controlled job dependencies alongside these timestamps to diagnose the actual critical path.');
  lines.push('Candidate workflow artifact bytes are **not** counted toward the 10 GiB Actions cache budget.');
  return lines.join('\n') + '\n';
}

function api(route) {
  return JSON.parse(execFileSync('gh', ['api', `repos/${repository}/${route}`], {
    encoding: 'utf8', maxBuffer: 30 * 1024 * 1024,
  }));
}

async function main() {
  const argv = process.argv.slice(2);
  const options = {};
  while (argv.length) {
    const key = argv.shift();
    const val = argv.shift();
    assert.ok(['--branch', '--warm', '--cold', '--invalidate'].includes(key) && val,
      'Usage: cutover-metrics.mjs --branch master --warm id,id,... [--cold id] [--invalidate id]');
    assert.ok(options[key] === undefined, `Duplicate ${key}`);
    options[key] = val;
  }
  const branch = options['--branch'] ?? 'master';
  assert.ok(['master', 'ci/build-release-refactor-641'].includes(branch));
  const idsFor = (key) => (options[key] ?? '').split(',').filter(Boolean).map((v) => {
    assert.match(v, /^[1-9][0-9]*$/);
    return Number(v);
  });
  const warmIds = idsFor('--warm');
  const coldIds = idsFor('--cold');
  const invalidationIds = idsFor('--invalidate');
  const ids = [...new Set([...warmIds, ...coldIds, ...invalidationIds])];
  assert.ok(ids.length, 'At least one Build run ID is required');
  const samples = [];
  for (const id of ids) {
    const run = api(`actions/runs/${id}`);
    const jobs = [];
    for (let page = 1; page <= 10; page++) {
      const body = api(`actions/runs/${id}/jobs?per_page=100&page=${page}`);
      jobs.push(...body.jobs);
      if (body.jobs.length < 100) break;
    }
    samples.push(summarizeBuild(run, jobs, branch));
  }
  process.stdout.write(formatReport(samples, api('actions/cache/usage'), {
    warmIds, coldIds, invalidationIds,
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`CI acceptance metrics: ${error.message}\n`);
    process.exitCode = 1;
  });
}
