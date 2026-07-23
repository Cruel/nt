import { publishCompiledArtifact } from '../compiled-artifact-publication';
import type { PackageExportOptions, ShaderCompileOutput } from '../editor-tooling';
import { parseAssetData, type AssetKind } from './authoring-assets';
import type { ExportProfileData, ExportShaderVariant } from './authoring-export';
import type { AuthoringProject } from './authoring-project';
import {
  defaultProjectAppIdentity,
  deriveProjectDisplayGeometry,
} from './authoring-project-settings';
import {
  classifyProjectValidationDiagnostics,
  collectProjectValidationDiagnostics,
  createProjectValidationDiagnostic,
  projectValidationBlocksBoundary,
  projectValidationBoundariesForCompilerDiagnostic,
  type ProjectValidationDiagnostic,
} from './project-validation';
import { validateAuthoringProject } from './authoring-validation';
import { canonicalProjectContentJson } from './editor-project-state';
import { buildShaderMaterialProject } from './shader-material-project';

export interface ExportFileEntry {
  source: string;
  packagePath: string;
  storage?: 'auto' | 'stored' | 'compressed';
  assetId?: string;
  kind?: AssetKind;
}

export type PackageFileEntry = ExportFileEntry;

export interface ExportManifestPreview {
  projectName: string;
  projectVersion: string;
  entryCount: number;
  assetCount: number;
  shaderVariants: string[];
  requiredShaderBinaryPaths: string[];
  display?: {
    reference_resolution: { width: number; height: number };
    world_raster_policy: 'capped' | 'native';
    bar_color: string;
  };
  accessibility?: PackageExportOptions['accessibility'];
  platform?: PackageExportOptions['platform'];
}

export interface CompiledRuntimeExportBuildOptions {
  projectRoot?: string | null;
  profile: ExportProfileData;
  recoveryFingerprint?: unknown;
  shaderOutputs?: readonly ShaderCompileOutput[];
}

export interface CompiledRuntimeExportBuildResult {
  ok: boolean;
  compiledArtifactAvailable: boolean;
  compiledProject?: unknown;
  gameplayJson?: string;
  shaderMaterialMetadata?: unknown;
  requiredShaderBinaryPaths: string[];
  fileEntries: ExportFileEntry[];
  manifestPreview: ExportManifestPreview;
  packageOptions: PackageExportOptions;
  diagnostics: ProjectValidationDiagnostic[];
  runtimeDiagnostics: ProjectValidationDiagnostic[];
  runtimeBlockers: ProjectValidationDiagnostic[];
  sourceFingerprint: string;
}

export const UNNAMED_RUNTIME_PROJECT = '[Unnamed Project]';
export const DEFAULT_RUNTIME_PROJECT_VERSION = '0.0.0';

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

export function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function compiledRuntimeExportSourceFingerprint(
  project: AuthoringProject,
  profile: ExportProfileData,
  recoveryFingerprint: unknown = null,
): string {
  return hashString(
    stableStringify({
      content: canonicalProjectContentJson(project),
      profile,
      recovery: recoveryFingerprint,
    }),
  );
}

function runtimeProjectName(value: string): string {
  return value.trim() ? value : UNNAMED_RUNTIME_PROJECT;
}

function runtimeProjectVersion(value: string): string {
  const trimmed = value.trim();
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(trimmed)
    ? trimmed
    : DEFAULT_RUNTIME_PROJECT_VERSION;
}

function runtimeCompilationProject(project: AuthoringProject): AuthoringProject {
  const runtimeProject = structuredClone(project);
  runtimeProject.project.name = runtimeProjectName(project.project.name);
  runtimeProject.project.version = runtimeProjectVersion(project.project.version);
  runtimeProject.settings = {
    ...runtimeProject.settings,
    app: defaultProjectAppIdentity(runtimeProject),
  };
  delete (runtimeProject.settings as Record<string, unknown>).platformExport;
  return runtimeProject;
}

function compilerDiagnosticsFor(
  published: ReturnType<typeof publishCompiledArtifact>,
): ProjectValidationDiagnostic[] {
  return classifyProjectValidationDiagnostics(
    published.diagnostics.map((item) => ({
      code: item.code,
      severity: item.severity,
      path: item.jsonPointer,
      message: item.message,
      category: item.code,
      ownerPaths: [item.jsonPointer],
      boundaries: projectValidationBoundariesForCompilerDiagnostic(item.code, item.jsonPointer),
    })),
    { producer: 'compiler' },
  );
}

function shaderMaterialMetadataWithOutputs(
  metadata: ReturnType<typeof buildShaderMaterialProject>['project'],
  outputs: readonly ShaderCompileOutput[],
): {
  metadata: ReturnType<typeof buildShaderMaterialProject>['project'];
  diagnostics: ProjectValidationDiagnostic[];
} {
  if (outputs.length === 0) return { metadata, diagnostics: [] };
  const next = structuredClone(metadata);
  const diagnostics: ProjectValidationDiagnostic[] = [];
  for (const output of outputs) {
    const shader = next.shaders[output.shader];
    const shaderRecord =
      shader && typeof shader === 'object' && !Array.isArray(shader)
        ? (shader as Record<string, unknown>)
        : null;
    const stages =
      shaderRecord?.stages &&
      typeof shaderRecord.stages === 'object' &&
      !Array.isArray(shaderRecord.stages)
        ? (shaderRecord.stages as Record<string, unknown>)
        : null;
    const stage = stages?.[output.stage];
    const stageRecord =
      stage && typeof stage === 'object' && !Array.isArray(stage)
        ? (stage as Record<string, unknown>)
        : null;
    if (!stageRecord) {
      diagnostics.push(
        createProjectValidationDiagnostic({
          code: 'runtime-export.shader-output.target-missing',
          severity: 'error',
          path: `/shaders/${output.shader}/data/stages`,
          message: `Compiled output targets missing shader stage '${output.shader}:${output.stage}'.`,
          category: 'Shader publication',
          boundaries: ['runtime-package'],
          ownerPaths: [`/shaders/${output.shader}`],
        }),
      );
      continue;
    }
    const compiled =
      stageRecord.compiled &&
      typeof stageRecord.compiled === 'object' &&
      !Array.isArray(stageRecord.compiled)
        ? (stageRecord.compiled as Record<string, unknown>)
        : {};
    stageRecord.compiled = { ...compiled, [output.variant]: output.runtimePath };
  }
  return { metadata: next, diagnostics };
}

function absoluteSourcePath(root: string | null | undefined, source: string) {
  if (/^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(source)) return source;
  const clean = source.replace(/^[/\\]+/, '').replace(/\\/g, '/');
  return root ? `${root.replace(/[\\/]+$/, '')}/${clean}` : clean;
}

function requiredShaderBinaryPaths(metadata: unknown, variants: readonly ExportShaderVariant[]) {
  const required = new Set<string>();
  const shaders =
    metadata && typeof metadata === 'object'
      ? (
          metadata as {
            shaders?: Record<
              string,
              { stages?: Record<string, { compiled?: Record<string, unknown> }> }
            >;
          }
        ).shaders
      : undefined;
  for (const shader of Object.values(shaders ?? {})) {
    for (const stage of Object.values(shader.stages ?? {})) {
      for (const variant of variants) {
        const path = stage.compiled?.[variant];
        if (typeof path === 'string' && path.startsWith('project:/')) {
          required.add(path.slice(9));
        }
      }
    }
  }
  return [...required].sort();
}

export function hasAuthoringShadersOrMaterials(project: AuthoringProject) {
  return Object.keys(project.shaders).length > 0 || Object.keys(project.materials).length > 0;
}

export function buildCompiledRuntimeExport(
  project: AuthoringProject,
  options: CompiledRuntimeExportBuildOptions,
): CompiledRuntimeExportBuildResult {
  const authoringDiagnostics = validateAuthoringProject(project);
  const runtimeProject = runtimeCompilationProject(project);
  const published = publishCompiledArtifact(runtimeProject);
  const compilerDiagnostics = compilerDiagnosticsFor(published);

  const compiledSettings = published.ok
    ? published.project.project.settings
    : runtimeProject.settings;
  const display = compiledSettings.display;
  const runtimeDisplay = {
    reference_resolution: { ...display.referenceResolution },
    world_raster_policy: display.worldRasterPolicy,
    bar_color: display.barColor,
  };
  const runtimeAccessibility = {
    ui_scale: { ...compiledSettings.accessibility.uiScale },
    text_scale: { ...compiledSettings.accessibility.textScale },
  };
  const displayGeometry = deriveProjectDisplayGeometry(display.referenceResolution)!;
  const portrait = displayGeometry.orientation === 'portrait';
  const platform: NonNullable<PackageExportOptions['platform']> = {
    orientation: displayGeometry.orientation,
    desktop: {
      initialWidth: portrait ? 720 : 1280,
      initialHeight: portrait ? 1280 : 720,
      arguments: ['--display-orientation', displayGeometry.orientation],
    },
    web: {
      orientation: displayGeometry.orientation,
      query: `orientation=${displayGeometry.orientation}`,
    },
    android: {
      orientation: displayGeometry.orientation,
      gradleProperty: `novelteaOrientation=${displayGeometry.orientation}`,
      screenOrientation: portrait ? 'sensorPortrait' : 'sensorLandscape',
    },
  };

  const compiledAssets = published.ok ? published.project.project.resources.assets : [];
  const fileEntries = compiledAssets.flatMap((asset): ExportFileEntry[] => {
    const authored = parseAssetData(project.assets[asset.id]?.data);
    if (!authored || (options.profile.kind === 'runtime' && authored.kind === 'shader-source')) {
      return [];
    }
    return [
      {
        source: absoluteSourcePath(options.projectRoot, authored.source.path),
        packagePath: asset.path,
        storage: authored.kind === 'audio' ? 'stored' : 'auto',
        assetId: asset.id,
        kind: authored.kind,
      },
    ];
  });

  const shaderBuild = buildShaderMaterialProject(project);
  const preparedShaderMetadata = shaderMaterialMetadataWithOutputs(
    shaderBuild.project,
    options.shaderOutputs ?? [],
  );
  const shaderDiagnostics = classifyProjectValidationDiagnostics(
    shaderBuild.diagnostics.map((item) => ({
      ...item,
      category: item.category ?? 'shader',
    })),
    { producer: 'shader-material' },
  );
  const entrypointDiagnostics = project.entrypoint
    ? []
    : [
        createProjectValidationDiagnostic({
          code: 'runtime-package.entrypoint.required',
          severity: 'error',
          path: '/entrypoint',
          message: 'Choose a gameplay entrypoint before running or packaging the project.',
          category: 'Runtime package readiness',
          boundaries: ['runtime-package'],
          ownerPaths: ['/entrypoint'],
        }),
      ];
  const diagnostics = collectProjectValidationDiagnostics(
    authoringDiagnostics,
    compilerDiagnostics,
    shaderDiagnostics,
    preparedShaderMetadata.diagnostics,
    entrypointDiagnostics,
  );
  const runtimeDiagnostics = diagnostics.filter((item) =>
    item.boundaries.includes('runtime-package'),
  );
  const runtimeBlockers = runtimeDiagnostics.filter((item) =>
    projectValidationBlocksBoundary(item, 'runtime-package'),
  );
  const hasMetadata =
    Object.keys(preparedShaderMetadata.metadata.shaders).length > 0 ||
    Object.keys(preparedShaderMetadata.metadata.materials).length > 0;
  const shaderMaterialMetadata = hasMetadata ? preparedShaderMetadata.metadata : undefined;
  const shaderVariants = shaderMaterialMetadata ? options.profile.shaderVariants : [];
  const required = shaderMaterialMetadata
    ? requiredShaderBinaryPaths(shaderMaterialMetadata, shaderVariants)
    : [];
  const generatedProjectName = runtimeProjectName(project.project.name);
  const generatedProjectVersion = runtimeProjectVersion(project.project.version);
  const manifestPreview = {
    projectName: generatedProjectName,
    projectVersion: generatedProjectVersion,
    entryCount: 1 + fileEntries.length + required.length + (shaderMaterialMetadata ? 1 : 0),
    assetCount: fileEntries.length,
    shaderVariants,
    requiredShaderBinaryPaths: required,
    display: runtimeDisplay,
    accessibility: runtimeAccessibility,
    platform,
  };
  const packageOptions: PackageExportOptions = {
    kind: options.profile.kind,
    projectName: generatedProjectName,
    projectVersion: generatedProjectVersion,
    createdBy: 'noveltea-editor',
    includeChecksums: options.profile.includeChecksums,
    stripShaderSources: options.profile.stripShaderSources,
    shaderVariants,
    shaderMaterialMetadata,
    requiredShaderBinaryPaths: required,
    fileEntries: fileEntries.map(({ source, packagePath, storage }) => ({
      source,
      packagePath,
      storage,
    })),
    requiredSeekablePaths: fileEntries
      .filter((entry) => entry.kind === 'audio')
      .map((entry) => entry.packagePath),
    display: runtimeDisplay,
    accessibility: runtimeAccessibility,
    platform,
  };

  return {
    ok: published.ok && runtimeBlockers.length === 0,
    compiledArtifactAvailable: published.ok,
    compiledProject: published.ok ? published.project.project : undefined,
    gameplayJson: published.ok ? published.project.gameplayJson : undefined,
    shaderMaterialMetadata,
    requiredShaderBinaryPaths: required,
    fileEntries,
    manifestPreview,
    packageOptions,
    diagnostics,
    runtimeDiagnostics,
    runtimeBlockers,
    sourceFingerprint: compiledRuntimeExportSourceFingerprint(
      project,
      options.profile,
      options.recoveryFingerprint ?? null,
    ),
  };
}
