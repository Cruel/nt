import { z } from 'zod';

export const PLAYER_CONFIG_FORMAT = 'noveltea.player-config' as const;
export const PLAYER_CONFIG_FORMAT_VERSION = 1 as const;
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
  'network.client', 'external-url', 'clipboard.read', 'clipboard.write', 'gamepad',
  'vibration', 'microphone', 'notifications', 'custom-url-scheme', 'billing',
] as const;
export const exportPlatformValues = ['windows', 'linux', 'macos', 'web', 'android'] as const;
export const exportBuildFlavorValues = ['debug', 'release'] as const;
export const exportArchitectureValues = ['x64', 'arm64', 'wasm32', 'x86_64'] as const;

export type ExportCapability = (typeof exportCapabilityValues)[number];
export type ExportPlatform = (typeof exportPlatformValues)[number];

const relativeArtifactPathSchema = z.string().min(1).refine((path) => {
  if (/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(path) || path.includes('\\')) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}, 'Path must be a normalized relative path without traversal.');

const capabilityArraySchema = z.array(z.enum(exportCapabilityValues)).transform((values) =>
  [...new Set(values)].sort((a, b) => a.localeCompare(b)),
);

export const normalizedPlatformDisplayMetadataSchema = z.object({
  aspectRatio: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
  orientation: z.enum(['landscape', 'portrait']),
  barColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
}).strict();

export const playerBootstrapConfigSchema = z.object({
  format: z.literal(PLAYER_CONFIG_FORMAT),
  formatVersion: z.literal(PLAYER_CONFIG_FORMAT_VERSION),
  displayName: z.string().trim().min(1),
  applicationId: z.string().trim().min(1),
  saveNamespace: z.string().trim().min(1),
  versionName: z.string().trim().min(1),
  defaultLocale: z.string().trim().min(1).optional(),
  package: z.object({
    path: relativeArtifactPathSchema,
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'SHA-256 must contain 64 lowercase hexadecimal characters.'),
    runtimePackageApi: z.number().int().nonnegative(),
  }).strict(),
  capabilities: capabilityArraySchema,
  display: normalizedPlatformDisplayMetadataSchema,
}).strict();

const runtimePackageApiRangeSchema = z.object({
  minimum: z.number().int().nonnegative(),
  maximum: z.number().int().nonnegative(),
}).strict().refine(({ minimum, maximum }) => minimum <= maximum, { message: 'Minimum package API must not exceed maximum.' });

export const templateDescriptorSchema = z.object({
  format: z.literal(TEMPLATE_DESCRIPTOR_FORMAT),
  formatVersion: z.literal(TEMPLATE_DESCRIPTOR_FORMAT_VERSION),
  templateId: z.string().trim().min(1),
  buildId: z.string().trim().min(1),
  engineVersion: z.string().trim().min(1),
  platform: z.enum(exportPlatformValues),
  architecture: z.enum(exportArchitectureValues),
  abi: z.string().trim().min(1).optional(),
  minimumPlatformVersion: z.string().trim().min(1),
  graphicsBackends: z.array(z.enum(['direct3d11', 'metal', 'opengl', 'opengles', 'webgl2', 'vulkan'])).min(1),
  shaderVariants: z.array(z.enum(['glsl-120', 'essl-100', 'essl-300'])).min(1),
  runtimePackageApi: runtimePackageApiRangeSchema,
  playerConfigApi: runtimePackageApiRangeSchema,
  compiledFeatures: z.array(z.string().trim().min(1)).transform((values) => [...new Set(values)].sort()),
  capabilities: capabilityArraySchema,
  buildFlavor: z.enum(exportBuildFlavorValues),
  packageAccessModes: z.array(z.enum(['sidecar', 'bundle-resource', 'web-fetch', 'android-asset', 'android-private-copy'])).min(1),
  files: z.array(z.object({
    path: relativeArtifactPathSchema,
    size: z.number().int().nonnegative(),
    mode: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    role: z.enum(['player', 'native-dependency', 'system-asset', 'notice', 'symbol', 'support']).optional(),
  }).strict()).min(1),
  runtimeDependencies: z.array(z.object({ path: relativeArtifactPathSchema, kind: z.enum(['library', 'asset', 'notice']) }).strict()),
  windowsImports: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9_.-]+\.dll$/)).optional(),
  linuxNeeded: z.array(z.string().trim().min(1)).optional(),
  linuxRpaths: z.array(z.string().trim().min(1)).optional(),
  macosDependencies: z.array(z.string().trim().min(1)).optional(),
  macosRpaths: z.array(z.string().trim().min(1)).optional(),
  macosMachO: z.array(z.object({
    path: relativeArtifactPathSchema,
    dependencies: z.array(z.string().trim().min(1)),
    rpaths: z.array(z.string().trim().min(1)),
    uuid: z.string().trim().min(1).optional(),
  }).strict()).optional(),
  artifacts: z.object({ archive: z.string().trim().min(1), symbols: z.string().trim().min(1), sbom: relativeArtifactPathSchema, notices: relativeArtifactPathSchema }).strict(),
  provenance: z.object({ provider: z.enum(['github-attestation', 'local']), subjectDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(), source: z.string().trim().min(1) }).strict(),
  host: z.object({ assembly: z.enum(['any', 'windows', 'linux', 'macos']), requiresToolchain: z.boolean(), tools: z.array(z.string().trim().min(1)).default([]) }).strict(),
}).strict();

const platformProfileBase = z.object({
  format: z.literal(PLATFORM_EXPORT_PROFILE_FORMAT),
  formatVersion: z.literal(PLATFORM_EXPORT_PROFILE_FORMAT_VERSION),
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  buildFlavor: z.enum(exportBuildFlavorValues),
  compression: z.enum(['default', 'store', 'maximum']).default('default'),
  includeDebugSymbols: z.boolean().default(false),
  capabilityOverrides: capabilityArraySchema.default([]),
});

const desktopProfileSchema = platformProfileBase.extend({
  target: z.enum(['windows', 'linux', 'macos']),
  architecture: z.enum(['x64', 'arm64']),
  packageAccess: z.enum(['sidecar', 'bundle-resource']),
  desktop: z.object({ artifact: z.enum(['zip', 'tar', 'appimage', 'app-bundle']), executableName: z.string().trim().min(1) }).strict(),
}).strict();
const webProfileSchema = platformProfileBase.extend({
  target: z.literal('web'), architecture: z.literal('wasm32'), packageAccess: z.literal('web-fetch'),
  web: z.object({
    artifact: z.literal('directory-zip'),
    threaded: z.boolean().default(false),
    pwa: z.boolean().default(false),
    display: z.enum(['fullscreen', 'standalone', 'minimal-ui', 'browser']).default('standalone'),
    basePath: z.string().regex(/^\/$|^\/[a-zA-Z0-9._~!$&'()*+,;=:@%/-]*\/$/, 'Web base path must begin and end with /.').default('/'),
    serviceWorker: z.enum(['disabled', 'offline']).default('disabled'),
  }).strict(),
}).strict();
const androidProfileSchema = platformProfileBase.extend({
  target: z.literal('android'), architecture: z.enum(['arm64', 'x86_64']), packageAccess: z.enum(['android-asset', 'android-private-copy']),
  android: z.object({ artifact: z.enum(['apk', 'aab']), abi: z.enum(['arm64-v8a', 'x86_64']), minSdk: z.number().int().min(24) }).strict(),
}).strict();

export const platformExportProfileSchema = z.discriminatedUnion('target', [desktopProfileSchema, webProfileSchema, androidProfileSchema]);

export const projectPlatformExportSettingsSchema = z.object({
  selectedProfileId: z.string().min(1),
  profiles: z.array(platformExportProfileSchema).min(1),
}).strict();

export type ProjectPlatformExportSettings = z.infer<typeof projectPlatformExportSettingsSchema>;

export function defaultPlatformExportProfile(target: ExportPlatform = 'linux'): PlatformExportProfile {
  const common = {
    format: PLATFORM_EXPORT_PROFILE_FORMAT,
    formatVersion: PLATFORM_EXPORT_PROFILE_FORMAT_VERSION,
    id: `${target}-release`,
    label: `${target[0]!.toUpperCase()}${target.slice(1)} Release`,
    buildFlavor: 'release' as const,
    compression: 'default' as const,
    includeDebugSymbols: false,
    capabilityOverrides: [] as ExportCapability[],
  };
  if (target === 'web') {
    return platformExportProfileSchema.parse({
      ...common,
      target,
      architecture: 'wasm32',
      packageAccess: 'web-fetch',
      web: { artifact: 'directory-zip', threaded: false, pwa: true, display: 'standalone', basePath: '/', serviceWorker: 'disabled' },
    });
  }
  if (target === 'android') {
    return platformExportProfileSchema.parse({
      ...common,
      target,
      architecture: 'arm64',
      packageAccess: 'android-asset',
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
  const profile = defaultPlatformExportProfile('linux');
  return { selectedProfileId: profile.id, profiles: [profile] };
}

export function parseProjectPlatformExportSettings(value: unknown): ProjectPlatformExportSettings {
  const parsed = projectPlatformExportSettingsSchema.safeParse(value);
  if (!parsed.success) return defaultProjectPlatformExportSettings();
  const selectedProfileId = parsed.data.profiles.some((profile) => profile.id === parsed.data.selectedProfileId)
    ? parsed.data.selectedProfileId
    : parsed.data.profiles[0]!.id;
  return { ...parsed.data, selectedProfileId };
}

export const editorExportLocalStateSchema = z.object({
  format: z.literal(EDITOR_EXPORT_LOCAL_STATE_FORMAT),
  formatVersion: z.literal(EDITOR_EXPORT_LOCAL_STATE_FORMAT_VERSION),
  lastOutputDirectory: z.string().optional(),
  templateRoots: z.array(z.string()).default([]),
  toolchains: z.object({ androidSdk: z.string().optional(), androidNdk: z.string().optional(), javaHome: z.string().optional(), cmake: z.string().optional() }).strict().default({}),
  signing: z.object({ certificatePath: z.string().optional(), keystorePath: z.string().optional(), identity: z.string().optional(), secretReferences: z.record(z.string(), z.string()).default({}) }).strict().default({ secretReferences: {} }),
}).strict();

export type PlayerBootstrapConfig = z.infer<typeof playerBootstrapConfigSchema>;
export type TemplateDescriptor = z.infer<typeof templateDescriptorSchema>;
export type PlatformExportProfile = z.infer<typeof platformExportProfileSchema>;
export type EditorExportLocalState = z.infer<typeof editorExportLocalStateSchema>;

export const templateCompatibilityRequirementsSchema = z.object({
  profile: platformExportProfileSchema,
  runtimePackageApi: z.number().int().nonnegative(),
  playerConfigApi: z.number().int().nonnegative().default(PLAYER_CONFIG_FORMAT_VERSION),
  shaderVariants: z.array(z.enum(['glsl-120', 'essl-100', 'essl-300'])).default([]),
  graphicsBackends: z.array(z.enum(['direct3d11', 'metal', 'opengl', 'opengles', 'webgl2', 'vulkan'])).default([]),
  capabilities: capabilityArraySchema.default([]),
  requiredFeatures: z.array(z.string().trim().min(1)).default([]),
  host: z.object({ platform: z.enum(['windows', 'linux', 'macos']), availableTools: z.array(z.string()) }).optional(),
}).strict();
export type TemplateCompatibilityRequirements = z.infer<typeof templateCompatibilityRequirementsSchema>;
export interface TemplateCompatibilityDiagnostic { code: string; path: string; message: string }
export interface TemplateCompatibilityResult { compatible: boolean; diagnostics: TemplateCompatibilityDiagnostic[] }

export const templateRegistryEntrySchema = z.object({
  format: z.literal(TEMPLATE_REGISTRY_FORMAT), formatVersion: z.literal(TEMPLATE_REGISTRY_FORMAT_VERSION),
  templateId: z.string().min(1), buildId: z.string().min(1), descriptorSha256: z.string().regex(/^[0-9a-f]{64}$/),
  archiveSha256: z.string().regex(/^[0-9a-f]{64}$/), installedAt: z.string().datetime(),
  origin: z.string().min(1), trust: z.enum(['official', 'local-untrusted']), verified: z.boolean(),
}).strict();
export type TemplateRegistryEntry = z.infer<typeof templateRegistryEntrySchema>;
export interface TemplateRegistryQuery { platform?: ExportPlatform; architecture?: string; buildFlavor?: 'debug' | 'release' }
export interface InstalledTemplate { entry: TemplateRegistryEntry; descriptor: TemplateDescriptor; status: 'installed' | 'corrupted' | 'untrusted'; compatibility?: TemplateCompatibilityResult }
export interface TemplateInstallRequest { archivePath: string; archiveSha256?: string; origin?: string; officialProvenance?: { archiveSha256: string; descriptorSha256: string; source: string } }
export interface TemplateInstallResult { success: boolean; entry?: TemplateRegistryEntry; diagnostics: TemplateCompatibilityDiagnostic[] }
export interface TemplateResolveRequest { requirements: TemplateCompatibilityRequirements }
export interface TemplateResolveResult { success: boolean; token?: string; template?: InstalledTemplate; diagnostics: TemplateCompatibilityDiagnostic[] }
export const templateRegistryIndexSchema = z.object({
  format: z.literal(TEMPLATE_REGISTRY_INDEX_FORMAT), formatVersion: z.literal(TEMPLATE_REGISTRY_INDEX_FORMAT_VERSION), generatedAt: z.string(),
  templates: z.array(z.object({ templateId: z.string(), buildId: z.string(), platform: z.enum(exportPlatformValues), architecture: z.string(), buildFlavor: z.enum(exportBuildFlavorValues), archive: z.string(), archiveSha256: z.string().regex(/^[0-9a-f]{64}$/), descriptorSha256: z.string().regex(/^[0-9a-f]{64}$/), symbols: z.string(), sbom: z.string(), notices: z.string(), provenance: z.string() }).strict()),
}).strict();

export const stagedFileOriginValues = ['template', 'runtime-package', 'system-asset', 'icon', 'native-dependency', 'notice', 'generated-metadata'] as const;
export type StagedFileOrigin = (typeof stagedFileOriginValues)[number];
export interface PlatformStageDiagnostic { severity: 'info' | 'warning' | 'error'; code: string; path: string; message: string }
export interface StagedFileEntry { path: string; origin: StagedFileOrigin; originId: string; size: number; mode: number; sha256: string }
export interface PlatformCapabilityMetadata {
  androidPermissions: string[]; androidFeatures: string[]; webRequirements: string[]; desktopFeatures: string[];
}
export interface PlatformDeploymentModel {
  target: ExportPlatform; architecture: string; buildFlavor: 'debug' | 'release'; applicationId: string;
  displayName: string; versionName: string; saveNamespace: string; capabilities: ExportCapability[];
  capabilityMetadata: PlatformCapabilityMetadata; display: z.infer<typeof normalizedPlatformDisplayMetadataSchema>;
  packageAccess: string; templateId: string; buildId: string; runtimePackageApi: number;
}
export interface PlatformExportManifest {
  format: typeof PLATFORM_EXPORT_MANIFEST_FORMAT; formatVersion: typeof PLATFORM_EXPORT_MANIFEST_FORMAT_VERSION;
  deployment: PlatformDeploymentModel; files: StagedFileEntry[];
}
export interface PlatformStageRequest {
  operationId: string; profile: PlatformExportProfile; templateToken: string; outputDirectory: string;
  packagePath: string; iconSourcePath?: string; systemAssetsRoot?: string;
  runtimePackageReadiness: {
    validated: boolean;
    blockingDiagnosticCount: number;
  };
  identity: {
    displayName: string; shortName?: string; applicationId: string; saveNamespace: string;
    versionName: string; defaultLocale?: string; themeColor?: string; backgroundColor?: string;
    webManifestId?: string; linuxDesktopId?: string;
    macosCategory?: string; macosMicrophoneUsageDescription?: string;
  };
  display: z.infer<typeof normalizedPlatformDisplayMetadataSchema>; capabilities?: ExportCapability[]; runtimePackageApi: number;
  host?: { platform: 'windows' | 'linux' | 'macos'; availableTools: string[] };
  windowsSigning?: { command: string; args: string[] };
  linuxAppImageTool?: string;
  macosSigning?: { identity: string; entitlementsPath?: string };
  macosNotarization?: { command: string; args: string[] };
  macosDmg?: { command: string; args: string[] };
}
export interface PlatformStageResult {
  ok: boolean; success: boolean; cancelled: boolean; operationId: string; outputDirectory?: string;
  archivePath?: string;
  symbolArchivePath?: string;
  artifacts?: Array<{ kind: 'directory' | 'archive' | 'appimage' | 'app-bundle' | 'dmg' | 'symbols'; path: string; size?: number }>;
  webMetrics?: { compressedDownloadBytes: number; uncompressedPackageBytes: number; estimatedPeakStartupBytes: number };
  diagnostics: PlatformStageDiagnostic[]; deployment?: PlatformDeploymentModel; manifest?: PlatformExportManifest;
}

export interface ProjectPlatformExportRequest {
  projectPath?: string;
  project?: unknown;
  projectRoot?: string;
  profileId: string;
  outputDirectory: string;
  operationId?: string;
  templateToken?: string;
  localState?: {
    androidSdk?: string;
    androidNdk?: string;
    javaHome?: string;
    cmake?: string;
    signingIdentity?: string;
    credentialReference?: string;
  };
}

export type PlatformExportProgressStage =
  | 'validating'
  | 'compiling-shaders'
  | 'building-runtime-project'
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

export const parsePlayerBootstrapConfig = (value: unknown): PlayerBootstrapConfig => playerBootstrapConfigSchema.parse(value);
export const parseTemplateDescriptor = (value: unknown): TemplateDescriptor => templateDescriptorSchema.parse(value);
export const parsePlatformExportProfile = (value: unknown): PlatformExportProfile => platformExportProfileSchema.parse(value);
export const parseEditorExportLocalState = (value: unknown): EditorExportLocalState => editorExportLocalStateSchema.parse(value);
