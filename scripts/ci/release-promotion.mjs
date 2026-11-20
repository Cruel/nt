#!/usr/bin/env node
// Authorize Release against independently authenticated, exact-source Build and
// Extended runs. Candidate bytes are verified again on each consuming runner.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCatalogCandidate, verifyTrustedProducerRun } from './release-candidate.mjs';
import { verifyTrustedQualificationRun } from './extended-qualification.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const owner = 'Cruel/nt';
const buildWorkflow = '.github/workflows/build.yml';
const extendedWorkflow = '.github/workflows/extended-qualification.yml';
const shaPattern = /^[a-f0-9]{40}$/;

export function demandSourceSha(sourceSha) {
  assert.match(sourceSha, shaPattern, 'Release must select one exact full source SHA');
}

export function releaseMayPublish(event, ref, sourceSha, tagSha) {
  demandSourceSha(sourceSha);
  assert.equal(tagSha, sourceSha, 'Release tag must resolve to the qualified source commit');
  return event === 'push' && /^refs\/tags\/v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?$/.test(ref);
}

export function requiredArtifacts(catalog) {
  const names = Object.keys(catalog.candidates)
    .map((id) => resolveCatalogCandidate(catalog, id).artifactName);
  return [...new Set([...names, 'noveltea-web-editor-preview',
    'noveltea-shader-assets',
    'noveltea-build-windows-tooling-bridge-release',
    'noveltea-build-windows-tooling-bridge-devtools'])];
}

export function validateTrustedBuild(run, sourceSha) {
  demandSourceSha(sourceSha);
  const manifest = {
    tier: 'production',
    sourceSha,
    producer: {
      repository: owner,
      workflow: 'Build',
      workflowPath: buildWorkflow,
      runId: run?.id,
      runAttempt: run?.run_attempt,
      event: 'push',
      ref: 'refs/heads/master',
    },
  };
  verifyTrustedProducerRun(manifest, run);
  return run.id;
}

export function checkBuildArtifacts(artifacts, required) {
  const byName = new Map();
  for (const artifact of artifacts) {
    if (!artifact?.name) continue;
    if (!byName.has(artifact.name)) byName.set(artifact.name, []);
    byName.get(artifact.name).push(artifact);
  }
  for (const name of required) {
    const matches = byName.get(name) ?? [];
    assert.equal(matches.length, 1, `Missing or duplicate exact Build candidate ${name}`);
    assert.equal(matches[0].expired, false, `Expired Build candidate ${name}`);
    assert.ok(Number.isSafeInteger(matches[0].id), `Invalid artifact ID for ${name}`);
    assert.ok(matches[0].size_in_bytes > 0, `Empty candidate artifact ${name}`);
  }
  return true;
}

export function validateTrustedExtended(receipt, run, sourceSha, buildRunId) {
  verifyTrustedQualificationRun(receipt, run, sourceSha);
  assert.equal(receipt.trustedBuildRunId, buildRunId,
    'Extended evidence did not qualify the selected Build producer');
  return run.id;
}

export class ActionsClient {
  constructor(token, request = fetch) {
    assert.ok(token, 'GH_TOKEN with Actions read/write permissions is required');
    this.token = token;
    this.request = request;
  }

  async call(route, options = {}) {
    const response = await this.request(`https://api.github.com/repos/${owner}/${route}`, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...options.headers,
      },
    });
    assert.ok(response.ok, `GitHub Actions API ${route}: HTTP ${response.status}`);
    if (response.status === 204) return null;
    return response.json();
  }

  async runs(workflow, params) {
    const result = [];
    for (let page = 1; page <= 10; page++) {
      const query = new URLSearchParams({ ...params, per_page: '100', page: String(page) });
      const pageRuns = (await this.call(`actions/workflows/${workflow}/runs?${query}`)).workflow_runs;
      assert.ok(Array.isArray(pageRuns), 'Invalid workflow run listing');
      result.push(...pageRuns);
      if (pageRuns.length < 100) break;
    }
    return result;
  }

  async artifacts(runId) {
    const result = [];
    for (let page = 1; page <= 10; page++) {
      const response = await this.call(`actions/runs/${runId}/artifacts?per_page=100&page=${page}`);
      assert.ok(Array.isArray(response.artifacts), 'Invalid Actions artifact listing');
      result.push(...response.artifacts);
      if (response.artifacts.length < 100) break;
    }
    return result;
  }

  async receipt(artifact) {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'noveltea-extended-'));
    try {
      const route = `https://api.github.com/repos/${owner}/actions/artifacts/${artifact.id}/zip`;
      const response = await this.request(route, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      assert.ok(response.ok, `Extended receipt download failed: HTTP ${response.status}`);
      const archive = path.join(temp, 'receipt.zip');
      await writeFile(archive, Buffer.from(await response.arrayBuffer()));
      const bytes = execFileSync('unzip', ['-p', archive, 'receipt.json'], {
        maxBuffer: 1024 * 1024, encoding: 'utf8',
      });
      assert.ok(bytes.length < 1024 * 1024, 'Extended receipt is too large');
      return JSON.parse(bytes);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  async dispatchExtended(sourceSha) {
    return this.call(`actions/workflows/extended-qualification.yml/dispatches`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'master', inputs: { sha: sourceSha } }),
    });
  }
}

export async function selectBuild(client, sourceSha, artifacts) {
  const runs = await client.runs('build.yml',
    { event: 'push', branch: 'master', head_sha: sourceSha, status: 'completed' });
  for (const run of runs) {
    try {
      validateTrustedBuild(run, sourceSha);
      checkBuildArtifacts(await client.artifacts(run.id), artifacts);
      return run;
    } catch (error) {
      process.stderr.write(`Rejected Build run ${run.id}: ${error.message}\n`);
    }
  }
  throw new Error(`No complete trusted master Build candidate for ${sourceSha}. Re-run the exact pinned canonical Build producer, then requalify; never rebuild only in Release.`);
}

export async function selectExtended(client, sourceSha, buildRunId, { after } = {}) {
  const runs = await client.runs('extended-qualification.yml', {
    branch: 'master', status: 'completed',
  });
  for (const run of runs) {
    if (after && new Date(run.created_at).getTime() < after) continue;
    try {
      const artifacts = await client.artifacts(run.id);
      const matches = artifacts.filter((item) =>
        item.name === 'noveltea-extended-qualification' && !item.expired);
      if (matches.length !== 1) continue;
      const receipt = await client.receipt(matches[0]);
      validateTrustedExtended(receipt, run, sourceSha, buildRunId);
      return run;
    } catch (error) {
      process.stderr.write(`Rejected Extended run ${run.id}: ${error.message}\n`);
    }
  }
  return null;
}

export async function waitForExtended(client, sourceSha, buildRunId, {
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxPolls = 180,
} = {}) {
  const after = Date.now() - 30_000;
  await client.dispatchExtended(sourceSha);
  for (let poll = 0; poll < maxPolls; poll++) {
    await sleep(60_000);
    const qualified = await selectExtended(client, sourceSha, buildRunId, { after });
    if (qualified) return qualified;
    const recent = await client.runs('extended-qualification.yml', {
      branch: 'master', event: 'workflow_dispatch',
    });
    if (recent.some((run) => new Date(run.created_at).getTime() >= after &&
      run.status === 'completed' && run.conclusion !== 'success')) {
      throw new Error('On-demand Extended Qualification failed; publication is forbidden');
    }
  }
  throw new Error('Exact-SHA Extended Qualification did not complete; publication is forbidden');
}

export async function verifyPinnedAuthority(client, authority, sourceSha, catalog) {
  demandSourceSha(sourceSha);
  assert.equal(authority?.format, 'noveltea-release-authority');
  assert.equal(authority?.version, 1);
  assert.equal(authority?.sourceSha, sourceSha);
  for (const key of ['buildRunId', 'buildRunAttempt', 'extendedRunId', 'extendedRunAttempt']) {
    assert.ok(Number.isSafeInteger(authority[key]) && authority[key] > 0,
      `Invalid pinned release authority: ${key}`);
  }
  const build = await client.call(`actions/runs/${authority.buildRunId}`);
  validateTrustedBuild(build, sourceSha);
  assert.equal(build.run_attempt, authority.buildRunAttempt,
    'Selected Build producer attempt changed');
  checkBuildArtifacts(await client.artifacts(build.id), requiredArtifacts(catalog));
  const extended = await client.call(`actions/runs/${authority.extendedRunId}`);
  assert.equal(extended.run_attempt, authority.extendedRunAttempt,
    'Selected Extended Qualification attempt changed');
  const artifacts = await client.artifacts(extended.id);
  const exact = artifacts.filter((item) =>
    item.name === 'noveltea-extended-qualification' && !item.expired);
  assert.equal(exact.length, 1, 'Pinned Extended Qualification evidence is missing or expired');
  const receipt = await client.receipt(exact[0]);
  validateTrustedExtended(receipt, extended, sourceSha, build.id);
  return authority;
}

export async function authorizeRelease(client, { sourceSha, catalog, requestExtended = true }) {
  demandSourceSha(sourceSha);
  const build = await selectBuild(client, sourceSha, requiredArtifacts(catalog));
  const extended = await selectExtended(client, sourceSha, build.id) ??
    (requestExtended ? await waitForExtended(client, sourceSha, build.id) : null);
  assert.ok(extended, `No successful exact-SHA Extended Qualification for ${sourceSha}`);
  return {
    format: 'noveltea-release-authority', version: 1,
    sourceSha, buildRunId: build.id, buildRunAttempt: build.run_attempt,
    extendedRunId: extended.id, extendedRunAttempt: extended.run_attempt,
  };
}

async function main() {
  const [command, sourceSha] = process.argv.slice(2);
  assert.ok(['authorize', 'verify'].includes(command), 'Usage: release-promotion.mjs authorize|verify <source-sha>');
  demandSourceSha(sourceSha);
  const actualSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  assert.equal(actualSha, sourceSha, 'Release checkout differs from source SHA');
  const catalog = JSON.parse(await readFile(path.join(repo, 'scripts/ci/release-candidates.json'), 'utf8'));
  const client = new ActionsClient(process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN);
  const output = path.join(repo, 'build/release-authority.json');
  if (command === 'authorize') {
    const authority = await authorizeRelease(client, { sourceSha, catalog });
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(authority, null, 2) + '\n');
    if (process.env.GITHUB_OUTPUT) {
      const { buildRunId, extendedRunId } = authority;
      const fs = await import('node:fs/promises');
      await fs.appendFile(process.env.GITHUB_OUTPUT,
        `build_run_id=${buildRunId}\nextended_run_id=${extendedRunId}\n`);
    }
  } else {
    const previous = JSON.parse(await readFile(output, 'utf8'));
    await verifyPinnedAuthority(client, previous, sourceSha, catalog);
  }
  process.stdout.write(`Release authorization verified for ${sourceSha}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Release denied: ${error.message}\n`);
    process.exitCode = 1;
  });
}
