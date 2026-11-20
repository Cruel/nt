#!/usr/bin/env node
// Audit and safely prune superseded immutable GitHub Actions caches. Never delete the
// most recently used generation of any compatibility scope just to satisfy a quota.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const GiB = 1024 ** 3;
export const DEFAULT_BUDGET_BYTES = Math.floor(9.5 * GiB);

export function rollingCacheWindow(date = new Date()) {
  const utc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  // Weeks start on Monday; unlike commit-SHA keys this creates at most one new generation/week.
  const day = new Date(utc).getUTCDay();
  return `w${Math.floor((utc - ((day + 6) % 7) * 86400000) / (7 * 86400000))}`;
}

export function canPublishCompilerCache(event, ref, repository) {
  return event === 'push' && repository === 'Cruel/nt' &&
    (ref === 'refs/heads/master' || ref === 'refs/heads/ci/build-release-refactor-641' ||
      /^refs\/tags\/v[0-9]/.test(ref));
}

function family(key) {
  // Do not infer compatibility for keys without an explicitly recognized rotation suffix.
  const match = /^(.*)-(?:[a-f0-9]{40}|w\d{4,})$/.exec(key);
  return match?.[1];
}

export function planCachePrune(entries, budgetBytes = DEFAULT_BUDGET_BYTES) {
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
  const groups = new Map();
  for (const entry of cacheEntries) {
    const name = family(entry.key);
    if (!name) continue;
    const group = groups.get(name) ?? [];
    group.push(entry);
    groups.set(name, group);
  }
  const eligible = [];
  const protectedIds = [];
  for (const group of groups.values()) {
    group.sort((a, b) => Date.parse(a.lastAccessedAt) - Date.parse(b.lastAccessedAt) || a.id - b.id);
    eligible.push(...group.slice(0, -1));
    protectedIds.push(group.at(-1).id);
  }
  for (const entry of cacheEntries) {
    if (!family(entry.key)) protectedIds.push(entry.id);
  }
  eligible.sort((a, b) => Date.parse(a.lastAccessedAt) - Date.parse(b.lastAccessedAt) || a.id - b.id);
  let projectedBytes = originalBytes;
  const deleteIds = [];
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

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
}

function usage() {
  process.stderr.write('Usage: node scripts/ci/cache-budget.mjs report|apply [--repo Cruel/nt]\n');
  process.exitCode = 2;
}

async function main(argv) {
  const [command, flag, value] = argv;
  if (command === 'window' && argv.length === 1) {
    process.stdout.write(`${rollingCacheWindow()}\n`);
    return;
  }
  if (command === 'publisher' && argv.length === 1) {
    process.stdout.write(`${canPublishCompilerCache(process.env.GITHUB_EVENT_NAME, process.env.GITHUB_REF, process.env.GITHUB_REPOSITORY)}\n`);
    return;
  }
  if (!['report', 'apply'].includes(command) || (flag && flag !== '--repo') ||
      (flag && !value) || (!flag && value)) return usage();
  const repo = value ?? 'Cruel/nt';
  if (repo !== 'Cruel/nt') throw new Error('Cache maintenance is scoped to Cruel/nt only.');
  if (command === 'apply' && process.env.GITHUB_EVENT_NAME === 'pull_request') {
    throw new Error('PR jobs cannot prune trusted cache scopes.');
  }
  const entries = JSON.parse(gh(['cache', 'list', '--repo', repo, '--limit', '1000',
    '--json', 'id,key,sizeInBytes,lastAccessedAt']));
  const plan = planCachePrune(entries);
  const fmt = (bytes) => `${(bytes / GiB).toFixed(2)} GiB`;
  process.stdout.write(`GitHub Actions cache: ${fmt(plan.originalBytes)} observed; ${fmt(plan.projectedBytes)} after ${plan.deleteIds.length} safe superseded-generation prunes; budget ${fmt(plan.budgetBytes)}.\n`);
  if (command === 'apply') {
    for (const id of plan.deleteIds) {
      gh(['cache', 'delete', String(id), '--repo', repo]);
      process.stdout.write(`Deleted superseded cache ID ${id}.\n`);
    }
    const remaining = JSON.parse(gh(['cache', 'list', '--repo', repo, '--limit', '1000',
      '--json', 'id,key,sizeInBytes,lastAccessedAt']));
    const occupied = remaining.reduce((bytes, entry) => bytes + entry.sizeInBytes, 0);
    process.stdout.write(`Observed cache occupancy after prune: ${fmt(occupied)}.\n`);
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
