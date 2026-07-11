import { describe, expect, it } from 'vitest';
import { buildPlatformDeployment, capabilityMetadata } from '../../shared/project-schema/platform-deployment';
import { parsePlatformExportProfile, PLATFORM_EXPORT_PROFILE_FORMAT, TEMPLATE_DESCRIPTOR_FORMAT } from '../../shared/project-schema/platform-export-contracts';

const profile = parsePlatformExportProfile({ format: PLATFORM_EXPORT_PROFILE_FORMAT, formatVersion: 1, id: 'web', label: 'Web', target: 'web', architecture: 'wasm32', packageAccess: 'web-fetch', buildFlavor: 'release', compression: 'default', includeDebugSymbols: false, capabilityOverrides: ['network.client'], web: { artifact: 'directory-zip', threaded: false, pwa: true } });
const descriptor = { format: TEMPLATE_DESCRIPTOR_FORMAT, formatVersion: 1 as const, templateId: 'web', buildId: '1', platform: 'web' as const, architecture: 'wasm32' as const, minimumPlatformVersion: 'modern', graphicsBackends: ['webgl2' as const], shaderVariants: ['essl-300' as const], runtimePackageApi: { minimum: 1, maximum: 1 }, compiledFeatures: [], capabilities: ['network.client' as const], buildFlavor: 'release' as const, runtimeDependencies: [], host: { assembly: 'any' as const, requiresToolchain: false, tools: [] } };

describe('platform deployment model', () => {
  it('derives deterministic platform metadata and preserves display metadata', () => {
    expect(capabilityMetadata(['network.client', 'vibration']).androidPermissions).toEqual(['android.permission.INTERNET', 'android.permission.VIBRATE']);
    const display = { aspectRatio: { width: 16, height: 9 }, orientation: 'landscape' as const, barColor: '#000000' };
    const result = buildPlatformDeployment({ operationId: 'op', profile, templateRoot: '/local/template', outputDirectory: '/local/out', packagePath: '/local/game.ntpkg', iconSourcePath: '/local/icon.png', identity: { displayName: 'Game', applicationId: 'com.example.game', saveNamespace: 'com.example.game', versionName: '1.0' }, display, capabilities: [], runtimePackageApi: 1 }, descriptor);
    expect(result.diagnostics).toEqual([]);
    expect(result.model?.display).toEqual(display);
    expect(result.model?.capabilityMetadata.webRequirements).toEqual(['network']);
  });

  it('blocks invalid identity, missing icon, and incompatible templates', () => {
    const result = buildPlatformDeployment({ operationId: 'op', profile, templateRoot: '', outputDirectory: '', packagePath: '', identity: { displayName: '', applicationId: 'bad', saveNamespace: 'bad', versionName: '1' }, display: { aspectRatio: { width: 1, height: 1 }, orientation: 'portrait', barColor: '#000000' }, runtimePackageApi: 2 }, { ...descriptor, platform: 'windows' });
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining(['invalid-app-identity', 'missing-icon', 'incompatible-template', 'incompatible-package-api']));
  });
});
