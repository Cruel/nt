import { describe, expect, it } from 'vite-plus/test';
import {
  EDITOR_EXPORT_LOCAL_STATE_FORMAT,
  PLATFORM_EXPORT_PROFILE_FORMAT,
  PLAYER_CONFIG_FORMAT,
  PLAYER_RUNTIME_API_VERSION,
  TEMPLATE_DESCRIPTOR_FORMAT,
  TEMPLATE_DESCRIPTOR_FORMAT_VERSION,
  assetMemoryPolicyDefinitionSchema,
  defaultPlatformExportProfile,
  migrateLegacyAssetMemoryPolicyPercentages,
  parseEditorExportLocalState,
  parsePlatformExportProfile,
  parseProjectPlatformExportSettings,
  parsePlayerBootstrapConfig,
  parseTemplateDescriptor,
  parseUserExportConfig,
  resolveAssetMemoryPolicy,
  userSigningProfileToExportSigningState,
} from '../../shared/project-schema/platform-export-contracts';
import { classifyProjectValidationDiagnostic } from '../../shared/project-schema/project-validation';

const sha = 'a'.repeat(64);
describe('platform export contracts', () => {
  it('does not synthesize a platform profile for absent or invalid project settings', () => {
    expect(parseProjectPlatformExportSettings(undefined)).toEqual({
      profiles: [],
      assetMemoryPolicies: [],
    });
    expect(parseProjectPlatformExportSettings({})).toEqual({
      profiles: [],
      assetMemoryPolicies: [],
    });
  });

  it('parses and normalizes player bootstrap capabilities', () => {
    const value = parsePlayerBootstrapConfig({
      format: PLAYER_CONFIG_FORMAT,
      formatVersion: PLAYER_RUNTIME_API_VERSION,
      displayName: 'Game',
      applicationId: 'org.example.game',
      saveNamespace: 'org.example.game',
      versionName: '1.0.0',
      package: { path: 'game.ntpkg', sha256: sha },
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
    expect(() => parsePlayerBootstrapConfig({ ...value, formatVersion: 2 })).toThrow();
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

  it('parses a template descriptor with explicit compatibility versions', () => {
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
      compiledProjectFormatVersion: 1,
      playerRuntimeApiVersion: 1,
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
    expect(parseTemplateDescriptor(descriptor)).toMatchObject({
      compiledProjectFormatVersion: 1,
      playerRuntimeApiVersion: 1,
    });
  });

  it('keeps committed profiles free of local paths and secrets', () => {
    const profile = {
      format: PLATFORM_EXPORT_PROFILE_FORMAT,
      id: 'web-release',
      label: 'Web Release',
      target: 'web',
      architecture: 'wasm32',
      buildFlavor: 'release',
      packageAccess: 'web-fetch',
      web: { artifact: 'directory-zip', threaded: false, pwa: true },
    } as const;
    expect(parsePlatformExportProfile(profile).compression).toBe('default');
    expect(parsePlatformExportProfile(profile).assetMemory).toEqual({
      kind: 'builtin',
      preset: 'balanced',
    });
    expect(() =>
      parsePlatformExportProfile({ ...profile, outputPath: '/home/me/game.zip' }),
    ).toThrow();
    expect(() => parsePlatformExportProfile({ ...profile, password: 'secret' })).toThrow();

    expect(() =>
      parsePlatformExportProfile({ ...profile, capabilityOverrides: ['microphone'] }),
    ).toThrow();
    expect(() =>
      parsePlatformExportProfile({ ...profile, signingProfileId: 'legacy-signing' }),
    ).toThrow();
  });

  it('resolves measured memory presets and reusable named policy overrides', () => {
    const mib = 1024 * 1024;
    const expected = [
      ['linux', 'low', 64, 640, 32, 32, 13_421_772, 512, 6_710_886],
      ['linux', 'balanced', 128, 1280, 64, 64, 40_265_318, 1024, 20_132_659],
      ['linux', 'high', 256, 2560, 128, 128, 107_374_182, 2048, 53_687_091],
      ['android', 'low', 48, 352, 24, 24, 7_549_747, 256, 3_774_873],
      ['android', 'balanced', 96, 704, 48, 48, 25_165_824, 512, 12_582_912],
      ['android', 'high', 192, 1408, 96, 96, 70_464_307, 1024, 35_232_153],
      ['web', 'low', 32, 320, 16, 16, 3_355_443, 256, 1_677_721],
      ['web', 'balanced', 64, 640, 32, 32, 13_421_772, 512, 6_710_886],
      ['web', 'high', 128, 1280, 64, 64, 40_265_318, 1024, 20_132_659],
    ] as const;
    for (const [
      target,
      preset,
      cpu,
      gpu,
      audio,
      temporary,
      warmCpu,
      warmGpu,
      warmAudio,
    ] of expected) {
      expect(resolveAssetMemoryPolicy(target, { kind: 'builtin', preset })).toEqual({
        preset,
        preparedCpuBytes: cpu * mib,
        gpuBytes: gpu * mib,
        audioBytes: audio * mib,
        temporaryBytes: temporary * mib,
        warmPreparedCpuBytes: warmCpu,
        warmGpuBytes: warmGpu * mib,
        warmAudioBytes: warmAudio,
      });
    }

    const namedPolicy = assetMemoryPolicyDefinitionSchema.parse({
      id: 'web-constrained',
      label: 'Web constrained',
      basePreset: 'balanced',
      overrides: {
        gpuBytes: 96 * mib,
        warmPreparedCpuBytes: 0,
        warmGpuBytes: 0,
        warmAudioBytes: 0,
      },
    });
    const custom = parsePlatformExportProfile({
      ...defaultPlatformExportProfile('web'),
      assetMemory: { kind: 'policy', policyId: namedPolicy.id },
    });
    expect(resolveAssetMemoryPolicy('web', custom.assetMemory, [namedPolicy])).toEqual({
      preset: 'custom',
      preparedCpuBytes: 64 * mib,
      gpuBytes: 96 * mib,
      audioBytes: 32 * mib,
      temporaryBytes: 32 * mib,
      warmPreparedCpuBytes: 0,
      warmGpuBytes: 0,
      warmAudioBytes: 0,
    });

    expect(() =>
      assetMemoryPolicyDefinitionSchema.parse({
        id: 'legacy-percentage',
        label: 'Legacy percentage',
        basePreset: 'balanced',
        overrides: { prefetchAllowancePercent: 25 },
      }),
    ).toThrow();
    expect(() =>
      assetMemoryPolicyDefinitionSchema.parse({
        id: 'invalid',
        label: 'Invalid',
        basePreset: 'balanced',
        overrides: { temporaryBytes: 1024 },
      }),
    ).toThrow();
    expect(() =>
      resolveAssetMemoryPolicy('linux', { kind: 'policy', policyId: 'missing' }),
    ).toThrow(/Unknown asset memory policy/);
  });

  it('migrates legacy percentage policies to target-specific absolute Warm ceilings', () => {
    const settings: Record<string, unknown> = {
      assetMemoryPolicies: [
        {
          id: 'legacy-shared',
          label: 'Legacy shared',
          basePreset: 'balanced',
          overrides: { prefetchAllowancePercent: 25 },
        },
      ],
      profiles: [
        {
          ...defaultPlatformExportProfile('linux'),
          assetMemory: { kind: 'policy', policyId: 'legacy-shared' },
        },
        {
          ...defaultPlatformExportProfile('web'),
          assetMemory: { kind: 'policy', policyId: 'legacy-shared' },
        },
      ],
    };

    expect(migrateLegacyAssetMemoryPolicyPercentages(settings)).toBe(true);
    const parsed = parseProjectPlatformExportSettings(settings);
    expect(parsed.assetMemoryPolicies).toHaveLength(2);
    expect(JSON.stringify(parsed)).not.toContain('prefetchAllowancePercent');

    for (const profile of parsed.profiles) {
      const resolved = resolveAssetMemoryPolicy(
        profile.target,
        profile.assetMemory,
        parsed.assetMemoryPolicies,
      );
      if (profile.target === 'web') {
        expect(resolved).toMatchObject({
          warmPreparedCpuBytes: 16_777_216,
          warmGpuBytes: 33_554_432,
          warmAudioBytes: 8_388_608,
        });
      } else {
        expect(resolved).toMatchObject({
          warmPreparedCpuBytes: 33_554_432,
          warmGpuBytes: 67_108_864,
          warmAudioBytes: 16_777_216,
        });
      }
    }
  });

  it('accepts host paths only in editor-local state', () => {
    const state = parseEditorExportLocalState({
      format: EDITOR_EXPORT_LOCAL_STATE_FORMAT,
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

  it('parses shared named signing configurations without storing secret values', () => {
    const config = parseUserExportConfig({
      toolchains: { androidSdk: '/opt/android' },
      signingProfiles: [
        {
          id: 'android-release',
          label: 'Android Release',
          target: 'android',
          keystorePath: '/secure/release.jks',
          keyAlias: 'release',
          storePasswordReference: 'env:NOVELTEA_STORE_PASSWORD',
          keyPasswordReference: 'env:NOVELTEA_KEY_PASSWORD',
        },
      ],
    });
    expect(config.signingProfiles[0]).toMatchObject({
      id: 'android-release',
      target: 'android',
      storePasswordReference: 'env:NOVELTEA_STORE_PASSWORD',
    });
    expect(() => parseUserExportConfig({ ...config, unexpected: true })).toThrow();
    expect(() =>
      parseUserExportConfig({
        ...config,
        signingProfiles: [
          {
            ...config.signingProfiles[0]!,
            storePasswordReference: 'plaintext-secret',
          },
        ],
      }),
    ).toThrow();
  });

  it('maps shared signing profiles identically for export execution', () => {
    expect(
      userSigningProfileToExportSigningState({
        id: 'windows',
        label: 'Windows',
        target: 'windows',
        command: 'signtool',
        args: ['sign'],
        verifyCommand: 'signtool',
        verifyArgs: ['verify'],
      }),
    ).toEqual({
      windows: {
        command: 'signtool',
        args: ['sign'],
        verifyCommand: 'signtool',
        verifyArgs: ['verify'],
      },
    });
    expect(
      userSigningProfileToExportSigningState({
        id: 'macos',
        label: 'macOS',
        target: 'macos',
        identity: 'Developer ID',
        notarizationCommand: 'notarytool',
        notarizationArgs: ['submit'],
      }),
    ).toEqual({
      macos: {
        identity: 'Developer ID',
        notarizationCommand: 'notarytool',
        notarizationArgs: ['submit'],
      },
    });
    expect(
      userSigningProfileToExportSigningState({
        id: 'android',
        label: 'Android',
        target: 'android',
        keystorePath: '/keys/release.jks',
        keyAlias: 'release',
        storePasswordReference: 'env:STORE_PASSWORD',
        keyPasswordReference: 'env:KEY_PASSWORD',
      }),
    ).toEqual({
      android: {
        keystorePath: '/keys/release.jks',
        keyAlias: 'release',
        storePasswordReference: 'env:STORE_PASSWORD',
        keyPasswordReference: 'env:KEY_PASSWORD',
      },
    });
  });

  it('round-trips Android artifact selections and rejects architecture/ABI mismatches', () => {
    const base = {
      format: PLATFORM_EXPORT_PROFILE_FORMAT,
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
