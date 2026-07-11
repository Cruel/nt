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
  platform: z.enum(exportPlatformValues),
  architecture: z.enum(exportArchitectureValues),
  abi: z.string().trim().min(1).optional(),
  minimumPlatformVersion: z.string().trim().min(1),
  graphicsBackends: z.array(z.enum(['direct3d11', 'metal', 'opengl', 'opengles', 'webgl2', 'vulkan'])).min(1),
  shaderVariants: z.array(z.enum(['glsl-120', 'essl-100', 'essl-300'])).min(1),
  runtimePackageApi: runtimePackageApiRangeSchema,
  compiledFeatures: z.array(z.string().trim().min(1)).transform((values) => [...new Set(values)].sort()),
  capabilities: capabilityArraySchema,
  buildFlavor: z.enum(exportBuildFlavorValues),
  runtimeDependencies: z.array(z.object({ path: relativeArtifactPathSchema, kind: z.enum(['library', 'asset', 'notice']) }).strict()),
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
  web: z.object({ artifact: z.literal('directory-zip'), threaded: z.boolean().default(false), pwa: z.boolean().default(false) }).strict(),
}).strict();
const androidProfileSchema = platformProfileBase.extend({
  target: z.literal('android'), architecture: z.enum(['arm64', 'x86_64']), packageAccess: z.enum(['android-asset', 'android-private-copy']),
  android: z.object({ artifact: z.enum(['apk', 'aab']), abi: z.enum(['arm64-v8a', 'x86_64']), minSdk: z.number().int().min(24) }).strict(),
}).strict();

export const platformExportProfileSchema = z.discriminatedUnion('target', [desktopProfileSchema, webProfileSchema, androidProfileSchema]);

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
  operationId: string; profile: PlatformExportProfile; templateRoot: string; outputDirectory: string;
  packagePath: string; iconSourcePath?: string; systemAssetsRoot?: string;
  runtimePackageReadiness: {
    validated: boolean;
    blockingDiagnosticCount: number;
  };
  identity: { displayName: string; applicationId: string; saveNamespace: string; versionName: string; defaultLocale?: string };
  display: z.infer<typeof normalizedPlatformDisplayMetadataSchema>; capabilities?: ExportCapability[]; runtimePackageApi: number;
  host?: { platform: 'windows' | 'linux' | 'macos'; availableTools: string[] };
}
export interface PlatformStageResult {
  ok: boolean; success: boolean; cancelled: boolean; operationId: string; outputDirectory?: string;
  diagnostics: PlatformStageDiagnostic[]; deployment?: PlatformDeploymentModel; manifest?: PlatformExportManifest;
}

export const parsePlayerBootstrapConfig = (value: unknown): PlayerBootstrapConfig => playerBootstrapConfigSchema.parse(value);
export const parseTemplateDescriptor = (value: unknown): TemplateDescriptor => templateDescriptorSchema.parse(value);
export const parsePlatformExportProfile = (value: unknown): PlatformExportProfile => platformExportProfileSchema.parse(value);
export const parseEditorExportLocalState = (value: unknown): EditorExportLocalState => editorExportLocalStateSchema.parse(value);
