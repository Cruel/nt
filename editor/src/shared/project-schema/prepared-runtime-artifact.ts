import { z } from 'zod';
import type { PackageExportOptions } from '../editor-tooling';
import { assetKindValues, type AssetKind } from './authoring-assets';
import { exportProfileSchema, type ExportProfileData } from './authoring-export';
import { compiledProjectWireV4Schema, type CompiledProjectWireV4 } from './compiled-project';
import type { ProjectValidationDiagnostic } from './project-validation';
import { shaderMaterialProjectWireSchema } from './shader-material-project';

export const PREPARED_RUNTIME_ARTIFACT_SCHEMA = 'noveltea.prepared-runtime-artifact' as const;
export const PREPARED_RUNTIME_ARTIFACT_SCHEMA_VERSION = 1 as const;

export interface ExportFileEntry {
  source: string;
  packagePath: string;
  storage: 'auto' | 'stored' | 'compressed';
  assetId: string;
  kind: AssetKind;
}

export type PackageFileEntry = ExportFileEntry;

export interface PreparedRuntimePackageOptions {
  kind: NonNullable<PackageExportOptions['kind']>;
  projectName: string;
  projectVersion: string;
  createdBy: string;
  includeChecksums: boolean;
  stripShaderSources: boolean;
  shaderAssetRoot?: string;
  shaderVariants: string[];
  shaderMaterialMetadata?: z.infer<typeof shaderMaterialProjectWireSchema>;
  requiredShaderBinaryPaths: string[];
  fileEntries: Array<{
    source: string;
    packagePath: string;
    storage: 'auto' | 'stored' | 'compressed';
  }>;
  requiredSeekablePaths: string[];
  display: NonNullable<PackageExportOptions['display']>;
  accessibility: NonNullable<PackageExportOptions['accessibility']>;
  platform: NonNullable<PackageExportOptions['platform']>;
}

export interface ExportManifestPreview {
  projectName: string;
  projectVersion: string;
  entryCount: number;
  assetCount: number;
  shaderVariants: string[];
  requiredShaderBinaryPaths: string[];
  display: NonNullable<PackageExportOptions['display']>;
  accessibility: NonNullable<PackageExportOptions['accessibility']>;
  platform: NonNullable<PackageExportOptions['platform']>;
}

export interface PreparedRuntimeArtifact {
  schema: typeof PREPARED_RUNTIME_ARTIFACT_SCHEMA;
  schemaVersion: typeof PREPARED_RUNTIME_ARTIFACT_SCHEMA_VERSION;
  sourceFingerprint: string;
  recoveryFingerprint?: unknown;
  profile: ExportProfileData;
  compiledProject: CompiledProjectWireV4;
  gameplayJson: string;
  shaderMaterialMetadata?: z.infer<typeof shaderMaterialProjectWireSchema>;
  requiredShaderBinaryPaths: string[];
  fileEntries: ExportFileEntry[];
  manifestPreview: ExportManifestPreview;
  packageOptions: PreparedRuntimePackageOptions;
  diagnostics: ProjectValidationDiagnostic[];
}

const diagnosticSchema = z
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

const fileEntrySchema = z
  .object({
    source: z.string(),
    packagePath: z.string(),
    storage: z.enum(['auto', 'stored', 'compressed']),
    assetId: z.string(),
    kind: z.enum(assetKindValues),
  })
  .strict();

const displaySchema = z
  .object({
    reference_resolution: z.object({ width: z.number(), height: z.number() }).strict(),
    world_raster_policy: z.enum(['capped', 'native']),
    bar_color: z.string(),
  })
  .strict();

const accessibilitySchema = z
  .object({
    ui_scale: z.object({ enabled: z.boolean(), minimum: z.number(), maximum: z.number() }).strict(),
    text_scale: z
      .object({ enabled: z.boolean(), minimum: z.number(), maximum: z.number() })
      .strict(),
  })
  .strict();

const platformSchema = z
  .object({
    orientation: z.enum(['landscape', 'portrait']),
    desktop: z
      .object({
        initialWidth: z.number(),
        initialHeight: z.number(),
        arguments: z.array(z.string()),
      })
      .strict(),
    web: z.object({ orientation: z.enum(['landscape', 'portrait']), query: z.string() }).strict(),
    android: z
      .object({
        orientation: z.enum(['landscape', 'portrait']),
        gradleProperty: z.string(),
        screenOrientation: z.enum(['sensorLandscape', 'sensorPortrait']),
      })
      .strict(),
  })
  .strict();

const packageOptionsSchema = z
  .object({
    kind: z.enum(['runtime', 'editable']),
    projectName: z.string(),
    projectVersion: z.string(),
    createdBy: z.string(),
    includeChecksums: z.boolean(),
    stripShaderSources: z.boolean(),
    shaderAssetRoot: z.string().optional(),
    shaderVariants: z.array(z.string()),
    shaderMaterialMetadata: shaderMaterialProjectWireSchema.optional(),
    requiredShaderBinaryPaths: z.array(z.string()),
    fileEntries: z.array(fileEntrySchema.pick({ source: true, packagePath: true, storage: true })),
    requiredSeekablePaths: z.array(z.string()),
    display: displaySchema,
    accessibility: accessibilitySchema,
    platform: platformSchema,
  })
  .strict();

const manifestPreviewSchema = z
  .object({
    projectName: z.string(),
    projectVersion: z.string(),
    entryCount: z.number().int().nonnegative(),
    assetCount: z.number().int().nonnegative(),
    shaderVariants: z.array(z.string()),
    requiredShaderBinaryPaths: z.array(z.string()),
    display: displaySchema,
    accessibility: accessibilitySchema,
    platform: platformSchema,
  })
  .strict();

export const preparedRuntimeArtifactSchema = z
  .object({
    schema: z.literal(PREPARED_RUNTIME_ARTIFACT_SCHEMA),
    schemaVersion: z.literal(PREPARED_RUNTIME_ARTIFACT_SCHEMA_VERSION),
    sourceFingerprint: z.string().regex(/^fnv1a:[0-9a-f]{8}$/),
    recoveryFingerprint: z.unknown().optional(),
    profile: exportProfileSchema,
    compiledProject: compiledProjectWireV4Schema,
    gameplayJson: z.string(),
    shaderMaterialMetadata: shaderMaterialProjectWireSchema.optional(),
    requiredShaderBinaryPaths: z.array(z.string()),
    fileEntries: z.array(fileEntrySchema),
    manifestPreview: manifestPreviewSchema,
    packageOptions: packageOptionsSchema,
    diagnostics: z.array(diagnosticSchema),
  })
  .strict();
