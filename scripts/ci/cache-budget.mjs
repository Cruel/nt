#!/usr/bin/env node
// Audit and safely prune superseded immutable GitHub Actions caches. Never delete the
// most recently used generation of any compatibility scope just to satisfy a quota.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { findCoverageSnapshots, legacyCoverageCachePrefix, validPrefix } from './coverage-cache.mjs';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
export const ACTIONS_CACHE_LIMIT_BYTES = 10 * GiB;
export const DEFAULT_BUDGET_BYTES = Math.floor(9.5 * GiB);

export function rollingCacheWindow(date = new Date()) {
  const utc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  // Weeks start on Monday; unlike commit-SHA keys this creates at most one new generation/week.
  const day = new Date(utc).getUTCDay();
  return `w${Math.floor((utc - ((day + 6) % 7) * 86400000) / (7 * 86400000))}`;
}

// Actions caches are immutable. A run generation allows a poor/empty restore
// to be refreshed immediately, while the compatible prefix spans all commits.
export function compilerCacheGeneration(runId, attempt) {
  if (!/^[1-9]\d*$/.test(runId ?? '') || !/^[1-9]\d*$/.test(attempt ?? ''))
    throw new Error('A valid GitHub run ID and attempt are required.');
  return `r${runId}-a${attempt}`;
}

export function shouldRefreshCompilerCache(statsText, restored) {
  const stats = new Map(statsText.trim().split(/\r?\n/).map((line) => line.split(/\s+/)));
  const count = (name) => {
    const value = Number(stats.get(name));
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`Missing or invalid ccache statistic: ${name}`);
    return value;
  };
  const misses = count('cache_miss');
  const hits = count('direct_cache_hit') + count('preprocessed_cache_hit');
  // Never archive an empty/no-op job, and avoid copying a large warm cache
  // for just a few source-identity translation units.
  return misses > 0 && (!restored || misses >= 8 || misses / (misses + hits) >= 0.05);
}

export function canPublishCompilerCache(event, ref, repository) {
  return event === 'push' && repository === 'Cruel/nt' &&
    (ref === 'refs/heads/master' || ref === 'refs/heads/ci/build-release-refactor-641' ||
      /^refs\/tags\/v[0-9]/.test(ref));
}

function family(key) {
  // Do not infer compatibility for keys without an explicitly recognized rotation suffix.
  const match = /^(.*)-(?:[a-f0-9]{40}|w\d{4,}|r[1-9]\d*-a[1-9]\d*)$/.exec(key);
  return match?.[1];
}

export function planCachePrune(entries, budgetBytes = DEFAULT_BUDGET_BYTES, replacedCoveragePrefixes = []) {
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0) throw new Error('Invalid cache budget.');
  const cacheEntries = entries.map((entry) => {
    if (!Number.isSafeInteger(entry.id) || !Number.isSafeInteger(entry.sizeInBytes) ||
        entry.sizeInBytes < 0 || typeof entry.key !== 'string' ||
        !Number.isFinite(Date.parse(entry.lastAccessedAt))) {
      throw new Error('Invalid GitHub cache inventory entry.');
    }
    return entry;
  });
  const originalBytes = cacheEntries.reduce((bytes, entry) => bytes + entry.sizeInBytes, 0);
  const replaced = new Set(replacedCoveragePrefixes);
  // Only a verified replacement outside Actions cache allows retirement of
  // the last legacy Coverage generation. No production scope is eligible.
  const retired = cacheEntries.filter(entry => replaced.has(legacyCoverageCachePrefix(entry)) && legacyCoverageCachePrefix(entry));
  const retiredIds = new Set(retired.map(entry => entry.id));
  const groups = new Map();
  for (const entry of cacheEntries) {
    if (retiredIds.has(entry.id)) continue;
    const name = family(entry.key);
    if (!name) continue;
    // Actions caches are branch-scoped. Identical keys on different refs are
    // not interchangeable; preserve each ref's last usable generation.
    const scope = `${entry.ref ?? ''}\0${name}`;
    const group = groups.get(scope) ?? [];
    group.push(entry);
    groups.set(scope, group);
  }
  const eligible = [];
  const compact = [...retired];
  const protectedIds = [];
  for (const group of groups.values()) {
    const masterCompiler = group[0].ref === 'refs/heads/master' &&
      /-ccache-v2-/.test(group[0].key);
    // Keep the newest *published* compiler generation even if an in-flight
    // older job has accessed a prior snapshot more recently.
    if (masterCompiler) {
      group.sort((a, b) => (Date.parse(a.createdAt ?? a.lastAccessedAt) -
        Date.parse(b.createdAt ?? b.lastAccessedAt)) || a.id - b.id);
      compact.push(...group.slice(0, -1));
    } else {
      group.sort((a, b) => Date.parse(a.lastAccessedAt) - Date.parse(b.lastAccessedAt) || a.id - b.id);
      eligible.push(...group.slice(0, -1));
    }
    protectedIds.push(group.at(-1).id);
  }
  for (const entry of cacheEntries) {
    if (!retiredIds.has(entry.id) && !family(entry.key)) protectedIds.push(entry.id);
  }
  eligible.sort((a, b) => Date.parse(a.lastAccessedAt) - Date.parse(b.lastAccessedAt) || a.id - b.id);
  // Refreshing immutable compiler caches must not leave generations to
  // accumulate until the repository is nearly full.
  let projectedBytes = originalBytes - compact.reduce((bytes, entry) => bytes + entry.sizeInBytes, 0);
  const deleteIds = compact.map((entry) => entry.id);
  for (const entry of eligible) {
    if (projectedBytes <= budgetBytes) break;
    deleteIds.push(entry.id);
    projectedBytes -= entry.sizeInBytes;
  }
  return {
    originalBytes,
    projectedBytes,
    budgetBytes,
    satisfied: projectedBytes <= budgetBytes,
    deleteIds,
    protectedIds,
  };
}

// Informational capacity plan: Extended restores caches read-only; Coverage
// compiler snapshots live in the separate artifact store.
// Any newly generated production scopes must fit in remaining headroom; #646
// certifies that their actual hosted residency does, rather than assuming it.
export function planCiCacheAllocation(observedBytes, {
  coverageBytes = 0,
  extendedBytes = 0,
  safetyBytes = 128 * MiB,
} = {}) {
  for (const value of [observedBytes, coverageBytes, extendedBytes, safetyBytes]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid CI cache allocation.');
  }
  const baselineBytes = observedBytes + coverageBytes + extendedBytes + safetyBytes;
  return {
    observedBytes, coverageBytes, extendedBytes, safetyBytes,
    remainingProductionBytes: ACTIONS_CACHE_LIMIT_BYTES - baselineBytes,
    withinLimit: baselineBytes <= ACTIONS_CACHE_LIMIT_BYTES,
  };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
}

function usage() {
  process.stderr.write('Usage: node scripts/ci/cache-budget.mjs report|apply|allocation [--repo Cruel/nt]\n');
  process.exitCode = 2;
}

async function main(argv) {
  const [command, flag, value] = argv;
  if (command === 'window' && argv.length === 1) {
    process.stdout.write(`${rollingCacheWindow()}\n`);
    return;
  }
  if (command === 'generation' && argv.length === 1) {
    process.stdout.write(`${compilerCacheGeneration(process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT)}\n`);
    return;
  }
  if (command === 'refresh' && argv.length === 1) {
    process.stdout.write(`${shouldRefreshCompilerCache(readFileSync(0, 'utf8'), process.env.NOVELTEA_CCACHE_RESTORED === 'true')}\n`);
    return;
  }
  if (command === 'publisher' && argv.length === 1) {
    process.stdout.write(`${canPublishCompilerCache(process.env.GITHUB_EVENT_NAME, process.env.GITHUB_REF, process.env.GITHUB_REPOSITORY)}\n`);
    return;
  }
  if (!['report', 'apply', 'allocation'].includes(command) || (flag && flag !== '--repo') ||
      (flag && !value) || (!flag && value)) return usage();
  const repo = value ?? 'Cruel/nt';
  if (repo !== 'Cruel/nt') throw new Error('Cache maintenance is scoped to Cruel/nt only.');
  if (command === 'apply' && process.env.GITHUB_EVENT_NAME === 'pull_request') {
    throw new Error('PR jobs cannot prune trusted cache scopes.');
  }
  const entries = JSON.parse(gh(['cache', 'list', '--repo', repo, '--limit', '1000',
    '--json', 'id,key,ref,sizeInBytes,lastAccessedAt,createdAt']));
  let replacedCoveragePrefixes = [];
  if (command === 'apply') {
    const prefixes = new Set(entries.map(legacyCoverageCachePrefix).filter(Boolean));
    // Only trusted workflow_run events are authorized by the maintenance YAML.
    // Include the newest producer's snapshot prefix so superseded snapshots
    // can be compacted even after the legacy Actions cache has been retired.
    const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
    const run = event.workflow_run;
    if (run?.name === 'Coverage' && run.conclusion === 'success' && run.event === 'push' &&
        run.head_branch === 'master' && run.head_repository?.full_name === repo && Number.isSafeInteger(run.id)) {
      const artifacts = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`])).artifacts;
      for (const artifact of artifacts) {
        const prefix = artifact.name.replace(/^noveltea-coverage-ccache-/, '') + '-';
        if (validPrefix.test(prefix)) prefixes.add(prefix);
      }
    }
    for (const prefix of prefixes) {
      const snapshots = findCoverageSnapshots(prefix);
      if (snapshots.length === 0) continue;
      replacedCoveragePrefixes.push(prefix);
      process.stdout.write(`Coverage cache replacement: ${prefix} artifact ${snapshots[0].id} from trusted successful run ${snapshots[0].workflow_run.id}.\n`);
      // Keep two successful snapshots per exact compiler configuration. Other
      // artifacts and failed/foreign runs are never considered for deletion.
      for (const snapshot of snapshots.slice(2)) {
        gh(['api', '--method', 'DELETE', `repos/${repo}/actions/artifacts/${snapshot.id}`]);
        process.stdout.write(`Deleted superseded Coverage compiler snapshot artifact ${snapshot.id}.\n`);
      }
    }
  }
  const plan = planCachePrune(entries, DEFAULT_BUDGET_BYTES, replacedCoveragePrefixes);
  if (command === 'allocation') {
    const allocation = planCiCacheAllocation(plan.originalBytes);
    const remainingMiB = Math.floor(allocation.remainingProductionBytes / MiB);
    process.stdout.write(`Observed: ${(plan.originalBytes / GiB).toFixed(2)} GiB; Coverage incremental allowance: ${allocation.coverageBytes / MiB} MiB; Extended: restore-only; safety: 128 MiB; production budget before 10 GiB: ${remainingMiB} MiB.\n`);
    if (!allocation.withinLimit) process.exitCode = 1;
    return;
  }
  // Record the complete before-inventory, including IDs, so the next Build
  // can distinguish eviction from deliberate generation pruning.
  if (command === 'apply') process.stdout.write(`Cache inventory before prune: ${JSON.stringify(entries)}\n`);
  const fmt = (bytes) => `${(bytes / GiB).toFixed(2)} GiB`;
  process.stdout.write(`GitHub Actions cache: ${fmt(plan.originalBytes)} observed; ${fmt(plan.projectedBytes)} after ${plan.deleteIds.length} safe superseded-generation prunes; budget ${fmt(plan.budgetBytes)}.\n`);
  if (command === 'apply') {
    for (const id of plan.deleteIds) {
      gh(['cache', 'delete', String(id), '--repo', repo]);
      process.stdout.write(`Deleted superseded cache ID ${id}.\n`);
    }
    const remaining = JSON.parse(gh(['cache', 'list', '--repo', repo, '--limit', '1000',
      '--json', 'id,key,ref,sizeInBytes,lastAccessedAt,createdAt']));
    const occupied = remaining.reduce((bytes, entry) => bytes + entry.sizeInBytes, 0);
    process.stdout.write(`Observed cache occupancy after prune: ${fmt(occupied)}.\nCache inventory after prune: ${JSON.stringify(remaining)}\n`);
    if (occupied > plan.budgetBytes) process.exitCode = 1;
  } else if (!plan.satisfied) {
    process.stderr.write('WARNING: Safe duplicate-only pruning cannot reach the budget; review unique cache scopes.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Cache maintenance failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
