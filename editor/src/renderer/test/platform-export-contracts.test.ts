import { describe, expect, it } from 'vite-plus/test';
import {
  EDITOR_EXPORT_LOCAL_STATE_FORMAT,
  EDITOR_EXPORT_LOCAL_STATE_FORMAT_VERSION,
  PLATFORM_EXPORT_PROFILE_FORMAT,
  PLATFORM_EXPORT_PROFILE_FORMAT_VERSION,
  PLAYER_CONFIG_FORMAT,
  PLAYER_CONFIG_FORMAT_VERSION,
  TEMPLATE_DESCRIPTOR_FORMAT,
  TEMPLATE_DESCRIPTOR_FORMAT_VERSION,
  parseEditorExportLocalState,
  parsePlatformExportProfile,
  parseProjectPlatformExportSettings,
  parsePlayerBootstrapConfig,
  parseTemplateDescriptor,
} from '../../shared/project-schema/platform-export-contracts';
import { classifyProjectValidationDiagnostic } from '../../shared/project-schema/project-validation';

const sha = 'a'.repeat(64);
describe('platform export contracts', () => {
  it('does not synthesize a platform profile for absent or invalid project settings', () => {
    expect(parseProjectPlatformExportSettings(undefined)).toEqual({
      selectedProfileId: null,
      profiles: [],
    });
    expect(parseProjectPlatformExportSettings({})).toEqual({
      selectedProfileId: null,
      profiles: [],
    });
  });

  it('parses and normalizes player bootstrap capabilities', () => {
    const value = parsePlayerBootstrapConfig({
      format: PLAYER_CONFIG_FORMAT,
      formatVersion: PLAYER_CONFIG_FORMAT_VERSION,
      displayName: 'Game',
      applicationId: 'org.example.game',
      saveNamespace: 'org.example.game',
      versionName: '1.0.0',
      package: { path: 'game.ntpkg', sha256: sha, runtimePackageApi: 2 },
      capabilities: ['vibration', 'network.client', 'vibration'],
      display: {
        referenceResolution: { width: 1920, height: 1080 },
        worldRasterPolicy: 'capped',
        barColor: '#000000',
      },
      accessibility: {
        uiScale: { enabled: true, minimum: 1, maximum: 2 },
        textScale: { enabled: true, minimum: 1, maximum: 2 },
      },
    });
    expect(value.capabilities).toEqual(['network.client', 'vibration']);
    expect(() => parsePlayerBootstrapConfig({ ...value, formatVersion: 1 })).toThrow();
    expect(() =>
      parsePlayerBootstrapConfig({
        ...value,
        package: { ...value.package, path: '../game.ntpkg' },
      }),
    ).toThrow();
    expect(() =>
      parsePlayerBootstrapConfig({ ...value, package: { ...value.package, sha256: 'bad' } }),
    ).toThrow();
  });

  it('parses a compatible template descriptor and rejects inverted API ranges', () => {
    const descriptor = {
      format: TEMPLATE_DESCRIPTOR_FORMAT,
      formatVersion: TEMPLATE_DESCRIPTOR_FORMAT_VERSION,
      templateId: 'linux-x64',
      buildId: 'build-1',
      engineVersion: '1',
      platform: 'linux',
      architecture: 'x64',
      minimumPlatformVersion: 'provisional',
      graphicsBackends: ['opengl'],
      shaderVariants: ['glsl-120'],
      runtimePackageApi: { minimum: 2, maximum: 2 },
      playerConfigApi: { minimum: 2, maximum: 2 },
      compiledFeatures: ['lua'],
      capabilities: [],
      buildFlavor: 'release',
      packageAccessModes: ['sidecar'],
      files: [{ path: 'licenses/NOTICE.txt', size: 1, mode: 420, sha256: sha }],
      runtimeDependencies: [{ path: 'licenses/NOTICE.txt', kind: 'notice' }],
      artifacts: {
        archive: 'template.tar.gz',
        symbols: 'symbols.tar.gz',
        sbom: 'SBOM.cdx.json',
        notices: 'licenses/NOTICE.txt',
      },
      provenance: { provider: 'local', source: 'test' },
      host: { assembly: 'any', requiresToolchain: false, tools: [] },
    } as const;
    expect(parseTemplateDescriptor(descriptor).runtimePackageApi).toEqual({
      minimum: 2,
      maximum: 2,
    });
    expect(() =>
      parseTemplateDescriptor({ ...descriptor, runtimePackageApi: { minimum: 2, maximum: 1 } }),
    ).toThrow();
  });

  it('keeps committed profiles free of local paths and secrets', () => {
    const profile = {
      format: PLATFORM_EXPORT_PROFILE_FORMAT,
      formatVersion: PLATFORM_EXPORT_PROFILE_FORMAT_VERSION,
      id: 'web-release',
      label: 'Web Release',
      target: 'web',
      architecture: 'wasm32',
      buildFlavor: 'release',
      packageAccess: 'web-fetch',
      web: { artifact: 'directory-zip', threaded: false, pwa: true },
    } as const;
    expect(parsePlatformExportProfile(profile).compression).toBe('default');
    expect(() =>
      parsePlatformExportProfile({ ...profile, outputPath: '/home/me/game.zip' }),
    ).toThrow();
    expect(() => parsePlatformExportProfile({ ...profile, password: 'secret' })).toThrow();
  });

  it('accepts host paths only in editor-local state', () => {
    const state = parseEditorExportLocalState({
      format: EDITOR_EXPORT_LOCAL_STATE_FORMAT,
      formatVersion: EDITOR_EXPORT_LOCAL_STATE_FORMAT_VERSION,
      lastOutputDirectory: '/home/me/exports',
      templateRoots: ['/opt/noveltea/templates'],
      toolchains: { androidSdk: '/opt/android' },
      signing: {
        android: {
          keystorePath: '/secure/release.jks',
          keyAlias: 'release',
          storePasswordReference: 'env:NOVELTEA_STORE_PASSWORD',
          keyPasswordReference: 'env:NOVELTEA_KEY_PASSWORD',
        },
      },
    });
    expect(state.signing.android?.storePasswordReference).toBe('env:NOVELTEA_STORE_PASSWORD');
  });

  it('round-trips Android artifact selections and rejects architecture/ABI mismatches', () => {
    const base = {
      format: PLATFORM_EXPORT_PROFILE_FORMAT,
      formatVersion: 1,
      id: 'android',
      label: 'Android',
      target: 'android',
      architecture: 'arm64',
      buildFlavor: 'release',
      packageAccess: 'android-private-copy',
      android: { artifact: 'apk', abi: 'arm64-v8a', minSdk: 24 },
    } as const;
    for (const artifact of ['apk', 'aab', 'both'] as const) {
      const parsed = parsePlatformExportProfile({
        ...base,
        android: { ...base.android, artifact },
      });
      expect(parsed.target === 'android' && parsed.android.artifact).toBe(artifact);
    }
    expect(() =>
      parsePlatformExportProfile({ ...base, android: { ...base.android, abi: 'x86_64' } }),
    ).toThrow(/requires ABI/);
    expect(() =>
      parsePlatformExportProfile({
        ...base,
        architecture: 'x86_64',
        android: { ...base.android, artifact: 'aab', abi: 'x86_64' },
      }),
    ).toThrow(/arm64-v8a/);
  });

  it('adapts platform diagnostics without losing their stable code', () => {
    const diagnostic = classifyProjectValidationDiagnostic(
      {
        code: 'template-tool-missing',
        severity: 'error',
        path: '/host/availableTools',
        message: 'Required host tool is unavailable.',
        category: 'template:template-tool-missing',
      },
      { producer: 'template' },
    );

    expect(diagnostic).toMatchObject({
      code: 'template-tool-missing',
      severity: 'error',
      path: '/host/availableTools',
      ownerPaths: ['/host/availableTools'],
      boundaries: ['platform-export'],
    });
  });
});
