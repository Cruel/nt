import { describe, expect, it } from 'vitest';
import { certifyTemplateDescriptor, PLATFORM_CERTIFICATION_FORMAT, PLATFORM_CERTIFICATION_FORMAT_VERSION, type PlatformCertificationReport } from '../../shared/project-schema/platform-export-certification';
import { parseTemplateDescriptor } from '../../shared/project-schema/platform-export-contracts';

const descriptor = parseTemplateDescriptor({
  format: 'noveltea.player-template', formatVersion: 1, templateId: 'web-wasm32-release', buildId: 'build-1', engineVersion: '1.0.0',
  platform: 'web', architecture: 'wasm32', buildFlavor: 'release', minimumPlatformVersion: 'Chrome 121',
  graphicsBackends: ['webgl2'], shaderVariants: ['essl-300'], runtimePackageApi: { minimum: 1, maximum: 1 }, playerConfigApi: { minimum: 1, maximum: 1 },
  capabilities: ['network.client'], compiledFeatures: [], packageAccessModes: ['web-fetch'], host: { assembly: 'any', requiresToolchain: false, tools: [] },
  files: [{ path: 'player.js', role: 'player', size: 1, sha256: 'a'.repeat(64), mode: 420 }], runtimeDependencies: [],
  artifacts: { archive: 'player.zip', symbols: 'symbols.zip', sbom: 'sbom.json', notices: 'notices.txt' }, provenance: { provider: 'local', source: 'test' },
});

const checks = ['artifact-claims','descriptor-file-roles','runtime-closure','grouped-transaction-rollback','fixture-launch','input','rendering','rmlui','lua','fonts','images','audio','navigation','save-reload','clean-shutdown','fatal-startup-diagnostics','compatible-update','incompatible-api-rejected','debug-release-separation','development-surfaces-absent','symbols-build-id','third-party-notices','sbom','reproducibility','web-root-path','web-subdirectory-path','web-persistence','web-two-games-one-origin','web-service-worker-update','web-system-assets'];
const report = (): PlatformCertificationReport => ({
  format: PLATFORM_CERTIFICATION_FORMAT, formatVersion: PLATFORM_CERTIFICATION_FORMAT_VERSION, generatedAt: '2026-07-11T12:00:00.000Z',
  template: { templateId: descriptor.templateId, buildId: descriptor.buildId, target: descriptor.platform, architecture: descriptor.architecture, buildFlavor: descriptor.buildFlavor, descriptorSha256: 'd'.repeat(64), archiveSha256: 'e'.repeat(64), sourceRevision: 'commit-1' },
  fixture: { id: 'platform-export-acceptance', revision: 'fixture-1', sha256: 'b'.repeat(64) },
  exercised: {
    packageApis: [1], playerConfigApis: [1], capabilities: ['network.client'], artifactFormats: ['directory', 'zip'],
    graphicsBackends: ['webgl2'], shaderVariants: ['essl-300'], compiledFeatures: [], packageAccessModes: ['web-fetch'],
  },
  evidence: checks.map((check) => ({ check, status: 'passed', detail: 'CI evidence recorded', artifact: 'report.json', artifactSha256: 'c'.repeat(64), producer: 'github-actions/test', command: 'pnpm test' })), hostGaps: [],
});

describe('platform export certification gate', () => {
  it('certifies only complete evidence matching descriptor claims', () => expect(certifyTemplateDescriptor(descriptor, report())).toEqual({ certified: true, diagnostics: [] }));
  it('rejects an unexercised claim and a skipped launch check', () => {
    const value = report(); value.exercised.capabilities = []; value.evidence.find((item) => item.check === 'fixture-launch')!.status = 'skipped';
    const result = certifyTemplateDescriptor(descriptor, value);
    expect(result.certified).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining(['certification-capability-unexercised', 'certification-check-not-passed']));
  });
  it('treats documented host gaps as non-certified rather than silently green', () => {
    const value = report(); value.hostGaps = [{ check: 'macos-notarization', reason: 'Linux host' }];
    expect(certifyTemplateDescriptor(descriptor, value).diagnostics).toContainEqual(expect.objectContaining({ code: 'certification-host-gap' }));
  });
});
