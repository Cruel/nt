import { z } from 'zod';
import type { PackageExportOptions } from '../editor-tooling';
import { exportProfileSchema, type ExportProfileData } from './authoring-export';
import type { ProjectValidationDiagnostic } from './project-validation';
import { MAX_REFERENCE_RESOLUTION_DIMENSION } from './project-display-contract';

export const PLAYER_CONFIG_FORMAT = 'noveltea.player-config' as const;
export const PLAYER_CONFIG_FORMAT_VERSION = 2 as const;
export const TEMPLATE_DESCRIPTOR_FORMAT = 'noveltea.player-template' as const;
export const TEMPLATE_DESCRIPTOR_FORMAT_VERSION = 1 as const;
export const PLATFORM_EXPORT_PROFILE_FORMAT = 'noveltea.platform-export-profile' as const;
export const PLATFORM_EXPORT_PROFILE_FORMAT_VERSION = 1 as const;
export const EDITOR_EXPORT_LOCAL_STATE_FORMAT = 'noveltea.editor-export-local-state' as const;
export const EDITOR_EXPORT_LOCAL_STATE_FORMAT_VERSION = 1 as const;
export const PLATFORM_EXPORT_MANIFEST_FORMAT = 'noveltea.platform-export-manifest' as const;
export const PLATFORM_EXPORT_MANIFEST_FORMAT_VERSION = 1 as const;
export const TEMPLATE_REGISTRY_FORMAT = 'noveltea.template-registry' as const;
export const TEMPLATE_REGISTRY_FORMAT_VERSION = 1 as const;
export const TEMPLATE_REGISTRY_INDEX_FORMAT = 'noveltea.template-registry-index' as const;
export const TEMPLATE_REGISTRY_INDEX_FORMAT_VERSION = 1 as const;

export const exportCapabilityValues = [
  'network.client',
  'external-url',
  'clipboard.read',
  'clipboard.write',
  'gamepad',
  'vibration',
  'microphone',
  'notifications',
  'custom-url-scheme',
  'billing',
] as const;
export const exportPlatformValues = ['windows', 'linux', 'macos', 'web', 'android'] as const;
export const exportBuildFlavorValues = ['debug', 'release'] as const;
export const exportArchitectureValues = ['x64', 'arm64', 'wasm32', 'x86_64'] as const;

export type ExportCapability = (typeof exportCapabilityValues)[number];
export type ExportPlatform = (typeof exportPlatformValues)[number];

export const assetMemoryPresetValues = ['low', 'balanced', 'high', 'custom'] as const;
const minimumTemporaryAssetBudgetBytes = 1024 * 1024;
const positiveRuntimeByteCountSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const customAssetMemoryPolicySchema = z
  .object({
    preparedCpuBytes: positiveRuntimeByteCountSchema.optional(),
    gpuBytes: positiveRuntimeByteCountSchema.optional(),
    audioBytes: positiveRuntimeByteCountSchema.optional(),
    temporaryBytes: positiveRuntimeByteCountSchema.min(minimumTemporaryAssetBudgetBytes).optional(),
    prefetchAllowancePercent: z.number().int().min(0).max(100).optional(),
  })
  .strict();

export const assetMemoryProfileSchema = z
  .object({
    preset: z.enum(assetMemoryPresetValues).default('balanced'),
    custom: customAssetMemoryPolicySchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.preset !== 'custom' && value.custom !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['custom'],
        message: 'Custom asset memory fields require the Custom preset.',
      });
  });

export const resolvedAssetMemoryPolicySchema = z
  .object({
    preset: z.enum(assetMemoryPresetValues),
    preparedCpuBytes: positiveRuntimeByteCountSchema,
    gpuBytes: positiveRuntimeByteCountSchema,
    audioBytes: positiveRuntimeByteCountSchema,
    temporaryBytes: positiveRuntimeByteCountSchema.min(minimumTemporaryAssetBudgetBytes),
    prefetchAllowancePercent: z.number().int().min(0).max(100),
  })
  .strict();

export type AssetMemoryProfile = z.infer<typeof assetMemoryProfileSchema>;
export type ResolvedAssetMemoryPolicy = z.infer<typeof resolvedAssetMemoryPolicySchema>;

const mib = (value: number) => value * 1024 * 1024;
const measuredAssetMemoryDefaults: Record<
  'desktop' | 'android' | 'web',
  Record<'low' | 'balanced' | 'high', Omit<ResolvedAssetMemoryPolicy, 'preset'>>
> = {
  desktop: {
    low: {
      preparedCpuBytes: mib(64),
      gpuBytes: mib(128),
      audioBytes: mib(32),
      temporaryBytes: mib(32),
      prefetchAllowancePercent: 20,
    },
    balanced: {
      preparedCpuBytes: mib(128),
      gpuBytes: mib(256),
      audioBytes: mib(64),
      temporaryBytes: mib(64),
      prefetchAllowancePercent: 30,
    },
    high: {
      preparedCpuBytes: mib(256),
      gpuBytes: mib(512),
      audioBytes: mib(128),
      temporaryBytes: mib(128),
      prefetchAllowancePercent: 40,
    },
  },
  android: {
    low: {
      preparedCpuBytes: mib(48),
      gpuBytes: mib(96),
      audioBytes: mib(24),
      temporaryBytes: mib(24),
      prefetchAllowancePercent: 15,
    },
    balanced: {
      preparedCpuBytes: mib(96),
      gpuBytes: mib(192),
      audioBytes: mib(48),
      temporaryBytes: mib(48),
      prefetchAllowancePercent: 25,
    },
    high: {
      preparedCpuBytes: mib(192),
      gpuBytes: mib(384),
      audioBytes: mib(96),
      temporaryBytes: mib(96),
      prefetchAllowancePercent: 35,
    },
  },
  web: {
    low: {
      preparedCpuBytes: mib(32),
      gpuBytes: mib(64),
      audioBytes: mib(16),
      temporaryBytes: mib(16),
      prefetchAllowancePercent: 10,
    },
    balanced: {
      preparedCpuBytes: mib(64),
      gpuBytes: mib(128),
      audioBytes: mib(32),
      temporaryBytes: mib(32),
      prefetchAllowancePercent: 20,
    },
    high: {
      preparedCpuBytes: mib(128),
      gpuBytes: mib(256),
      audioBytes: mib(64),
      temporaryBytes: mib(64),
      prefetchAllowancePercent: 30,
    },
  },
};

export function resolveAssetMemoryPolicy(
  target: ExportPlatform,
  profile: AssetMemoryProfile,
): ResolvedAssetMemoryPolicy {
  const family = target === 'web' ? 'web' : target === 'android' ? 'android' : 'desktop';
  const baselinePreset = profile.preset === 'custom' ? 'balanced' : profile.preset;
  const baseline = measuredAssetMemoryDefaults[family][baselinePreset];
  return resolvedAssetMemoryPolicySchema.parse({
    preset: profile.preset,
    preparedCpuBytes: profile.custom?.preparedCpuBytes ?? baseline.preparedCpuBytes,
    gpuBytes: profile.custom?.gpuBytes ?? baseline.gpuBytes,
    audioBytes: profile.custom?.audioBytes ?? baseline.audioBytes,
    temporaryBytes: profile.custom?.temporaryBytes ?? baseline.temporaryBytes,
    prefetchAllowancePercent:
      profile.custom?.prefetchAllowancePercent ?? baseline.prefetchAllowancePercent,
  });
}

const relativeArtifactPathSchema = z
  .string()
  .min(1)
  .refine((path) => {
    if (/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(path) || path.includes('\\')) return false;
    return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
  }, 'Path must be a normalized relative path without traversal.');

const capabilityArraySchema = z
  .array(z.enum(exportCapabilityValues))
  .transform((values) => [...new Set(values)].sort((a, b) => a.localeCompare(b)));

export const normalizedPlatformDisplayMetadataSchema = z
  .object({
    aspectRatio: z
      .object({ width: z.number().int().positive(), height: z.number().int().positive() })
      .strict(),
    orientation: z.enum(['landscape', 'portrait']),
    barColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  })
  .strict();

export const playerDisplayMetadataSchema = z
  .object({
    referenceResolution: z
      .object({
        width: z.number().int().positive().max(MAX_REFERENCE_RESOLUTION_DIMENSION),
        height: z.number().int().positive().max(MAX_REFERENCE_RESOLUTION_DIMENSION),
      })
      .strict(),
    worldRasterPolicy: z.enum(['capped', 'native']),
    barColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  })
  .strict();

const accessibilityScalePolicySchema = z
  .object({
    enabled: z.boolean(),
    minimum: z.number().finite().positive(),
    maximum: z.number().finite().positive(),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.minimum > policy.maximum)
      context.addIssue({ code: 'custom', message: 'Minimum scale must not exceed maximum.' });
    if (policy.enabled && (policy.minimum > 1 || policy.maximum < 1))
      context.addIssue({ code: 'custom', message: 'Enabled scale range must include 1.0.' });
  });

export const playerAccessibilityMetadataSchema = z
  .object({
    uiScale: accessibilityScalePolicySchema,
    textScale: accessibilityScalePolicySchema,
  })
  .strict();

const androidArtifactKindSchema = z.enum(['apk', 'aab', 'both']);
const androidAbiSchema = z.enum(['arm64-v8a', 'x86_64']);
const androidPackageAccessSchema = z.enum(['android-asset', 'android-private-copy']);

const androidTemplateDescriptorSchema = z
  .object({
    gradleProjectRoot: relativeArtifactPathSchema,
    applicationModule: z.string().trim().min(1),
    gradleWrapperPath: relativeArtifactPathSchema,
    bundletoolPath: relativeArtifactPathSchema,
    insertionRoots: z
      .object({
        generatedSource: relativeArtifactPathSchema,
        resources: relativeArtifactPathSchema,
        assets: relativeArtifactPathSchema,
      })
      .strict(),
    namespace: z.string().trim().min(1),
    activityClass: z.string().trim().min(1),
    nativeLibraryName: z.string().trim().min(1),
    supportedAbis: z.array(androidAbiSchema).min(1),
    artifactKinds: z.array(z.enum(['apk', 'aab'])).min(1),
    packageAccessModes: z.array(androidPackageAccessSchema).min(1),
    minimumSdk: z
      .object({ minimum: z.number().int().positive(), maximum: z.number().int().positive() })
      .strict()
      .refine(({ minimum, maximum }) => minimum <= maximum, 'Minimum SDK range is inverted.'),
    targetSdk: z.number().int().positive(),
    compileSdk: z.number().int().positive(),
    toolchain: z
      .object({
        gradle: z.string().min(1),
        androidGradlePlugin: z.string().min(1),
        java: z.string().min(1),
        buildTools: z.string().min(1),
        ndk: z.string().min(1),
        cmake: z.string().min(1),
        bundletool: z.string().min(1),
      })
      .strict(),
    roles: z
      .object({
        manifest: z.array(relativeArtifactPathSchema),
        nativeLibraries: z.array(relativeArtifactPathSchema),
        runtimeAssets: z.array(relativeArtifactPathSchema),
        notices: z.array(relativeArtifactPathSchema),
        supportFiles: z.array(relativeArtifactPathSchema),
      })
      .strict(),
  })
  .strict();

export const playerBootstrapConfigSchema = z
  .object({
    format: z.literal(PLAYER_CONFIG_FORMAT),
    formatVersion: z.literal(PLAYER_CONFIG_FORMAT_VERSION),
    displayName: z.string().trim().min(1),
    applicationId: z.string().trim().min(1),
    saveNamespace: z.string().trim().min(1),
    versionName: z.string().trim().min(1),
    defaultLocale: z.string().trim().min(1).optional(),
    package: z
      .object({
        path: relativeArtifactPathSchema,
        sha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/, 'SHA-256 must contain 64 lowercase hexadecimal characters.'),
        runtimePackageApi: z.number().int().nonnegative(),
      })
      .strict(),
    capabilities: capabilityArraySchema,
    display: playerDisplayMetadataSchema,
    accessibility: playerAccessibilityMetadataSchema,
    assetMemory: resolvedAssetMemoryPolicySchema.optional(),
  })
  .strict();

const runtimePackageApiRangeSchema = z
  .object({
    minimum: z.number().int().nonnegative(),
    maximum: z.number().int().nonnegative(),
  })
  .strict()
  .refine(({ minimum, maximum }) => minimum <= maximum, {
    message: 'Minimum package API must not exceed maximum.',
  });

export const templateDescriptorSchema = z
  .object({
    format: z.literal(TEMPLATE_DESCRIPTOR_FORMAT),
    formatVersion: z.literal(TEMPLATE_DESCRIPTOR_FORMAT_VERSION),
    templateId: z.string().trim().min(1),
    buildId: z.string().trim().min(1),
    engineVersion: z.string().trim().min(1),
    platform: z.enum(exportPlatformValues),
    architecture: z.enum(exportArchitectureValues),
    abi: z.string().trim().min(1).optional(),
    minimumPlatformVersion: z.string().trim().min(1),
    graphicsBackends: z
      .array(z.enum(['direct3d11', 'metal', 'opengl', 'opengles', 'webgl2', 'vulkan']))
      .min(1),
    shaderVariants: z.array(z.enum(['glsl-120', 'essl-100', 'essl-300'])).min(1),
    runtimePackageApi: runtimePackageApiRangeSchema,
    playerConfigApi: runtimePackageApiRangeSchema,
    compiledFeatures: z
      .array(z.string().trim().min(1))
      .transform((values) => [...new Set(values)].sort()),
    capabilities: capabilityArraySchema,
    buildFlavor: z.enum(exportBuildFlavorValues),
    packageAccessModes: z
      .array(
        z.enum([
          'sidecar',
          'bundle-resource',
          'web-fetch',
          'android-asset',
          'android-private-copy',
        ]),
      )
      .min(1),
    files: z
      .array(
        z
          .object({
            path: relativeArtifactPathSchema,
            size: z.number().int().nonnegative(),
            mode: z.number().int().nonnegative(),
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
            role: z
              .enum(['player', 'native-dependency', 'system-asset', 'notice', 'symbol', 'support'])
              .optional(),
          })
          .strict(),
      )
      .min(1),
    runtimeDependencies: z.array(
      z
        .object({ path: relativeArtifactPathSchema, kind: z.enum(['library', 'asset', 'notice']) })
        .strict(),
    ),
    windowsImports: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9_.-]+\.dll$/),
      )
      .optional(),
    linuxNeeded: z.array(z.string().trim().min(1)).optional(),
    linuxRpaths: z.array(z.string().trim().min(1)).optional(),
    macosDependencies: z.array(z.string().trim().min(1)).optional(),
    macosRpaths: z.array(z.string().trim().min(1)).optional(),
    macosMachO: z
      .array(
        z
          .object({
            path: relativeArtifactPathSchema,
            dependencies: z.array(z.string().trim().min(1)),
            rpaths: z.array(z.string().trim().min(1)),
            uuid: z.string().trim().min(1).optional(),
          })
          .strict(),
      )
      .optional(),
    artifacts: z
      .object({
        archive: z.string().trim().min(1),
        symbols: z.string().trim().min(1),
        sbom: relativeArtifactPathSchema,
        notices: relativeArtifactPathSchema,
      })
      .strict(),
    provenance: z
      .object({
        provider: z.enum(['github-attestation', 'local']),
        subjectDigest: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
        source: z.string().trim().min(1),
      })
      .strict(),
    host: z
      .object({
        assembly: z.enum(['any', 'windows', 'linux', 'macos']),
        requiresToolchain: z.boolean(),
        tools: z.array(z.string().trim().min(1)).default([]),
      })
      .strict(),
    android: androidTemplateDescriptorSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.platform === 'android' && !value.android)
      context.addIssue({
        code: 'custom',
        path: ['android'],
        message: 'Android templates require an Android descriptor section.',
      });
    if (value.platform !== 'android' && value.android)
      context.addIssue({
        code: 'custom',
        path: ['android'],
        message: 'Only Android templates may declare an Android descriptor section.',
      });
  });

const platformProfileBase = z.object({
  format: z.literal(PLATFORM_EXPORT_PROFILE_FORMAT),
  formatVersion: z.literal(PLATFORM_EXPORT_PROFILE_FORMAT_VERSION),
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  buildFlavor: z.enum(exportBuildFlavorValues),
  compression: z.enum(['default', 'store', 'maximum']).default('default'),
  includeDebugSymbols: z.boolean().default(false),
  capabilityOverrides: capabilityArraySchema.default([]),
  assetMemory: assetMemoryProfileSchema.default({ preset: 'balanced' }),
  signingProfileId: z.string().trim().min(1).nullable().optional(),
});

const desktopProfileSchema = platformProfileBase
  .extend({
    target: z.enum(['windows', 'linux', 'macos']),
    architecture: z.enum(['x64', 'arm64']),
    packageAccess: z.enum(['sidecar', 'bundle-resource']),
    desktop: z
      .object({
        artifact: z.enum(['zip', 'tar', 'appimage', 'app-bundle']),
        executableName: z.string().trim().min(1),
      })
      .strict(),
  })
  .strict();
const webProfileSchema = platformProfileBase
  .extend({
    target: z.literal('web'),
    architecture: z.literal('wasm32'),
    packageAccess: z.literal('web-fetch'),
    web: z
      .object({
        artifact: z.literal('directory-zip'),
        threaded: z.boolean().default(false),
        pwa: z.boolean().default(false),
        display: z
          .enum(['fullscreen', 'standalone', 'minimal-ui', 'browser'])
          .default('standalone'),
        basePath: z
          .string()
          .regex(
            /^\/$|^\/[a-zA-Z0-9._~!$&'()*+,;=:@%/-]*\/$/,
            'Web base path must begin and end with /.',
          )
          .default('/'),
        serviceWorker: z.enum(['disabled', 'offline']).default('disabled'),
      })
      .strict(),
  })
  .strict();
const androidProfileSchema = platformProfileBase
  .extend({
    target: z.literal('android'),
    architecture: z.enum(['arm64', 'x86_64']),
    packageAccess: androidPackageAccessSchema,
    android: z
      .object({
        artifact: androidArtifactKindSchema,
        abi: androidAbiSchema,
        minSdk: z.number().int().min(24),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedAbi = value.architecture === 'arm64' ? 'arm64-v8a' : 'x86_64';
    if (value.android.abi !== expectedAbi)
      context.addIssue({
        code: 'custom',
        path: ['android', 'abi'],
        message: `Architecture '${value.architecture}' requires ABI '${expectedAbi}'.`,
      });
    if (
      (value.android.artifact === 'aab' || value.android.artifact === 'both') &&
      value.buildFlavor === 'release' &&
      value.android.abi !== 'arm64-v8a'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['android', 'abi'],
        message: 'Release AAB exports require the arm64-v8a ABI.',
      });
    }
  });

export const platformExportProfileSchema = z.discriminatedUnion('target', [
  desktopProfileSchema,
  webProfileSchema,
  androidProfileSchema,
]);

export const projectPlatformExportSettingsSchema = z
  .object({
    selectedProfileId: z.string().min(1).nullable(),
    profiles: z.array(platformExportProfileSchema),
  })
  .strict();

export type ProjectPlatformExportSettings = z.infer<typeof projectPlatformExportSettingsSchema>;

export function defaultPlatformExportProfile(
  target: ExportPlatform = 'linux',
): PlatformExportProfile {
  const common = {
    format: PLATFORM_EXPORT_PROFILE_FORMAT,
    formatVersion: PLATFORM_EXPORT_PROFILE_FORMAT_VERSION,
    id: `${target}-release`,
    label: `${target[0]!.toUpperCase()}${target.slice(1)} Release`,
    buildFlavor: 'release' as const,
    compression: 'default' as const,
    includeDebugSymbols: false,
    capabilityOverrides: [] as ExportCapability[],
    assetMemory: { preset: 'balanced' as const },
    signingProfileId: null,
  };
  if (target === 'web') {
    return platformExportProfileSchema.parse({
      ...common,
      target,
      architecture: 'wasm32',
      packageAccess: 'web-fetch',
      web: {
        artifact: 'directory-zip',
        threaded: true,
        pwa: true,
        display: 'standalone',
        basePath: '/',
        serviceWorker: 'disabled',
      },
    });
  }
  if (target === 'android') {
    return platformExportProfileSchema.parse({
      ...common,
      target,
      architecture: 'arm64',
      packageAccess: 'android-private-copy',
      android: { artifact: 'apk', abi: 'arm64-v8a', minSdk: 24 },
    });
  }
  if (target === 'macos') {
    return platformExportProfileSchema.parse({
      ...common,
      target,
      architecture: 'arm64',
      packageAccess: 'bundle-resource',
      desktop: { artifact: 'app-bundle', executableName: 'Game' },
    });
  }
  return platformExportProfileSchema.parse({
    ...common,
    target,
    architecture: 'x64',
    packageAccess: 'sidecar',
    desktop: { artifact: target === 'windows' ? 'zip' : 'tar', executableName: 'game' },
  });
}

export function defaultProjectPlatformExportSettings(): ProjectPlatformExportSettings {
  return { selectedProfileId: null, profiles: [] };
}

export function parseProjectPlatformExportSettings(value: unknown): ProjectPlatformExportSettings {
  const parsed = projectPlatformExportSettingsSchema.safeParse(value);
  if (!parsed.success || parsed.data.profiles.length === 0)
    return defaultProjectPlatformExportSettings();
  const selectedProfileId = parsed.data.profiles.some(
    (profile) => profile.id === parsed.data.selectedProfileId,
  )
    ? parsed.data.selectedProfileId
    : parsed.data.profiles[0]!.id;
  return { ...parsed.data, selectedProfileId };
}

export const editorExportLocalStateSchema = z
  .object({
    format: z.literal(EDITOR_EXPORT_LOCAL_STATE_FORMAT),
    formatVersion: z.literal(EDITOR_EXPORT_LOCAL_STATE_FORMAT_VERSION),
    lastOutputDirectory: z.string().optional(),
    templateRoots: z.array(z.string()).default([]),
    toolchains: z
      .object({
        androidSdk: z.string().optional(),
        androidNdk: z.string().optional(),
        javaHome: z.string().optional(),
        cmake: z.string().optional(),
      })
      .strict()
      .default({}),
    signing: z
      .object({
        windows: z
          .object({
            command: z.string().min(1),
            args: z.array(z.string()),
            verifyCommand: z.string().min(1),
            verifyArgs: z.array(z.string()),
          })
          .strict()
          .optional(),
        macos: z
          .object({
            identity: z.string().min(1),
            entitlementsPath: z.string().optional(),
            notarizationCommand: z.string().optional(),
            notarizationArgs: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        android: z
          .object({
            keystorePath: z.string().min(1),
            keyAlias: z.string().min(1),
            storePasswordReference: z.string().min(1),
            keyPasswordReference: z.string().min(1),
          })
          .strict()
          .optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

export type PlayerBootstrapConfig = z.infer<typeof playerBootstrapConfigSchema>;
export type TemplateDescriptor = z.infer<typeof templateDescriptorSchema>;
export type PlatformExportProfile = z.infer<typeof platformExportProfileSchema>;
export type EditorExportLocalState = z.infer<typeof editorExportLocalStateSchema>;

export const templateCompatibilityRequirementsSchema = z
  .object({
    profile: platformExportProfileSchema,
    runtimePackageApi: z.number().int().nonnegative(),
    playerConfigApi: z.number().int().nonnegative().default(PLAYER_CONFIG_FORMAT_VERSION),
    shaderVariants: z.array(z.enum(['glsl-120', 'essl-100', 'essl-300'])).default([]),
    graphicsBackends: z
      .array(z.enum(['direct3d11', 'metal', 'opengl', 'opengles', 'webgl2', 'vulkan']))
      .default([]),
    capabilities: capabilityArraySchema.default([]),
    requiredFeatures: z.array(z.string().trim().min(1)).default([]),
    host: z
      .object({
        platform: z.enum(['windows', 'linux', 'macos']),
        availableTools: z.array(z.string()),
      })
      .optional(),
  })
  .strict();
export type TemplateCompatibilityRequirements = z.infer<
  typeof templateCompatibilityRequirementsSchema
>;
export interface TemplateCompatibilityDiagnostic {
  code: string;
  path: string;
  message: string;
}
export interface TemplateCompatibilityResult {
  compatible: boolean;
  diagnostics: TemplateCompatibilityDiagnostic[];
}

export const templateRegistryEntrySchema = z
  .object({
    format: z.literal(TEMPLATE_REGISTRY_FORMAT),
    formatVersion: z.literal(TEMPLATE_REGISTRY_FORMAT_VERSION),
    templateId: z.string().min(1),
    buildId: z.string().min(1),
    descriptorSha256: z.string().regex(/^[0-9a-f]{64}$/),
    archiveSha256: z.string().regex(/^[0-9a-f]{64}$/),
    installedAt: z.string().datetime(),
    origin: z.string().min(1),
    trust: z.enum(['official', 'local-untrusted']),
    verified: z.boolean(),
  })
  .strict();
export type TemplateRegistryEntry = z.infer<typeof templateRegistryEntrySchema>;
export interface TemplateRegistryQuery {
  platform?: ExportPlatform;
  architecture?: string;
  buildFlavor?: 'debug' | 'release';
}
export interface InstalledTemplate {
  entry: TemplateRegistryEntry;
  descriptor: TemplateDescriptor;
  status: 'installed' | 'corrupted' | 'untrusted';
  compatibility?: TemplateCompatibilityResult;
}
export interface TemplateInstallRequest {
  archivePath: string;
  archiveSha256?: string;
  origin?: string;
  officialProvenance?: { archiveSha256: string; descriptorSha256: string; source: string };
}
export interface TemplateInstallResult {
  success: boolean;
  entry?: TemplateRegistryEntry;
  diagnostics: TemplateCompatibilityDiagnostic[];
}
export interface TemplateResolveRequest {
  requirements: TemplateCompatibilityRequirements;
}
export interface TemplateResolveResult {
  success: boolean;
  token?: string;
  template?: InstalledTemplate;
  diagnostics: TemplateCompatibilityDiagnostic[];
}
export const templateRegistryIndexSchema = z
  .object({
    format: z.literal(TEMPLATE_REGISTRY_INDEX_FORMAT),
    formatVersion: z.literal(TEMPLATE_REGISTRY_INDEX_FORMAT_VERSION),
    generatedAt: z.string(),
    templates: z.array(
      z
        .object({
          templateId: z.string(),
          buildId: z.string(),
          platform: z.enum(exportPlatformValues),
          architecture: z.string(),
          buildFlavor: z.enum(exportBuildFlavorValues),
          archive: z.string(),
          archiveSha256: z.string().regex(/^[0-9a-f]{64}$/),
          descriptorSha256: z.string().regex(/^[0-9a-f]{64}$/),
          symbols: z.string(),
          sbom: z.string(),
          notices: z.string(),
          provenance: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export const stagedFileOriginValues = [
  'template',
  'runtime-package',
  'system-asset',
  'icon',
  'native-dependency',
  'notice',
  'generated-metadata',
] as const;
export type StagedFileOrigin = (typeof stagedFileOriginValues)[number];
export type PlatformStageDiagnostic = ProjectValidationDiagnostic;
export interface StagedFileEntry {
  path: string;
  origin: StagedFileOrigin;
  originId: string;
  size: number;
  mode: number;
  sha256: string;
}
export interface PlatformCapabilityMetadata {
  androidPermissions: string[];
  androidFeatures: string[];
  webRequirements: string[];
  desktopFeatures: string[];
}
export interface PlatformDeploymentModel {
  target: ExportPlatform;
  architecture: string;
  buildFlavor: 'debug' | 'release';
  applicationId: string;
  displayName: string;
  versionName: string;
  saveNamespace: string;
  capabilities: ExportCapability[];
  capabilityMetadata: PlatformCapabilityMetadata;
  display: z.infer<typeof normalizedPlatformDisplayMetadataSchema>;
  packageAccess: string;
  templateId: string;
  buildId: string;
  runtimePackageApi: number;
  assetMemory: ResolvedAssetMemoryPolicy;
  android?: {
    applicationId: string;
    versionCode: number;
    versionName: string;
    allowBackup: boolean;
    isGame: boolean;
    minSdk: number;
    targetSdk: number;
    compileSdk: number;
    abi: 'arm64-v8a' | 'x86_64';
    artifacts: Array<'apk' | 'aab'>;
    packageAccess: 'android-asset' | 'android-private-copy';
    orientation: 'landscape' | 'portrait';
  };
}
export interface PlatformExportManifest {
  format: typeof PLATFORM_EXPORT_MANIFEST_FORMAT;
  formatVersion: typeof PLATFORM_EXPORT_MANIFEST_FORMAT_VERSION;
  deployment: PlatformDeploymentModel;
  files: StagedFileEntry[];
}
export interface PlatformStageRequest {
  operationId: string;
  profile: PlatformExportProfile;
  templateToken: string;
  outputDirectory: string;
  packagePath: string;
  iconSourcePath?: string;
  systemAssetsRoot?: string;
  runtimePackageEvidence: {
    sourceFingerprint: string;
    packageSha256: string;
  };
  identity: {
    displayName: string;
    shortName?: string;
    applicationId: string;
    saveNamespace: string;
    versionName: string;
    defaultLocale?: string;
    themeColor?: string;
    backgroundColor?: string;
    webManifestId?: string;
    linuxDesktopId?: string;
    macosCategory?: string;
    macosMicrophoneUsageDescription?: string;
    androidVersionCode?: number;
    androidAllowBackup?: boolean;
    androidIsGame?: boolean;
    localized?: Record<string, { displayName?: string; shortName?: string; description?: string }>;
  };
  display: z.infer<typeof normalizedPlatformDisplayMetadataSchema>;
  runtimeDisplay: z.infer<typeof playerDisplayMetadataSchema>;
  accessibility: z.infer<typeof playerAccessibilityMetadataSchema>;
  capabilities?: ExportCapability[];
  runtimePackageApi: number;
  host?: { platform: 'windows' | 'linux' | 'macos'; availableTools: string[] };
  // Signing inputs are deliberately request-local.  They are sourced from editor
  // secure settings or CI and must never be persisted in a project profile.
  windowsSigning?: {
    command: string;
    args: string[];
    verifyCommand?: string;
    verifyArgs?: string[];
  };
  linuxAppImageTool?: string;
  macosSigning?: { identity: string; entitlementsPath?: string };
  macosNotarization?: { command: string; args: string[] };
  macosDmg?: { command: string; args: string[] };
  androidToolchain?: {
    androidSdk?: string;
    androidNdk?: string;
    javaHome?: string;
    cmake?: string;
  };
  androidSigning?: {
    keystorePath: string;
    keyAlias: string;
    storePassword: string;
    keyPassword: string;
  };
}

export interface PreparedPlatformRuntimeExport {
  sourceFingerprint: string;
  recoveryFingerprint?: unknown;
  profile: ExportProfileData;
  compiledProject: unknown;
  packageOptions: PackageExportOptions;
  diagnostics: ProjectValidationDiagnostic[];
}
export interface PlatformStageResult {
  ok: boolean;
  success: boolean;
  cancelled: boolean;
  operationId: string;
  outputDirectory?: string;
  archivePath?: string;
  symbolArchivePath?: string;
  artifacts?: Array<{
    kind:
      | 'directory'
      | 'archive'
      | 'appimage'
      | 'app-bundle'
      | 'dmg'
      | 'symbols'
      | 'signing-report'
      | 'apk'
      | 'aab'
      | 'apk-set';
    path: string;
    size?: number;
  }>;
  webMetrics?: {
    compressedDownloadBytes: number;
    uncompressedPackageBytes: number;
    estimatedPeakStartupBytes: number;
  };
  diagnostics: PlatformStageDiagnostic[];
  deployment?: PlatformDeploymentModel;
  manifest?: PlatformExportManifest;
}

export interface ProjectPlatformExportRequest {
  projectPath?: string;
  project?: unknown;
  projectRoot?: string;
  profileId: string;
  outputDirectory: string;
  operationId?: string;
  templateToken?: string;
  preparedRuntimeExport?: PreparedPlatformRuntimeExport;
  localState?: {
    shaderc?: string;
    bgfxShaderIncludeDir?: string;
    androidSdk?: string;
    androidNdk?: string;
    javaHome?: string;
    cmake?: string;
    signing?: {
      windows?: { command: string; args: string[]; verifyCommand: string; verifyArgs: string[] };
      macos?: {
        identity: string;
        entitlementsPath?: string;
        notarizationCommand?: string;
        notarizationArgs?: string[];
      };
      android?: {
        keystorePath: string;
        keyAlias: string;
        storePasswordReference: string;
        keyPasswordReference: string;
      };
    };
  };
}

const projectValidationDiagnosticSchema = z
  .object({
    severity: z.enum(['info', 'warning', 'error']),
    code: z.string().min(1),
    path: z.string(),
    message: z.string(),
    category: z.string().optional(),
    boundaries: z.array(z.enum(['authoring', 'runtime-package', 'platform-export'])),
    ownerPaths: z.array(z.string()),
  })
  .strict();

const preparedPlatformRuntimeExportSchema = z
  .object({
    sourceFingerprint: z.string().regex(/^fnv1a:[0-9a-f]{8}$/),
    recoveryFingerprint: z.unknown().optional(),
    profile: exportProfileSchema,
    compiledProject: z.unknown(),
    packageOptions: z.object({}).passthrough(),
    diagnostics: z.array(projectValidationDiagnosticSchema),
  })
  .strict();

const projectPlatformExportRequestSchema = z
  .object({
    projectPath: z.string().min(1).optional(),
    project: z.unknown().optional(),
    projectRoot: z.string().min(1).optional(),
    profileId: z.string().min(1),
    outputDirectory: z.string().min(1),
    operationId: z.string().min(1).optional(),
    templateToken: z.string().min(1).optional(),
    preparedRuntimeExport: preparedPlatformRuntimeExportSchema.optional(),
    localState: z
      .object({
        shaderc: z.string().optional(),
        bgfxShaderIncludeDir: z.string().optional(),
        androidSdk: z.string().optional(),
        androidNdk: z.string().optional(),
        javaHome: z.string().optional(),
        cmake: z.string().optional(),
        signing: z
          .object({
            windows: z
              .object({
                command: z.string().min(1),
                args: z.array(z.string()),
                verifyCommand: z.string().min(1),
                verifyArgs: z.array(z.string()),
              })
              .strict()
              .optional(),
            macos: z
              .object({
                identity: z.string().min(1),
                entitlementsPath: z.string().optional(),
                notarizationCommand: z.string().optional(),
                notarizationArgs: z.array(z.string()).optional(),
              })
              .strict()
              .optional(),
            android: z
              .object({
                keystorePath: z.string().min(1),
                keyAlias: z.string().min(1),
                storePasswordReference: z.string().min(1),
                keyPasswordReference: z.string().min(1),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => Boolean(value.projectPath || (value.project && value.projectRoot)), {
    message: 'A project path or an in-memory project with projectRoot is required.',
    path: ['project'],
  });

export type PlatformExportProgressStage =
  | 'validating'
  | 'compiling-shaders'
  | 'compiling-project'
  | 'resolving-template'
  | 'writing-package'
  | 'generating-metadata'
  | 'staging'
  | 'finalizing'
  | 'verifying';

export interface PlatformExportProgressEvent {
  operationId: string;
  stage: PlatformExportProgressStage;
  message: string;
}

export const parsePlayerBootstrapConfig = (value: unknown): PlayerBootstrapConfig =>
  playerBootstrapConfigSchema.parse(value);
export const parseTemplateDescriptor = (value: unknown): TemplateDescriptor =>
  templateDescriptorSchema.parse(value);
export const parsePlatformExportProfile = (value: unknown): PlatformExportProfile =>
  platformExportProfileSchema.parse(value);
export const parseProjectPlatformExportRequest = (value: unknown): ProjectPlatformExportRequest =>
  projectPlatformExportRequestSchema.parse(value) as ProjectPlatformExportRequest;
export const parseEditorExportLocalState = (value: unknown): EditorExportLocalState =>
  editorExportLocalStateSchema.parse(value);
