// Coverage compiler snapshots are disposable optimization inputs, never correctness evidence.
// Only completed successful master pushes of the canonical Coverage workflow can seed a build.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const validPrefix = /^Linux-X64-ccache-v2-linux-debug-coverage-v3-[a-f0-9]{16}-[a-f0-9]{64}-$/;
export function snapshotName(prefix) {
  if (!validPrefix.test(prefix)) throw new Error('Invalid Coverage compiler compatibility prefix');
  return `noveltea-coverage-ccache-${prefix.slice(0, -1)}`;
}

export function trustedCoverageSnapshots(artifacts, runForId, prefix, now = Date.now()) {
  const name = snapshotName(prefix);
  const trusted = [];
  for (const a of artifacts) {
    const provenance = a.workflow_run;
    if (a.name !== name || a.expired || !(Date.parse(a.expires_at) > now) ||
        !Number.isSafeInteger(a.id) || !(a.size_in_bytes > 0) ||
        !Number.isSafeInteger(provenance?.id) || provenance.head_branch !== 'master') continue;
    const run = runForId(provenance.id);
    if (run?.id !== provenance.id || run.event !== 'push' || run.head_branch !== 'master' ||
        run.status !== 'completed' || run.conclusion !== 'success' ||
        run.head_repository?.full_name !== 'Cruel/nt' || run.repository?.full_name !== 'Cruel/nt' ||
        run.path !== '.github/workflows/coverage.yml' || run.head_sha !== provenance.head_sha) continue;
    trusted.push(a);
  }
  return trusted.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
}

function api(endpoint) {
  return JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8' }));
}
export function findCoverageSnapshots(prefix) {
  // Exact-name lookup across runs also finds an unchanged warm cache whose
  // producer is older than the most recent page of successful workflow runs.
  const name = snapshotName(prefix);
  const artifacts = api(`repos/Cruel/nt/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`).artifacts;
  const runs = new Map();
  return trustedCoverageSnapshots(artifacts, id => {
    if (!runs.has(id)) runs.set(id, api(`repos/Cruel/nt/actions/runs/${id}`));
    return runs.get(id);
  }, prefix);
}

export function legacyCoverageCachePrefix(entry) {
  if (entry.ref !== 'refs/heads/master') return null;
  const prefix = entry.key.replace(/(?:r[1-9]\d*-a[1-9]\d*|w\d{4,})$/, '');
  return validPrefix.test(prefix) ? prefix : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const prefix = process.argv[2];
  const [found] = findCoverageSnapshots(prefix);
  if (found) {
    const renew = Date.parse(found.expires_at) - Date.now() < 3 * 86400000;
    appendFileSync(process.env.GITHUB_OUTPUT, `artifact-id=${found.id}\nrun-id=${found.workflow_run.id}\nrenew=${renew}\n`);
  }
}
