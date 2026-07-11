import { describe, expect, it } from 'vitest';
import { evaluateTemplateCompatibility } from '../../shared/project-schema/template-compatibility';
import { parsePlatformExportProfile, parseTemplateDescriptor } from '../../shared/project-schema/platform-export-contracts';

const sha = 'a'.repeat(64);
const descriptor = parseTemplateDescriptor({ format: 'noveltea.player-template', formatVersion: 1, templateId: 'linux-x64-release', buildId: 'one', engineVersion: '1', platform: 'linux', architecture: 'x64', minimumPlatformVersion: 'glibc 2.35', graphicsBackends: ['opengl'], shaderVariants: ['glsl-120'], runtimePackageApi: { minimum: 1, maximum: 2 }, playerConfigApi: { minimum: 1, maximum: 1 }, compiledFeatures: ['lua'], capabilities: ['gamepad'], buildFlavor: 'release', packageAccessModes: ['sidecar'], files: [{ path: 'bin/player', size: 1, mode: 493, sha256: sha }], runtimeDependencies: [{ path: 'bin/player', kind: 'library' }], artifacts: { archive: 'player.tar.gz', symbols: 'symbols.tar.gz', sbom: 'SBOM.cdx.json', notices: 'NOTICE.txt' }, provenance: { provider: 'local', source: 'test' }, host: { assembly: 'any', requiresToolchain: false, tools: [] } });
const profile = parsePlatformExportProfile({ format: 'noveltea.platform-export-profile', formatVersion: 1, id: 'linux', label: 'Linux', target: 'linux', architecture: 'x64', buildFlavor: 'release', packageAccess: 'sidecar', desktop: { artifact: 'tar', executableName: 'game' } });

describe('template compatibility', () => {
  it('accepts a complete match', () => expect(evaluateTemplateCompatibility(descriptor, { profile, runtimePackageApi: 1, playerConfigApi: 1, shaderVariants: ['glsl-120'], graphicsBackends: ['opengl'], capabilities: ['gamepad'], requiredFeatures: ['lua'] }).compatible).toBe(true));
  it('reports each incompatible contract dimension', () => {
    const incompatibleProfile = parsePlatformExportProfile({ ...profile, architecture: 'arm64', buildFlavor: 'debug', packageAccess: 'bundle-resource' });
    const result = evaluateTemplateCompatibility(descriptor, { profile: incompatibleProfile, runtimePackageApi: 3, playerConfigApi: 2, shaderVariants: ['essl-300'], graphicsBackends: ['vulkan'], capabilities: ['microphone'], requiredFeatures: ['rmlui'], host: { platform: 'windows', availableTools: [] } });
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining(['template-architecture-mismatch', 'template-flavor-mismatch', 'template-package-access-mismatch', 'template-runtime-package-api-mismatch', 'template-player-config-api-mismatch', 'template-shader-variant-mismatch', 'template-renderer-mismatch', 'template-capability-mismatch', 'template-feature-mismatch']));
  });
});
