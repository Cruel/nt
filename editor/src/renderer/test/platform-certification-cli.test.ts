import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const script = path.resolve(process.cwd(), '../scripts/platform-certification.mjs');
const fixture = path.resolve(process.cwd(), 'src/shared/project-schema/platform-export-acceptance-fixture.ts');
const checks = [
  'artifact-claims', 'descriptor-file-roles', 'runtime-closure', 'grouped-transaction-rollback',
  'fixture-launch', 'input', 'rendering', 'rmlui', 'lua', 'fonts', 'images', 'audio', 'navigation',
  'save-reload', 'clean-shutdown', 'fatal-startup-diagnostics', 'compatible-update',
  'incompatible-api-rejected', 'debug-release-separation', 'development-surfaces-absent',
  'symbols-build-id', 'third-party-notices', 'sbom', 'reproducibility', 'web-root-path',
  'web-subdirectory-path', 'web-persistence', 'web-two-games-one-origin',
  'web-service-worker-update', 'web-system-assets',
] as const;

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'noveltea-cert-cli-'));
  roots.push(root);
  const templateRoot = path.join(root, 'template');
  mkdirSync(templateRoot);
  const descriptor = {
    format: 'noveltea.player-template', formatVersion: 1, templateId: 'web-wasm32-release', buildId: 'build-1', engineVersion: '1.0.0',
    platform: 'web', architecture: 'wasm32', buildFlavor: 'release', minimumPlatformVersion: 'Chrome 121',
    graphicsBackends: ['webgl2'], shaderVariants: ['essl-300'], runtimePackageApi: { minimum: 1, maximum: 1 }, playerConfigApi: { minimum: 1, maximum: 1 },
    capabilities: ['network.client'], compiledFeatures: [], packageAccessModes: ['web-fetch'], host: { assembly: 'any', requiresToolchain: false, tools: [] },
    files: [{ path: 'player.js', role: 'player', size: 1, sha256: 'a'.repeat(64), mode: 420 }], runtimeDependencies: [],
    artifacts: { archive: 'player.zip', symbols: 'symbols.zip', sbom: 'sbom.json', notices: 'notices.txt' }, provenance: { provider: 'local', source: 'test' },
  };
  writeFileSync(path.join(templateRoot, 'template.json'), `${JSON.stringify(descriptor)}\n`);
  const archive = path.join(root, 'template.zip');
  execFileSync('cmake', ['-E', 'tar', 'cf', archive, '--format=zip', 'template.json'], { cwd: templateRoot });
  const evidenceRoot = path.join(root, 'evidence');
  mkdirSync(evidenceRoot);
  const environment = { workflow: 'release', runId: '42', job: 'web', runnerOs: 'Linux', runnerArch: 'X64', target: 'web' };
  const evidence = checks.map((check, index) => {
    const artifact = path.join(evidenceRoot, `${index}-${check}.json`);
    writeFileSync(artifact, `${JSON.stringify({ check, passed: true })}\n`);
    return {
      check, status: 'passed', detail: `${check} passed`, test: `certification/${check}`, target: 'web', artifact,
      producer: 'github-actions/release/web', command: `pnpm test -- ${check}`, environment,
    };
  });
  const results = {
    format: 'noveltea-platform-certification-results', formatVersion: 1,
    fixtureRevision: 'fixture-1', runtimePackageSha256: 'b'.repeat(64), profileSha256: 'c'.repeat(64), environment,
    exercised: {
      packageApis: [1], playerConfigApis: [1], capabilities: ['network.client'], artifactFormats: ['directory', 'zip'],
      graphicsBackends: ['webgl2'], shaderVariants: ['essl-300'], compiledFeatures: [], packageAccessModes: ['web-fetch'],
    },
    evidence, hostGaps: [],
  };
  const resultsPath = path.join(root, 'results.json');
  const reportPath = path.join(root, 'report.json');
  writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  const createArgs = ['create', '--archive', archive, '--fixture', fixture, '--results', resultsPath, '--output', reportPath, '--source-revision', 'commit-1'];
  return { root, archive, results, resultsPath, reportPath, createArgs };
}

function run(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

describe('platform certification CLI fail-closed behavior', () => {
  it('creates and verifies a report only from complete explicit per-check results', () => {
    const value = setup();
    expect(run(value.createArgs).status).toBe(0);
    expect(run(['verify', '--archive', value.archive, '--report', value.reportPath]).status).toBe(0);
  });

  it('rejects a missing or failed required check', () => {
    const missing = setup();
    missing.results.evidence.pop();
    writeFileSync(missing.resultsPath, JSON.stringify(missing.results));
    const missingResult = run(missing.createArgs);
    expect(missingResult.status).not.toBe(0);
    expect(missingResult.stderr).toContain('Missing evidence');

    const failed = setup();
    failed.results.evidence[0]!.status = 'failed';
    writeFileSync(failed.resultsPath, JSON.stringify(failed.results));
    const failedResult = run(failed.createArgs);
    expect(failedResult.status).not.toBe(0);
    expect(failedResult.stderr).toContain('is failed');
  });

  it('rejects one generic artifact reused by unrelated checks', () => {
    const value = setup();
    value.results.evidence[1]!.artifact = value.results.evidence[0]!.artifact;
    writeFileSync(value.resultsPath, JSON.stringify(value.results));
    const result = run(value.createArgs);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('reused by unrelated checks');
  });

  it('rejects tampered raw evidence during verification', () => {
    const value = setup();
    expect(run(value.createArgs).status).toBe(0);
    const report = JSON.parse(readFileSync(value.reportPath, 'utf8')) as { evidence: Array<{ artifact: string }> };
    const artifact = path.resolve(path.dirname(value.reportPath), report.evidence[0]!.artifact);
    writeFileSync(artifact, 'tampered\n');
    const result = run(['verify', '--archive', value.archive, '--report', value.reportPath]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('hash mismatch');
  });
});
