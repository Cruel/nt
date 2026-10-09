import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { createHash } from 'node:crypto';

const roots: string[] = [];
const collector = path.resolve(process.cwd(), '../scripts/platform-certification-results.mjs');
const certification = path.resolve(process.cwd(), '../scripts/platform-certification.mjs');
const fixture = path.resolve(
  process.cwd(),
  'src/shared/project-schema/platform-export-acceptance-fixture.ts',
);
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const sourceRevision = process.env.GITHUB_SHA ?? 'test-source-revision';

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function setup(corruptLicenseIndex = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'noveltea-cert-results-'));
  roots.push(root);
  const dist = path.join(root, 'dist');
  const stageName = 'web-wasm32-release';
  const stage = path.join(root, stageName);
  mkdirSync(path.join(stage, 'licenses'), { recursive: true });
  writeFileSync(path.join(stage, 'player.js'), 'x');
  writeFileSync(
    path.join(stage, 'SBOM.cdx.json'),
    `${JSON.stringify({
      bomFormat: 'CycloneDX',
      specVersion: '1.6',
      version: 1,
      components: [{ type: 'library', name: 'fixture-lib', version: '1.0' }],
    })}\n`,
  );
  const licensePath = 'licenses/fixture-lib--license.txt';
  const licenseText = 'MIT License\nCopyright (c) Fixture\n\fAdditional page\n';
  writeFileSync(path.join(stage, licensePath), licenseText);
  writeFileSync(
    path.join(stage, 'licenses/index.json'),
    `${JSON.stringify({
      format: 'noveltea.engine-licenses',
      components: [
        {
          component: 'fixture-lib',
          displayName: 'Fixture Library',
          version: '1.0',
          files: [
            {
              path: licensePath,
              size: Buffer.byteLength(licenseText),
              sha256: corruptLicenseIndex ? '0'.repeat(64) : sha256(licenseText),
            },
          ],
        },
      ],
    })}\n`,
  );
  const files = ['player.js', 'SBOM.cdx.json', licensePath, 'licenses/index.json'].map(
    (relative) => {
      const data = readFileSync(path.join(stage, relative));
      return {
        path: relative,
        size: data.length,
        mode: 0o644,
        sha256: sha256(data),
        role:
          relative === 'player.js'
            ? 'player'
            : relative.startsWith('licenses/')
              ? 'notice'
              : 'support',
      };
    },
  );
  const archiveName = 'noveltea-player-template-v1.0.0-web-wasm32-release.zip';
  const symbolName = 'noveltea-player-symbols-v1.0.0-web-wasm32-release.zip';
  const descriptor = {
    format: 'noveltea.player-template',
    formatVersion: 1,
    templateId: 'web-wasm32-release',
    buildId: 'v1.0.0-web-wasm32-release',
    engineVersion: 'v1.0.0',
    platform: 'web',
    architecture: 'wasm32',
    buildFlavor: 'release',
    minimumPlatformVersion: 'test',
    graphicsBackends: ['webgl2'],
    shaderVariants: ['essl-300'],
    compiledProjectFormatVersion: 1,
    playerRuntimeApiVersion: 1,
    capabilities: [],
    compiledFeatures: ['web-single-threaded'],
    packageAccessModes: ['web-fetch'],
    files,
    runtimeDependencies: [
      { path: 'player.js', kind: 'library' },
      { path: licensePath, kind: 'notice' },
      { path: 'licenses/index.json', kind: 'notice' },
    ],
    artifacts: {
      archive: archiveName,
      symbols: symbolName,
      sbom: 'SBOM.cdx.json',
      notices: 'licenses/index.json',
    },
    provenance: { provider: 'local', source: 'test' },
    host: { assembly: 'any', requiresToolchain: false, tools: [] },
  };
  writeFileSync(path.join(stage, 'template.json'), `${JSON.stringify(descriptor)}\n`);
  mkdirSync(dist, { recursive: true });
  const archive = path.join(dist, archiveName);
  execFileSync('cmake', ['-E', 'tar', 'cf', archive, '--format=zip', stageName], { cwd: root });

  const symbolStageName = `symbols-${descriptor.buildId}`;
  const symbolStage = path.join(root, symbolStageName);
  mkdirSync(symbolStage);
  writeFileSync(path.join(symbolStage, 'BUILD_ID'), `${descriptor.buildId}\n`);
  writeFileSync(path.join(symbolStage, 'player.wasm.debug.wasm'), 'symbols');
  execFileSync(
    'cmake',
    ['-E', 'tar', 'cf', path.join(dist, symbolName), '--format=zip', symbolStageName],
    {
      cwd: root,
    },
  );

  const packageSha = 'a'.repeat(64);
  const nestedPackageSha = 'e'.repeat(64);
  const canonical = path.join(dist, 'canonical.json');
  writeFileSync(
    canonical,
    `${JSON.stringify({
      format: 'noveltea-canonical-export-fixture',
      formatVersion: 1,
      fixtureRevision: 'fixture-1',
      sourceRevision,
      target: 'web',
      architecture: 'wasm32',
      buildFlavor: 'release',
      profileSha256: 'b'.repeat(64),
      projectSha256: 'c'.repeat(64),
      runtimePackageSha256: packageSha,
      outputManifestSha256: 'd'.repeat(64),
      compiledProjectFormatVersion: 1,
      playerRuntimeApiVersion: 1,
      packageAccessMode: 'web-fetch',
      webBasePath: '/',
      webThreaded: false,
      templateId: descriptor.templateId,
      templateBuildId: descriptor.buildId,
    })}\n`,
  );
  const nestedCanonical = path.join(dist, 'nested-canonical.json');
  writeFileSync(
    nestedCanonical,
    `${JSON.stringify({
      format: 'noveltea-canonical-export-fixture',
      formatVersion: 1,
      fixtureRevision: 'fixture-1',
      sourceRevision,
      target: 'web',
      architecture: 'wasm32',
      buildFlavor: 'release',
      profileSha256: 'f'.repeat(64),
      projectSha256: '1'.repeat(64),
      runtimePackageSha256: nestedPackageSha,
      outputManifestSha256: '2'.repeat(64),
      compiledProjectFormatVersion: 1,
      playerRuntimeApiVersion: 1,
      packageAccessMode: 'web-fetch',
      webBasePath: '/nested/game/',
      webThreaded: false,
      templateId: descriptor.templateId,
      templateBuildId: descriptor.buildId,
    })}\n`,
  );
  const browser = path.join(dist, 'browser.json');
  writeFileSync(
    browser,
    `${JSON.stringify({
      format: 'noveltea.web-export-browser-certification',
      results: [
        {
          label: 'single-root',
          basePath: '/',
          packageSha256: packageSha,
          launchGestureGated: true,
        },
        {
          label: 'single-nested',
          basePath: '/nested/game/',
          packageSha256: nestedPackageSha,
          launchGestureGated: true,
        },
      ],
    })}\n`,
  );
  const results = path.join(dist, 'results.json');
  const report = path.join(dist, 'report.json');
  const collectArgs = [
    collector,
    '--archive',
    archive,
    '--canonical-evidence',
    canonical,
    '--nested-canonical-evidence',
    nestedCanonical,
    '--web-browser',
    browser,
    '--web-case-prefix',
    'single',
    '--output',
    results,
  ];
  return { root, archive, browser, results, report, collectArgs };
}

function setupAndroid(corruptLicense = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'noveltea-cert-results-android-'));
  roots.push(root);
  const dist = path.join(root, 'dist');
  const stageName = 'android-arm64-v8a-release';
  const stage = path.join(root, stageName);
  mkdirSync(path.join(stage, 'licenses'), { recursive: true });
  mkdirSync(path.join(stage, 'source/android/prebuilt-native/arm64-v8a'), { recursive: true });
  writeFileSync(
    path.join(stage, 'source/android/prebuilt-native/arm64-v8a/libnoveltea-player.so'),
    'native',
  );
  writeFileSync(
    path.join(stage, 'SBOM.cdx.json'),
    `${JSON.stringify({
      bomFormat: 'CycloneDX',
      specVersion: '1.6',
      version: 1,
      components: [{ type: 'library', name: 'fixture-lib', version: '1.0' }],
    })}\n`,
  );
  const licensePath = 'licenses/fixture-lib--license.txt';
  const licenseText = corruptLicense
    ? 'PLACEHOLDER LICENSE\n'
    : 'MIT License\nCopyright (c) Fixture\n';
  writeFileSync(path.join(stage, licensePath), licenseText);
  writeFileSync(
    path.join(stage, 'licenses/index.json'),
    `${JSON.stringify({
      format: 'noveltea.engine-licenses',
      components: [
        {
          component: 'fixture-lib',
          displayName: 'Fixture Library',
          version: '1.0',
          files: [
            {
              path: licensePath,
              size: Buffer.byteLength(licenseText),
              sha256: sha256(licenseText),
            },
          ],
        },
      ],
    })}\n`,
  );
  const relativeFiles = [
    'source/android/prebuilt-native/arm64-v8a/libnoveltea-player.so',
    'SBOM.cdx.json',
    licensePath,
    'licenses/index.json',
  ];
  const files = relativeFiles.map((relative) => {
    const data = readFileSync(path.join(stage, relative));
    return {
      path: relative,
      size: data.length,
      mode: 0o644,
      sha256: sha256(data),
      role: relative.startsWith('licenses/')
        ? 'notice'
        : relative.endsWith('.so')
          ? 'native-dependency'
          : 'support',
    };
  });
  const archiveName = 'noveltea-player-template-v1.0.0-android-arm64-v8a-release.tar.gz';
  const symbolName = 'noveltea-player-symbols-v1.0.0-android-arm64-v8a-release.zip';
  const descriptor = {
    format: 'noveltea.player-template',
    formatVersion: 1,
    templateId: stageName,
    buildId: `v1.0.0-${stageName}`,
    engineVersion: 'v1.0.0',
    platform: 'android',
    architecture: 'arm64',
    abi: 'arm64-v8a',
    buildFlavor: 'release',
    minimumPlatformVersion: 'Android API 24',
    graphicsBackends: ['opengles'],
    shaderVariants: ['essl-300'],
    compiledProjectFormatVersion: 1,
    playerRuntimeApiVersion: 1,
    capabilities: [],
    compiledFeatures: ['android-private-copy'],
    packageAccessModes: ['android-private-copy'],
    files,
    runtimeDependencies: [
      { path: licensePath, kind: 'notice' },
      { path: 'licenses/index.json', kind: 'notice' },
    ],
    artifacts: {
      archive: archiveName,
      symbols: symbolName,
      sbom: 'SBOM.cdx.json',
      notices: 'licenses/index.json',
    },
    provenance: { provider: 'local', source: 'test' },
    host: { assembly: 'any', requiresToolchain: true, tools: ['java', 'android-sdk'] },
    android: {
      supportedAbis: ['arm64-v8a'],
      artifactKinds: ['apk', 'aab'],
      packageAccessModes: ['android-private-copy'],
    },
  };
  writeFileSync(path.join(stage, 'template.json'), `${JSON.stringify(descriptor)}\n`);
  mkdirSync(dist, { recursive: true });
  const archive = path.join(dist, archiveName);
  execFileSync('cmake', ['-E', 'tar', 'czf', archive, stageName], { cwd: root });

  const symbolStageName = `symbols-${descriptor.buildId}`;
  const symbolStage = path.join(root, symbolStageName);
  mkdirSync(path.join(symbolStage, 'arm64-v8a'), { recursive: true });
  writeFileSync(path.join(symbolStage, 'BUILD_ID'), `${descriptor.buildId}\n`);
  writeFileSync(path.join(symbolStage, 'arm64-v8a/libnoveltea-player.so'), 'symbols');
  execFileSync(
    'cmake',
    ['-E', 'tar', 'cf', path.join(dist, symbolName), '--format=zip', symbolStageName],
    { cwd: root },
  );

  const canonical = path.join(dist, 'canonical.json');
  writeFileSync(
    canonical,
    `${JSON.stringify({
      format: 'noveltea-canonical-export-fixture',
      formatVersion: 1,
      fixtureRevision: 'fixture-android',
      sourceRevision,
      target: 'android',
      architecture: 'arm64',
      buildFlavor: 'release',
      profileSha256: '3'.repeat(64),
      projectSha256: '4'.repeat(64),
      runtimePackageSha256: '5'.repeat(64),
      outputManifestSha256: '6'.repeat(64),
      compiledProjectFormatVersion: 1,
      playerRuntimeApiVersion: 1,
      packageAccessMode: 'android-private-copy',
      templateId: descriptor.templateId,
      templateBuildId: descriptor.buildId,
    })}\n`,
  );
  const androidReport = path.join(dist, 'android-report.json');
  writeFileSync(
    androidReport,
    `${JSON.stringify({
      format: 'noveltea.android-export-report',
      template: { id: descriptor.templateId, buildId: descriptor.buildId },
      package: { sha256: '7'.repeat(64) },
      verification: {
        status: 'passed',
        abi: 'arm64-v8a',
        inspected: [{ kind: 'apk' }, { kind: 'aab', bundletool: 'passed' }],
      },
    })}\n`,
  );
  const alignment = path.join(dist, 'alignment.json');
  writeFileSync(
    alignment,
    `${JSON.stringify({
      format: 'noveltea-android-load-alignment',
      results: [{ abi: 'arm64-v8a', status: 'passed' }],
    })}\n`,
  );
  const results = path.join(dist, 'results.json');
  const report = path.join(dist, 'report.json');
  const collectArgs = [
    collector,
    '--archive',
    archive,
    '--canonical-evidence',
    canonical,
    '--android-report',
    androidReport,
    '--android-alignment',
    alignment,
    '--output',
    results,
  ];
  return { archive, androidReport, results, report, collectArgs };
}

function run(args: string[]) {
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

describe('platform certification results producer', () => {
  it('produces explicit Web evidence that passes the final certification verifier', () => {
    const value = setup();
    const collected = run(value.collectArgs);
    expect(collected.status, collected.stderr).toBe(0);
    const results = JSON.parse(readFileSync(value.results, 'utf8')) as {
      evidence: Array<{ check: string; artifact: string }>;
    };
    expect(results.evidence.map((item) => item.check)).toEqual(
      expect.arrayContaining([
        'artifact-claims',
        'canonical-export',
        'symbols-build-id',
        'web-browser-launch',
        'web-root-path',
        'web-subdirectory-path',
      ]),
    );
    expect(new Set(results.evidence.map((item) => item.artifact)).size).toBe(
      results.evidence.length,
    );

    const created = run([
      certification,
      'create',
      '--archive',
      value.archive,
      '--fixture',
      fixture,
      '--results',
      value.results,
      '--output',
      value.report,
      '--source-revision',
      'commit-1',
    ]);
    expect(created.status, created.stderr).toBe(0);
    const verified = run([
      certification,
      'verify',
      '--archive',
      value.archive,
      '--report',
      value.report,
    ]);
    expect(verified.status, verified.stderr).toBe(0);
  });

  it('fails closed when required browser evidence is incomplete', () => {
    const value = setup();
    const browser = JSON.parse(readFileSync(value.browser, 'utf8')) as { results: unknown[] };
    browser.results.pop();
    writeFileSync(value.browser, JSON.stringify(browser));
    const result = run(value.collectArgs);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing passing 'single-nested'");
  });

  it('rejects a license index inconsistent with the real text despite matching descriptor file hashes', () => {
    const value = setup(true);
    const result = run(value.collectArgs);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not match the template file inventory');
  });

  it('produces Android release evidence including conditional AAB bundletool proof', () => {
    const value = setupAndroid();
    const collected = run(value.collectArgs);
    expect(collected.status, collected.stderr).toBe(0);
    const results = JSON.parse(readFileSync(value.results, 'utf8')) as {
      evidence: Array<{ check: string }>;
    };
    expect(results.evidence.map((item) => item.check)).toEqual(
      expect.arrayContaining([
        'android-artifact-inspection',
        'android-abi-closure',
        'android-signature-policy',
        'android-page-alignment',
        'android-bundletool',
        'symbols-build-id',
      ]),
    );
    const created = run([
      certification,
      'create',
      '--archive',
      value.archive,
      '--fixture',
      fixture,
      '--results',
      value.results,
      '--output',
      value.report,
      '--source-revision',
      'commit-android',
    ]);
    expect(created.status, created.stderr).toBe(0);
    expect(
      run([certification, 'verify', '--archive', value.archive, '--report', value.report]).status,
    ).toBe(0);
  });

  it('rejects an Android template with inventory-only or placeholder license text', () => {
    const value = setupAndroid(true);
    const result = run(value.collectArgs);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Missing or placeholder engine license text');
  });

  it('fails closed when an AAB template lacks passing bundletool evidence', () => {
    const value = setupAndroid();
    const report = JSON.parse(readFileSync(value.androidReport, 'utf8')) as {
      verification: { inspected: Array<{ kind: string; bundletool?: string }> };
    };
    report.verification.inspected.find((item) => item.kind === 'aab')!.bundletool = 'failed';
    writeFileSync(value.androidReport, JSON.stringify(report));
    const result = run(value.collectArgs);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Android AAB bundletool verification did not pass.');
  });
});
