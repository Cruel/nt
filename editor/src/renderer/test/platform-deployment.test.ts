import { describe, expect, it } from 'vite-plus/test';
import {
  buildPlatformDeployment,
  capabilityMetadata,
  derivedPlatformCapabilities,
} from '../../shared/project-schema/platform-deployment';
import {
  parsePlatformExportProfile,
  PLATFORM_EXPORT_PROFILE_FORMAT,
  TEMPLATE_DESCRIPTOR_FORMAT,
} from '../../shared/project-schema/platform-export-contracts';

const profile = parsePlatformExportProfile({
  format: PLATFORM_EXPORT_PROFILE_FORMAT,
  id: 'web',
  label: 'Web',
  target: 'web',
  architecture: 'wasm32',
  packageAccess: 'web-fetch',
  buildFlavor: 'release',
  compression: 'default',
  includeDebugSymbols: false,
  web: { artifact: 'directory-zip', threaded: false, pwa: true },
});
const descriptor = {
  format: TEMPLATE_DESCRIPTOR_FORMAT,
  formatVersion: 1 as const,
  templateId: 'web',
  buildId: '1',
  engineVersion: '1',
  platform: 'web' as const,
  architecture: 'wasm32' as const,
  minimumPlatformVersion: 'modern',
  graphicsBackends: ['webgl2' as const],
  shaderVariants: ['essl-300' as const],
  compiledProjectFormatVersion: 1,
  playerRuntimeApiVersion: 1,
  compiledFeatures: ['web-single-threaded'],
  capabilities: ['network.client' as const],
  buildFlavor: 'release' as const,
  packageAccessModes: ['web-fetch' as const],
  files: [{ path: 'player.wasm', size: 1, mode: 0o644, sha256: 'a'.repeat(64) }],
  runtimeDependencies: [],
  artifacts: {
    archive: 'web.zip',
    symbols: 'web-symbols.zip',
    sbom: 'SBOM.cdx.json',
    notices: 'THIRD_PARTY_NOTICES.txt',
  },
  provenance: { provider: 'local' as const, source: 'test' },
  host: { assembly: 'any' as const, requiresToolchain: false, tools: [] },
};

describe('platform deployment model', () => {
  it('derives the fixed engine capability policy without granting network or notifications', () => {
    expect(derivedPlatformCapabilities('web')).toEqual(['external-url']);
    expect(derivedPlatformCapabilities('windows')).toEqual(['external-url']);
    expect(derivedPlatformCapabilities('android')).toEqual(['external-url', 'vibration']);
    expect(capabilityMetadata(derivedPlatformCapabilities('android')).androidPermissions).toEqual([
      'android.permission.VIBRATE',
    ]);
  });

  it('derives deterministic platform metadata and preserves display metadata', () => {
    expect(capabilityMetadata(['network.client', 'vibration']).androidPermissions).toEqual([
      'android.permission.INTERNET',
      'android.permission.VIBRATE',
    ]);
    const display = {
      aspectRatio: { width: 16, height: 9 },
      orientation: 'landscape' as const,
      barColor: '#000000',
    };
    const result = buildPlatformDeployment(
      {
        operationId: 'op',
        profile,
        templateToken: 'web/1',
        outputDirectory: '/local/out',
        packagePath: '/local/game.ntpkg',
        iconSourcePath: '/local/icon.png',
        runtimePackageEvidence: {
          sourceFingerprint: 'fnv1a:12345678',
          packageSha256: 'a'.repeat(64),
        },
        identity: {
          displayName: 'Game',
          applicationId: 'com.example.game',
          saveNamespace: 'com.example.game',
          versionName: '1.0',
        },
        display,
        runtimeDisplay: {
          referenceResolution: { width: 1920, height: 1080 },
          worldRasterPolicy: 'capped',
          barColor: '#000000',
        },
        accessibility: {
          uiScale: { enabled: true, minimum: 1, maximum: 2 },
          textScale: { enabled: true, minimum: 1, maximum: 2 },
        },
        capabilities: ['network.client'],
        playerRuntimeApiVersion: 1,
      },
      descriptor,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.model?.display).toEqual(display);
    expect(result.model?.capabilityMetadata.webRequirements).toEqual(['network']);
  });

  it('blocks invalid identity, missing icon, and incompatible templates', () => {
    const result = buildPlatformDeployment(
      {
        operationId: 'op',
        profile,
        templateToken: '',
        outputDirectory: '',
        packagePath: '',
        runtimePackageEvidence: {
          sourceFingerprint: 'fnv1a:12345678',
          packageSha256: 'a'.repeat(64),
        },
        identity: { displayName: '', applicationId: 'bad', saveNamespace: 'bad', versionName: '1' },
        display: {
          aspectRatio: { width: 1, height: 1 },
          orientation: 'portrait',
          barColor: '#000000',
        },
        runtimeDisplay: {
          referenceResolution: { width: 1080, height: 1920 },
          worldRasterPolicy: 'capped',
          barColor: '#000000',
        },
        accessibility: {
          uiScale: { enabled: true, minimum: 1, maximum: 2 },
          textScale: { enabled: true, minimum: 1, maximum: 2 },
        },
        playerRuntimeApiVersion: 1,
      },
      {
        ...descriptor,
        platform: 'windows',
        playerRuntimeApiVersion: 2,
      },
    );
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'invalid-app-identity',
        'missing-icon',
        'template-platform-mismatch',
        'template-player-runtime-api-mismatch',
      ]),
    );
  });
});
