import { publishCompiledArtifact } from '../compiled-artifact-publication';
import type { PackageExportOptions, ToolDiagnostic } from '../editor-tooling';
import { parseAssetData, type AssetKind } from './authoring-assets';
import type { ExportProfileData, ExportShaderVariant } from './authoring-export';
import type { AuthoringProject } from './authoring-project';
import {
  normalizeProjectDisplaySettings,
  projectSettingsFromProject,
} from './authoring-project-settings';
import { buildShaderMaterialProject } from './shader-material-project';

export interface ExportFileEntry {
  source: string;
  packagePath: string;
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
    aspect_ratio: { width: number; height: number };
    orientation: 'landscape' | 'portrait';
    bar_color: string;
  };
  platform?: PackageExportOptions['platform'];
}

export interface CompiledRuntimeExportBuildOptions {
  projectRoot?: string | null;
  profile: ExportProfileData;
}

export interface CompiledRuntimeExportBuildResult {
  ok: boolean;
  compiledProject?: unknown;
  gameplayJson?: string;
  shaderMaterialMetadata?: unknown;
  requiredShaderBinaryPaths: string[];
  fileEntries: ExportFileEntry[];
  manifestPreview: ExportManifestPreview;
  packageOptions: PackageExportOptions;
  diagnostics: ToolDiagnostic[];
}

function absoluteSourcePath(root: string | null | undefined, source: string) {
  if (/^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(source)) return source;
  const clean = source.replace(/^[/\\]+/, '').replace(/\\/g, '/');
  return root ? `${root.replace(/[\\/]+$/, '')}/${clean}` : clean;
}

function requiredShaderBinaryPaths(
  metadata: unknown,
  variants: readonly ExportShaderVariant[],
) {
  const required = new Set<string>();
  const shaders =
    metadata && typeof metadata === 'object'
      ? (metadata as {
          shaders?: Record<
            string,
            { stages?: Record<string, { compiled?: Record<string, unknown> }> }
          >;
        }).shaders
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
  const published = publishCompiledArtifact(project);
  const diagnostics: ToolDiagnostic[] = published.diagnostics.map((item) => ({
    severity: item.severity,
    path: item.jsonPointer,
    message: item.message,
    category: item.code,
  }));

  const display = normalizeProjectDisplaySettings(projectSettingsFromProject(project).display);
  const runtimeDisplay = {
    aspect_ratio: display.aspectRatio,
    orientation: display.orientation,
    bar_color: display.barColor,
  };
  const portrait = display.orientation === 'portrait';
  const platform: NonNullable<PackageExportOptions['platform']> = {
    orientation: display.orientation,
    desktop: {
      initialWidth: portrait ? 720 : 1280,
      initialHeight: portrait ? 1280 : 720,
      arguments: ['--display-orientation', display.orientation],
    },
    web: {
      orientation: display.orientation,
      query: `orientation=${display.orientation}`,
    },
    android: {
      orientation: display.orientation,
      gradleProperty: `novelteaOrientation=${display.orientation}`,
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
        assetId: asset.id,
        kind: authored.kind,
      },
    ];
  });

  const shaderBuild = buildShaderMaterialProject(project);
  diagnostics.push(
    ...shaderBuild.diagnostics.map((item) => ({
      ...item,
      category: item.category ?? 'shader',
    })),
  );
  const hasMetadata =
    Object.keys(shaderBuild.project.shaders).length > 0 ||
    Object.keys(shaderBuild.project.materials).length > 0;
  const shaderMaterialMetadata = hasMetadata ? shaderBuild.project : undefined;
  const shaderVariants = shaderMaterialMetadata ? options.profile.shaderVariants : [];
  const required = shaderMaterialMetadata
    ? requiredShaderBinaryPaths(shaderMaterialMetadata, shaderVariants)
    : [];
  const manifestPreview = {
    projectName: project.project.name,
    projectVersion: project.project.version,
    entryCount:
      1 + fileEntries.length + required.length + (shaderMaterialMetadata ? 1 : 0),
    assetCount: fileEntries.length,
    shaderVariants,
    requiredShaderBinaryPaths: required,
    display: runtimeDisplay,
    platform,
  };
  const packageOptions: PackageExportOptions = {
    kind: options.profile.kind,
    projectName: project.project.name,
    projectVersion: project.project.version,
    createdBy: 'noveltea-editor',
    includeChecksums: options.profile.includeChecksums,
    stripShaderSources: options.profile.stripShaderSources,
    shaderVariants,
    shaderMaterialMetadata,
    requiredShaderBinaryPaths: required,
    fileEntries: fileEntries.map(({ source, packagePath }) => ({ source, packagePath })),
    display: runtimeDisplay,
    platform,
  };

  return {
    ok: published.ok && !diagnostics.some((item) => item.severity === 'error'),
    compiledProject: published.ok ? published.project.project : undefined,
    gameplayJson: published.ok ? published.project.gameplayJson : undefined,
    shaderMaterialMetadata,
    requiredShaderBinaryPaths: required,
    fileEntries,
    manifestPreview,
    packageOptions,
    diagnostics,
  };
}
