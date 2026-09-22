import { publishCompiledArtifact } from './compiled-artifact-publication';
import { applyExportLocalizationClosure } from './export-localization-closure';
import { buildAuthoringDependencyGraph } from './authoring-dependency-graph';
import { collectAuthoringSourceRequirements } from './authoring-source-analysis';
import type {
  PackageExportOptions,
  ShaderCompileDiagnostic,
  ShaderCompileOptions,
  ShaderCompileOutput,
  ShaderCompileResponse,
} from './editor-tooling';
import { parseAssetData } from './project-schema/authoring-assets';
import { parseLayoutData } from './project-schema/authoring-layouts';
import { parseScriptModuleData } from './project-schema/authoring-script-modules';
import { serializeCompiledProjectWire } from './project-schema/compiled-project';
import type { ExportProfileData, ExportShaderVariant } from './project-schema/authoring-export';
import { cloneAuthoringProject, type AuthoringProject } from './project-schema/authoring-project';
import type { LuaSourceSnapshot } from './project-schema/authoring-lua-analysis';
import { isSha256Digest, type Sha256Digest } from './project-text-sources';
import {
  defaultProjectAppIdentity,
  deriveProjectDisplayGeometry,
} from './project-schema/authoring-project-settings';
import {
  classifyProjectValidationDiagnostics,
  collectProjectValidationDiagnostics,
  createProjectValidationDiagnostic,
  projectValidationBlocksBoundary,
  projectValidationBoundariesForCompilerDiagnostic,
  type ProjectValidationDiagnostic,
} from './project-schema/project-validation';
import { validateAuthoringProject } from './project-schema/authoring-validation';
import {
  canonicalProjectContentJson,
  emptyEditorProjectState,
} from './project-schema/editor-project-state';
import {
  buildShaderMaterialProject,
  rewriteActiveTextSourcePrograms,
} from './project-schema/shader-material-project';
import {
  PREPARED_RUNTIME_ARTIFACT_SCHEMA,
  preparedRuntimeArtifactSchema,
  type ExportFileEntry,
  type ExportManifestPreview,
  type PreparedRuntimeArtifact,
  type PreparedRuntimePackageOptions,
} from './project-schema/prepared-runtime-artifact';

export { PREPARED_RUNTIME_ARTIFACT_SCHEMA, preparedRuntimeArtifactSchema };
export type {
  ExportFileEntry,
  ExportManifestPreview,
  PackageFileEntry,
  PreparedRuntimeArtifact,
} from './project-schema/prepared-runtime-artifact';

interface RuntimeArtifactAssemblyOptions {
  projectRoot?: string | null;
  profile: ExportProfileData;
  recoveryFingerprint?: unknown;
  shaderOutputs?: readonly ShaderCompileOutput[];
  paths: RuntimeArtifactPathAdapter;
}

export interface RuntimeArtifactAssessment {
  ready: boolean;
  compiledArtifactAvailable: boolean;
  compiledProject?: PreparedRuntimeArtifact['compiledProject'];
  gameplayJson?: string;
  shaderMaterialMetadata?: PreparedRuntimeArtifact['shaderMaterialMetadata'];
  requiredShaderBinaryPaths: string[];
  fileEntries: ExportFileEntry[];
  excludedUnusedAssetCount: number;
  manifestPreview: ExportManifestPreview;
  packageOptions: PreparedRuntimePackageOptions;
  localization: PreparedRuntimeArtifact['localization'];
  diagnostics: ProjectValidationDiagnostic[];
  runtimeDiagnostics: ProjectValidationDiagnostic[];
  runtimeBlockers: ProjectValidationDiagnostic[];
  sourceFingerprint: string;
}

export type RuntimeArtifactPreparationIntent =
  | 'play'
  | 'test-playback'
  | 'runtime-package-preflight'
  | 'runtime-package-export'
  | 'platform-preflight'
  | 'platform-export';

export type RuntimeArtifactPreparationStage = 'compiling-project' | 'compiling-shaders';

export interface RuntimeArtifactShaderCompilerAdapter {
  compile(shaderProject: unknown, options: ShaderCompileOptions): Promise<ShaderCompileResponse>;
}

export interface RuntimeArtifactPathAdapter {
  resolveProjectSource(projectRoot: string | null, source: string): string;
  shaderAssetRoot(projectRoot: string | null): string | undefined;
  readProjectTextSources?(
    projectRoot: string | null,
    entries: readonly {
      assetId: string;
      projectRelativePath: string;
      expectedContentHash: Sha256Digest | null;
    }[],
  ): Promise<
    readonly (
      | {
          status: 'ready';
          assetId: string;
          projectRelativePath: string;
          contentHash: Sha256Digest;
          text: string;
        }
      | { status: 'unavailable'; assetId: string }
    )[]
  >;
}

export const logicalRuntimeArtifactPaths: RuntimeArtifactPathAdapter = {
  resolveProjectSource(_projectRoot, source) {
    return source.replace(/\\/g, '/');
  },
  shaderAssetRoot() {
    return undefined;
  },
};

export interface PrepareRuntimeArtifactOptions {
  project: AuthoringProject;
  projectRoot: string | null;
  profile: ExportProfileData;
  intent: RuntimeArtifactPreparationIntent;
  recoveryFingerprint?: unknown;
  shaderCompiler?: RuntimeArtifactShaderCompilerAdapter;
  paths: RuntimeArtifactPathAdapter;
  isCancelled?: () => boolean;
  onStage?: (stage: RuntimeArtifactPreparationStage) => void;
}

export interface VerifyPreparedRuntimeArtifactOptions {
  project: AuthoringProject;
  projectRoot: string | null;
  profile: ExportProfileData;
  recoveryFingerprint?: unknown;
  paths: RuntimeArtifactPathAdapter;
}

export type PrepareRuntimeArtifactResult =
  | {
      status: 'prepared';
      artifact: PreparedRuntimeArtifact;
      assessment: RuntimeArtifactAssessment;
      shaderDiagnostics: ProjectValidationDiagnostic[];
      shaderOutputs: ShaderCompileOutput[];
    }
  | {
      status: 'blocked';
      diagnostics: ProjectValidationDiagnostic[];
      assessment: RuntimeArtifactAssessment;
      shaderDiagnostics: ProjectValidationDiagnostic[];
      shaderOutputs: ShaderCompileOutput[];
    }
  | {
      status: 'cancelled';
      diagnostics: ProjectValidationDiagnostic[];
    };

export interface VerifiedPreparedRuntimeArtifact {
  readonly artifact: PreparedRuntimeArtifact;
}

export type VerifyPreparedRuntimeArtifactResult =
  | { status: 'verified'; verified: VerifiedPreparedRuntimeArtifact }
  | { status: 'rejected'; diagnostics: ProjectValidationDiagnostic[] };

export const UNNAMED_RUNTIME_PROJECT = '[Unnamed Project]';
export const DEFAULT_RUNTIME_PROJECT_VERSION = '0.0.0';

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function partitionRuntimeLocalizationCatalogs(
  project: PreparedRuntimeArtifact['compiledProject'],
): {
  project: PreparedRuntimeArtifact['compiledProject'];
  textEntries: PreparedRuntimePackageOptions['textEntries'];
} {
  const residentLocales = new Set([
    project.localization.sourceLocale,
    project.localization.defaultLocale,
  ]);
  const externalCatalogs = project.localization.catalogs.filter(
    (catalog) => !residentLocales.has(catalog.locale),
  );
  if (externalCatalogs.length === 0) return { project, textEntries: [] };
  const catalogPaths = new Map(
    externalCatalogs.map(
      (catalog) => [catalog.locale, `localization/${catalog.locale}.json`] as const,
    ),
  );
  return {
    project: {
      ...project,
      localization: {
        ...project.localization,
        locales: project.localization.locales.map((locale) => {
          const catalogPath = catalogPaths.get(locale.locale);
          return catalogPath ? { ...locale, catalogPath } : locale;
        }),
        catalogs: project.localization.catalogs.filter((catalog) =>
          residentLocales.has(catalog.locale),
        ),
      },
    },
    textEntries: externalCatalogs.map((catalog) => ({
      text: `${stableStringify(catalog)}\n`,
      packagePath: catalogPaths.get(catalog.locale)!,
      storage: 'compressed' as const,
    })),
  };
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function preparedRuntimeArtifactSourceFingerprint(
  project: AuthoringProject,
  profile: ExportProfileData,
  recoveryFingerprint: unknown = null,
): string {
  const runtimeContentProject = cloneAuthoringProject(project);
  runtimeContentProject.tests = {};
  return hashString(
    stableStringify({
      content: canonicalProjectContentJson(runtimeContentProject),
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
  const runtimeProject = cloneAuthoringProject(project);
  runtimeProject.editor = emptyEditorProjectState();
  runtimeProject.project.name = runtimeProjectName(project.project.name);
  runtimeProject.project.version = runtimeProjectVersion(project.project.version);
  runtimeProject.settings = {
    ...runtimeProject.settings,
    app: defaultProjectAppIdentity(runtimeProject),
  };
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
        const compiled = stage.compiled?.[variant];
        const path =
          compiled &&
          typeof compiled === 'object' &&
          'runtimePath' in compiled &&
          typeof compiled.runtimePath === 'string'
            ? compiled.runtimePath
            : null;
        if (path?.startsWith('project:/')) {
          required.add(path.slice(9));
        }
      }
    }
  }
  return [...required].sort();
}

export function hasAuthoringShadersOrMaterials(project: AuthoringProject) {
  return Object.keys(project.materials).length > 0;
}

function localizationOwnsAssetReference(sourcePath: string): boolean {
  return (
    sourcePath.startsWith('/localization/assets/') ||
    (sourcePath.startsWith('/localization/locales/') && sourcePath.includes('/fontStack'))
  );
}

interface RuntimeSourceGraphAssessment {
  referencedAssetIds: ReadonlySet<string>;
  diagnostics: ProjectValidationDiagnostic[];
}

async function runtimeSourceGraphAssessment(
  project: AuthoringProject,
  projectRoot: string | null,
  paths: RuntimeArtifactPathAdapter,
): Promise<RuntimeSourceGraphAssessment | null> {
  const requiredSourceAssetIds = collectAuthoringSourceRequirements(project);
  const assetReadEntries = requiredSourceAssetIds.flatMap((assetId) => {
    const data = parseAssetData(project.assets[assetId]?.data);
    const hash = data?.contentHash;
    return data && hash && isSha256Digest(hash)
      ? [{ assetId, projectRelativePath: data.source.path, expectedContentHash: hash }]
      : [];
  });
  if (assetReadEntries.length !== requiredSourceAssetIds.length) return null;

  const projectFilePaths = new Set<string>();
  for (const record of Object.values(project.scripts)) {
    const source = parseScriptModuleData(record.data)?.source;
    if (source?.kind === 'project-file') projectFilePaths.add(source.path);
  }
  for (const record of Object.values(project.layouts)) {
    const layout = parseLayoutData(record.data);
    for (const scriptPath of layout?.dependencies.scripts ?? []) projectFilePaths.add(scriptPath);
  }
  const projectFileReadEntries = [...projectFilePaths].sort().map((projectRelativePath, index) => ({
    assetId: `project-file:${index}`,
    projectRelativePath,
    expectedContentHash: null,
  }));
  const readEntries = [...assetReadEntries, ...projectFileReadEntries];
  if (readEntries.length > 0 && !paths.readProjectTextSources) return null;

  const readResults = paths.readProjectTextSources
    ? await paths.readProjectTextSources(projectRoot, readEntries)
    : [];
  const byReadKey = new Map(readResults.map((entry) => [entry.assetId, entry]));
  if (readEntries.some(({ assetId }) => byReadKey.get(assetId)?.status !== 'ready')) return null;

  const sources: LuaSourceSnapshot = {
    entriesByAssetId: new Map(
      assetReadEntries.map(({ assetId, expectedContentHash, projectRelativePath }) => {
        const entry = byReadKey.get(assetId)!;
        if (entry.status !== 'ready')
          throw new Error('Source-read completeness changed unexpectedly.');
        return [
          assetId,
          {
            status: 'ready' as const,
            assetId,
            projectRelativePath,
            contentHash: entry.contentHash ?? expectedContentHash,
            text: entry.text,
            hadUtf8Bom: false,
          },
        ];
      }),
    ),
    entriesByProjectPath: new Map(
      projectFileReadEntries.map(({ assetId, projectRelativePath }) => {
        const entry = byReadKey.get(assetId)!;
        if (entry.status !== 'ready')
          throw new Error('Source-read completeness changed unexpectedly.');
        return [
          projectRelativePath,
          {
            status: 'ready' as const,
            projectRelativePath,
            contentHash: entry.contentHash,
            text: entry.text,
            hadUtf8Bom: false,
          },
        ];
      }),
    ),
  };
  const graph = await buildAuthoringDependencyGraph(project, { mode: 'enabled', sources });
  const referenced = new Set<string>();
  for (const edge of graph.edgesById.values()) {
    if (
      edge.target.kind === 'record' &&
      edge.target.collection === 'assets' &&
      !localizationOwnsAssetReference(edge.sourcePath)
    )
      referenced.add(edge.target.id);
  }
  return {
    referencedAssetIds: referenced,
    diagnostics: classifyProjectValidationDiagnostics(
      graph.diagnostics.map((diagnostic) => ({ ...diagnostic, category: 'Layouts' })),
      { producer: 'authoring' },
    ),
  };
}

async function referencedRuntimeAssetIds(
  project: AuthoringProject,
  projectRoot: string | null,
  paths: RuntimeArtifactPathAdapter,
): Promise<ReadonlySet<string> | null> {
  return (
    (await runtimeSourceGraphAssessment(project, projectRoot, paths))?.referencedAssetIds ?? null
  );
}

type CompiledMaterialInterface =
  PreparedRuntimeArtifact['compiledProject']['resources']['materialInterfaces'][number];
type CompiledMaterialParameterType = CompiledMaterialInterface['parameters'][number]['type'];

function materialParameterValueMatches(
  type: CompiledMaterialParameterType,
  value: unknown,
): boolean {
  switch (type) {
    case 'float':
      return typeof value === 'number' && Number.isFinite(value);
    case 'int':
      return typeof value === 'number' && Number.isInteger(value);
    case 'bool':
      return typeof value === 'boolean';
    case 'vec2':
      return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
    case 'vec3':
      return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
    case 'vec4':
      return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite);
    case 'color':
      return (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        ['r', 'g', 'b', 'a'].every(
          (key) =>
            typeof (value as Record<string, unknown>)[key] === 'number' &&
            Number.isFinite((value as Record<string, number>)[key]),
        )
      );
  }
}

function reconcileCompiledMaterialParameters<T>(
  value: T,
  interfaces: readonly CompiledMaterialInterface[],
): { value: T; diagnostics: ProjectValidationDiagnostic[] } {
  const byMaterial = new Map(interfaces.map((item) => [item.id, item]));
  const diagnostics: ProjectValidationDiagnostic[] = [];
  const reconcileValue = (
    materialId: string,
    parameterName: string,
    compiledValue: unknown,
    path: string,
    transition?: unknown,
  ): unknown => {
    const material = byMaterial.get(materialId);
    const parameter = material?.parameters.find((item) => item.name === parameterName);
    if (!parameter) {
      diagnostics.push(
        createProjectValidationDiagnostic({
          code: 'runtime-artifact.material-parameter.unknown',
          severity: 'error',
          path: `${path}/parameter`,
          message: `Material '${materialId}' reflected interface does not declare parameter '${parameterName}'.`,
          category: 'Materials',
          boundaries: ['runtime-package'],
          ownerPaths: [`/materials/${materialId}`],
        }),
      );
      return compiledValue;
    }
    if (parameter.rendererBinding !== null) {
      diagnostics.push(
        createProjectValidationDiagnostic({
          code: 'runtime-artifact.material-parameter.renderer-bound',
          severity: 'error',
          path: `${path}/parameter`,
          message: `Material parameter '${materialId}.${parameterName}' is runtime-owned and cannot be occurrence-controlled.`,
          category: 'Materials',
          boundaries: ['runtime-package'],
          ownerPaths: [`/materials/${materialId}`],
        }),
      );
      return compiledValue;
    }
    const raw =
      compiledValue && typeof compiledValue === 'object' && 'value' in compiledValue
        ? (compiledValue as { value: unknown }).value
        : undefined;
    if (!materialParameterValueMatches(parameter.type, raw)) {
      diagnostics.push(
        createProjectValidationDiagnostic({
          code: 'runtime-artifact.material-parameter.type',
          severity: 'error',
          path: `${path}/value`,
          message: `Material parameter '${materialId}.${parameterName}' value does not match reflected type '${parameter.type}'.`,
          category: 'Materials',
          boundaries: ['runtime-package'],
          ownerPaths: [`/materials/${materialId}`],
        }),
      );
      return compiledValue;
    }
    if (transition === 'tween' && (parameter.type === 'bool' || parameter.type === 'int'))
      diagnostics.push(
        createProjectValidationDiagnostic({
          code: 'runtime-artifact.material-parameter.transition',
          severity: 'error',
          path: `${path}/transition`,
          message: `Material parameter '${materialId}.${parameterName}' cannot use finite interpolation for reflected type '${parameter.type}'.`,
          category: 'Materials',
          boundaries: ['runtime-package'],
          ownerPaths: [`/materials/${materialId}`],
        }),
      );
    return { type: parameter.type, value: raw };
  };

  const visit = (current: unknown, path: string): unknown => {
    if (Array.isArray(current))
      return current.map((item, index) => visit(item, `${path}/${index}`));
    if (!current || typeof current !== 'object') return current;
    const record = current as Record<string, unknown>;
    const next = Object.fromEntries(
      Object.entries(record).map(([key, item]) => [key, visit(item, `${path}/${key}`)]),
    );
    if (
      record.kind === 'material-parameter' &&
      record.material &&
      typeof record.material === 'object' &&
      typeof (record.material as Record<string, unknown>).id === 'string' &&
      typeof record.parameter === 'string'
    )
      next.value = reconcileValue(
        (record.material as Record<string, string>).id,
        record.parameter,
        record.value,
        path,
        record.transition,
      );
    if (
      record.kind === 'postprocess-effect' &&
      record.material &&
      typeof record.material === 'object' &&
      typeof (record.material as Record<string, unknown>).id === 'string' &&
      Array.isArray(record.parameters)
    ) {
      const materialId = (record.material as Record<string, string>).id;
      next.parameters = record.parameters.map((parameter, index) => {
        if (!parameter || typeof parameter !== 'object') return parameter;
        const item = parameter as Record<string, unknown>;
        if (typeof item.name !== 'string') return parameter;
        return {
          ...item,
          value: reconcileValue(materialId, item.name, item.value, `${path}/parameters/${index}`),
        };
      });
    }
    return next;
  };

  return { value: visit(value, '') as T, diagnostics };
}

function rewriteCompiledActiveTextSourcePrograms<T>(
  value: T,
  programs: ReadonlyMap<string, string>,
): T {
  if (typeof value === 'string') return rewriteActiveTextSourcePrograms(value, programs) as T;
  if (Array.isArray(value))
    return value.map((item) => rewriteCompiledActiveTextSourcePrograms(item, programs)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        rewriteCompiledActiveTextSourcePrograms(item, programs),
      ]),
    ) as T;
  return value;
}

async function assembleRuntimeArtifact(
  project: AuthoringProject,
  options: RuntimeArtifactAssemblyOptions,
): Promise<RuntimeArtifactAssessment> {
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

  const sourceGraph = await runtimeSourceGraphAssessment(
    project,
    options.projectRoot ?? null,
    options.paths,
  );
  const runtimeReferencedAssetIds = sourceGraph?.referencedAssetIds ?? null;
  const referencedAssetIds = options.profile.excludeUnusedAssets ? runtimeReferencedAssetIds : null;
  const localizationClosure = published.ok
    ? applyExportLocalizationClosure(
        project,
        published.project.project,
        options.profile.localization,
        runtimeReferencedAssetIds,
      )
    : null;
  const localizedCompiledProject = localizationClosure?.project;
  const compiledAssets = localizedCompiledProject?.resources.assets ?? [];
  const excludedUnusedAssetCount = referencedAssetIds
    ? compiledAssets.filter(
        (asset) =>
          !referencedAssetIds.has(asset.id) &&
          !localizationClosure?.requiredLocalizationAssetIds.has(asset.id),
      ).length
    : 0;
  const includedCompiledAssets = compiledAssets.filter((asset) => {
    if (
      referencedAssetIds &&
      !referencedAssetIds.has(asset.id) &&
      !localizationClosure?.requiredLocalizationAssetIds.has(asset.id)
    )
      return false;
    return true;
  });
  const unpartitionedCompiledProject = localizedCompiledProject
    ? {
        ...localizedCompiledProject,
        resources: { ...localizedCompiledProject.resources, assets: includedCompiledAssets },
      }
    : undefined;
  const partitioned = unpartitionedCompiledProject
    ? partitionRuntimeLocalizationCatalogs(unpartitionedCompiledProject)
    : null;
  let compiledProject = partitioned?.project;
  const localizationTextEntries = partitioned?.textEntries ?? [];
  let gameplayJson = compiledProject ? serializeCompiledProjectWire(compiledProject) : undefined;
  const fileEntries = includedCompiledAssets.flatMap((asset): ExportFileEntry[] => {
    if (localizationClosure && !localizationClosure.payloadAssetIds.has(asset.id)) return [];
    const authored = parseAssetData(project.assets[asset.id]?.data);
    if (!authored) return [];
    return [
      {
        source: options.paths.resolveProjectSource(
          options.projectRoot ?? null,
          authored.source.path,
        ),
        packagePath: asset.path,
        storage: authored.kind === 'audio' ? 'stored' : 'auto',
        assetId: asset.id,
        kind: authored.kind,
      },
    ];
  });
  const packagedSourcePaths = new Set<string>();
  for (const [scriptId, record] of Object.entries(project.scripts)) {
    const source = parseScriptModuleData(record.data)?.source;
    if (source?.kind !== 'project-file') continue;
    packagedSourcePaths.add(source.path);
    fileEntries.push({
      source: options.paths.resolveProjectSource(options.projectRoot ?? null, source.path),
      packagePath: source.path,
      storage: 'auto',
      assetId: scriptId,
      kind: 'script-source',
    });
  }
  for (const record of Object.values(project.layouts)) {
    const layout = parseLayoutData(record.data);
    for (const scriptPath of layout?.dependencies.scripts ?? []) {
      if (packagedSourcePaths.has(scriptPath)) continue;
      packagedSourcePaths.add(scriptPath);
      fileEntries.push({
        source: options.paths.resolveProjectSource(options.projectRoot ?? null, scriptPath),
        packagePath: scriptPath,
        storage: 'auto',
        assetId: `source:${scriptPath}`,
        kind: 'script-source',
      });
    }
  }

  const shaderBuild = await buildShaderMaterialProject(project, options.shaderOutputs ?? []);
  if (compiledProject && shaderBuild.activeTextSourcePrograms.size > 0)
    compiledProject = rewriteCompiledActiveTextSourcePrograms(
      compiledProject,
      shaderBuild.activeTextSourcePrograms,
    );
  if (!options.profile.stripShaderSources) {
    const shaderSourcePaths = new Set<string>();
    const addShaderIdentity = (identity: string) => {
      if (!identity.startsWith('project:/shaders/')) return;
      shaderSourcePaths.add(identity.slice('project:/'.length));
    };
    for (const request of Object.values(shaderBuild.compilation.programs)) {
      addShaderIdentity(request.vertexSource);
      addShaderIdentity(request.fragmentSource);
      addShaderIdentity(request.varyingDefinition);
    }
    for (const output of options.shaderOutputs ?? [])
      for (const dependency of output.dependencies) addShaderIdentity(dependency);
    for (const sourcePath of [...shaderSourcePaths].sort()) {
      if (packagedSourcePaths.has(sourcePath)) continue;
      packagedSourcePaths.add(sourcePath);
      fileEntries.push({
        source: options.paths.resolveProjectSource(options.projectRoot ?? null, sourcePath),
        packagePath: sourcePath,
        storage: 'auto',
        assetId: `source:${sourcePath}`,
        kind: 'shader-source',
      });
    }
  }
  let materialParameterDiagnostics: ProjectValidationDiagnostic[] = [];
  if (compiledProject) {
    const materialInterfaces = Object.entries(shaderBuild.project.materials)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, material]) => {
        const shader = shaderBuild.project.shaders[material.shader];
        return {
          id,
          role: material.role,
          parameters: Object.entries(shader?.uniforms ?? {})
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, uniform]) => ({
              name,
              type: uniform.type,
              rendererBinding: uniform.binding ?? null,
            })),
        };
      });
    compiledProject = {
      ...compiledProject,
      resources: { ...compiledProject.resources, materialInterfaces },
    };
    if (options.shaderOutputs !== undefined) {
      const reconciled = reconcileCompiledMaterialParameters(compiledProject, materialInterfaces);
      compiledProject = reconciled.value;
      materialParameterDiagnostics = reconciled.diagnostics;
    }
    gameplayJson = serializeCompiledProjectWire(compiledProject);
  }
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
    sourceGraph?.diagnostics ?? [],
    compilerDiagnostics,
    shaderDiagnostics,
    materialParameterDiagnostics,
    localizationClosure?.diagnostics ?? [],
    entrypointDiagnostics,
  );
  const runtimeDiagnostics = diagnostics.filter((item) =>
    item.boundaries.includes('runtime-package'),
  );
  const runtimeBlockers = runtimeDiagnostics.filter((item) =>
    projectValidationBlocksBoundary(item, 'runtime-package'),
  );
  const hasMetadata =
    Object.keys(shaderBuild.project.shaders).length > 0 ||
    Object.keys(shaderBuild.project.materials).length > 0;
  const shaderMaterialMetadata = hasMetadata ? shaderBuild.project : undefined;
  const shaderVariants = shaderMaterialMetadata ? options.profile.shaderVariants : [];
  const required = shaderMaterialMetadata
    ? requiredShaderBinaryPaths(shaderMaterialMetadata, shaderVariants)
    : [];
  const generatedProjectName = runtimeProjectName(project.project.name);
  const generatedProjectVersion = runtimeProjectVersion(project.project.version);
  const manifestPreview = {
    projectName: generatedProjectName,
    projectVersion: generatedProjectVersion,
    entryCount:
      1 +
      fileEntries.length +
      localizationTextEntries.length +
      required.length +
      (shaderMaterialMetadata ? 1 : 0),
    assetCount: fileEntries.length,
    shaderVariants,
    requiredShaderBinaryPaths: required,
    display: runtimeDisplay,
    accessibility: runtimeAccessibility,
    platform,
  };
  const packageOptions: PreparedRuntimePackageOptions = {
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
    textEntries: localizationTextEntries,
    requiredSeekablePaths: fileEntries
      .filter((entry) => entry.kind === 'audio')
      .map((entry) => entry.packagePath),
    display: runtimeDisplay,
    accessibility: runtimeAccessibility,
    platform,
  };

  return {
    ready: published.ok && runtimeBlockers.length === 0,
    compiledArtifactAvailable: published.ok,
    compiledProject,
    gameplayJson,
    shaderMaterialMetadata,
    requiredShaderBinaryPaths: required,
    fileEntries,
    excludedUnusedAssetCount,
    manifestPreview,
    packageOptions,
    localization: localizationClosure?.closure ?? {
      includedLocales: options.profile.localization.locales,
      defaultLocale: options.profile.localization.defaultLocale,
      quality: options.profile.localization.quality,
      sourceFallback: { messageCount: 0, assetCount: 0 },
    },
    diagnostics,
    runtimeDiagnostics,
    runtimeBlockers,
    sourceFingerprint: preparedRuntimeArtifactSourceFingerprint(
      project,
      options.profile,
      options.recoveryFingerprint ?? null,
    ),
  };
}

const cancelledDiagnostic = () =>
  createProjectValidationDiagnostic({
    code: 'runtime-artifact.preparation.cancelled',
    severity: 'warning',
    path: '/',
    message: 'Runtime artifact preparation was cancelled.',
    category: 'Runtime package readiness',
    boundaries: ['runtime-package'],
    ownerPaths: ['/'],
  });

function shaderExecutionDiagnostics(
  diagnostics: readonly ShaderCompileDiagnostic[],
): ProjectValidationDiagnostic[] {
  return classifyProjectValidationDiagnostics(
    diagnostics.map((item) => ({
      ...item,
      code: item.code ?? 'shader.compile.failed',
      path: item.path ?? item.outputPath ?? item.sourcePath ?? '/shaders',
      category: 'shader',
    })),
    { producer: 'shader-compile' },
  );
}

async function validateShaderOutputs(
  programs: Readonly<Record<string, { vertexSource: string; fragmentSource: string }>>,
  variants: readonly string[],
  outputs: readonly ShaderCompileOutput[],
  projectRoot: string | null,
  paths: RuntimeArtifactPathAdapter,
): Promise<{ outputs: ShaderCompileOutput[]; diagnostics: ProjectValidationDiagnostic[] }> {
  const accepted: ShaderCompileOutput[] = [];
  const diagnostics: ProjectValidationDiagnostic[] = [];
  const seen = new Set<string>();
  const identityByProgram = new Map<string, string>();
  for (const output of outputs) {
    const key = `${output.program}:${output.stage}:${output.variant}`;
    const request = programs[output.program];
    const expectedSource =
      output.stage === 'vertex' ? request?.vertexSource : request?.fragmentSource;
    const valid =
      request !== undefined &&
      variants.includes(output.variant) &&
      output.sourceIdentity === expectedSource &&
      output.dependencyRevisions.length === output.dependencies.length &&
      output.dependencyRevisions.every(
        (revision, index) => revision.identity === output.dependencies[index],
      ) &&
      output.runtimePath.startsWith(`project:/shaders/derived/${output.variant}/`) &&
      /^sha256:[0-9a-f]{64}$/.test(output.byteHash) &&
      Number.isSafeInteger(output.byteSize) &&
      output.byteSize >= 0 &&
      output.programIdentity.length > 0;
    if (!valid || seen.has(key)) {
      diagnostics.push(
        createProjectValidationDiagnostic({
          code: seen.has(key)
            ? 'runtime-artifact.shader-output-duplicate'
            : 'runtime-artifact.shader-output-invalid',
          severity: 'error',
          path: '/materials',
          message: `Shader compiler returned invalid output '${key}'.`,
          category: 'shader',
          boundaries: ['runtime-package'],
          ownerPaths: ['/materials'],
        }),
      );
      continue;
    }
    const identity = identityByProgram.get(output.program);
    if (identity && identity !== output.programIdentity) {
      diagnostics.push(
        createProjectValidationDiagnostic({
          code: 'runtime-artifact.shader-program-identity-inconsistent',
          severity: 'error',
          path: '/materials',
          message: `Shader compiler returned inconsistent program identity for '${output.program}'.`,
          category: 'shader',
          boundaries: ['runtime-package'],
          ownerPaths: ['/materials'],
        }),
      );
      continue;
    }
    identityByProgram.set(output.program, output.programIdentity);
    seen.add(key);
    accepted.push(output);
  }
  const projectDependencies = new Map<string, Sha256Digest>();
  for (const output of accepted)
    for (const dependency of output.dependencyRevisions) {
      if (!dependency.identity.startsWith('project:/')) continue;
      const relativePath = dependency.identity.slice('project:/'.length);
      const current = projectDependencies.get(relativePath);
      if (current && current !== dependency.contentHash) {
        diagnostics.push(
          createProjectValidationDiagnostic({
            code: 'runtime-artifact.shader-source-revision-inconsistent',
            severity: 'error',
            path: '/materials',
            message: `Shader compiler returned inconsistent source revisions for '${relativePath}'.`,
            category: 'shader',
            boundaries: ['runtime-package'],
            ownerPaths: ['/materials'],
          }),
        );
      } else projectDependencies.set(relativePath, dependency.contentHash);
    }
  if (projectDependencies.size > 0) {
    if (!paths.readProjectTextSources) {
      diagnostics.push(
        createProjectValidationDiagnostic({
          code: 'runtime-artifact.shader-source-revision-unverifiable',
          severity: 'error',
          path: '/materials',
          message: 'Shader source revisions cannot be verified in this host.',
          category: 'shader',
          boundaries: ['runtime-package'],
          ownerPaths: ['/materials'],
        }),
      );
    } else {
      const entries = [...projectDependencies.entries()].map(
        ([projectRelativePath, contentHash], index) => ({
          assetId: `shader-source:${index}`,
          projectRelativePath,
          expectedContentHash: contentHash,
        }),
      );
      const observed = await paths.readProjectTextSources(projectRoot, entries);
      const byId = new Map(observed.map((entry) => [entry.assetId, entry]));
      for (const entry of entries) {
        const result = byId.get(entry.assetId);
        if (result?.status === 'ready' && result.contentHash === entry.expectedContentHash)
          continue;
        diagnostics.push(
          createProjectValidationDiagnostic({
            code: 'runtime-artifact.shader-source-revision-stale',
            severity: 'error',
            path: `/materials`,
            message: `Shader source '${entry.projectRelativePath}' changed while compilation was in progress.`,
            category: 'shader',
            boundaries: ['runtime-package'],
            ownerPaths: ['/materials'],
          }),
        );
      }
    }
  }
  for (const program of Object.keys(programs).sort())
    for (const stage of ['vertex', 'fragment'] as const)
      for (const variant of variants) {
        const key = `${program}:${stage}:${variant}`;
        if (seen.has(key)) continue;
        diagnostics.push(
          createProjectValidationDiagnostic({
            code: 'runtime-artifact.shader-output-missing',
            severity: 'error',
            path: `/materials/${program}/${stage}/${variant}`,
            message: `Shader compiler did not return required output '${key}'.`,
            category: 'shader',
            boundaries: ['runtime-package'],
            ownerPaths: ['/materials'],
          }),
        );
      }
  return { outputs: accepted, diagnostics };
}

function effectsAllowed(intent: RuntimeArtifactPreparationIntent) {
  return intent === 'play' || intent === 'runtime-package-export' || intent === 'platform-export';
}

export async function prepareRuntimeArtifact(
  options: PrepareRuntimeArtifactOptions,
): Promise<PrepareRuntimeArtifactResult> {
  const cancelled = () => options.isCancelled?.() === true;
  if (cancelled()) return { status: 'cancelled', diagnostics: [cancelledDiagnostic()] };
  options.onStage?.('compiling-project');
  let assessment = await assembleRuntimeArtifact(options.project, {
    projectRoot: options.projectRoot,
    profile: options.profile,
    recoveryFingerprint: options.recoveryFingerprint,
    paths: options.paths,
  });
  let shaderDiagnostics: ProjectValidationDiagnostic[] = [];
  let shaderOutputs: ShaderCompileOutput[] = [];
  const shouldCompile =
    effectsAllowed(options.intent) &&
    options.profile.compileShadersBeforeExport &&
    hasAuthoringShadersOrMaterials(options.project) &&
    assessment.compiledArtifactAvailable;
  if (shouldCompile) {
    if (!options.shaderCompiler) {
      shaderDiagnostics = [
        createProjectValidationDiagnostic({
          code: 'runtime-artifact.shader-compiler.unavailable',
          severity: 'error',
          path: '/shaders',
          message: 'Shader compilation is required but unavailable in this host.',
          category: 'shader',
          boundaries: ['runtime-package'],
          ownerPaths: ['/shaders'],
        }),
      ];
    } else {
      if (cancelled()) return { status: 'cancelled', diagnostics: [cancelledDiagnostic()] };
      options.onStage?.('compiling-shaders');
      const shaderProject = await buildShaderMaterialProject(options.project, [], {
        certifyPresetPrograms: true,
      });
      const response = await options.shaderCompiler.compile(shaderProject.compilation, {
        projectRoot: options.projectRoot ?? '',
        outputRoot: options.projectRoot ? `${options.projectRoot}/.noveltea/build` : '',
        cacheRoot: options.projectRoot ? `${options.projectRoot}/.noveltea/cache` : '',
        shaderVariants: options.profile.shaderVariants,
      });
      if (cancelled()) return { status: 'cancelled', diagnostics: [cancelledDiagnostic()] };
      const verified = await validateShaderOutputs(
        shaderProject.compilation.programs,
        options.profile.shaderVariants,
        response.outputs ?? [],
        options.projectRoot,
        options.paths,
      );
      shaderOutputs = verified.outputs;
      shaderDiagnostics = collectProjectValidationDiagnostics(
        shaderExecutionDiagnostics(response.diagnostics ?? []),
        verified.diagnostics,
        response.success
          ? []
          : [
              createProjectValidationDiagnostic({
                code: 'runtime-artifact.shader-compiler.failed',
                severity: 'error',
                path: '/shaders',
                message: response.error ?? 'Shader compilation failed.',
                category: 'shader',
                boundaries: ['runtime-package'],
                ownerPaths: ['/shaders'],
              }),
            ],
      );
      if (response.success && !shaderDiagnostics.some((item) => item.severity === 'error')) {
        options.onStage?.('compiling-project');
        assessment = await assembleRuntimeArtifact(options.project, {
          projectRoot: options.projectRoot,
          profile: options.profile,
          recoveryFingerprint: options.recoveryFingerprint,
          shaderOutputs: verified.outputs,
          paths: options.paths,
        });
      }
    }
  }
  const diagnostics = collectProjectValidationDiagnostics(
    assessment.diagnostics,
    shaderDiagnostics,
  );
  if (
    !assessment.ready ||
    assessment.compiledProject === undefined ||
    assessment.gameplayJson === undefined ||
    shaderDiagnostics.some((item) => item.severity === 'error')
  ) {
    return { status: 'blocked', diagnostics, assessment, shaderDiagnostics, shaderOutputs };
  }
  const artifact: PreparedRuntimeArtifact = {
    schema: PREPARED_RUNTIME_ARTIFACT_SCHEMA,
    sourceFingerprint: assessment.sourceFingerprint,
    ...(options.recoveryFingerprint === undefined
      ? {}
      : { recoveryFingerprint: options.recoveryFingerprint }),
    profile: options.profile,
    compiledProject: assessment.compiledProject,
    gameplayJson: assessment.gameplayJson,
    shaderMaterialMetadata: assessment.shaderMaterialMetadata,
    requiredShaderBinaryPaths: assessment.requiredShaderBinaryPaths,
    fileEntries: assessment.fileEntries,
    manifestPreview: assessment.manifestPreview,
    packageOptions: {
      ...assessment.packageOptions,
      ...(assessment.packageOptions.shaderVariants?.length
        ? { shaderAssetRoot: options.paths.shaderAssetRoot(options.projectRoot) }
        : {}),
    },
    localization: assessment.localization,
    diagnostics,
  };
  return { status: 'prepared', artifact, assessment, shaderDiagnostics, shaderOutputs };
}

function normalizedFilesystemPath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  return /^[A-Z]:\//.test(normalized)
    ? `${normalized[0]!.toLowerCase()}${normalized.slice(1)}`
    : normalized;
}

function normalizedExportFileEntries(entries: readonly ExportFileEntry[]) {
  return entries.map((entry) => ({
    ...entry,
    source: normalizedFilesystemPath(entry.source),
  }));
}

function normalizedPackageFileEntries(
  entries: readonly PreparedRuntimePackageOptions['fileEntries'][number][],
) {
  return entries.map((entry) => ({
    ...entry,
    source: normalizedFilesystemPath(entry.source),
  }));
}

async function expectedFileEntriesForVerification(
  compiledAssets: PreparedRuntimeArtifact['compiledProject']['resources']['assets'],
  options: VerifyPreparedRuntimeArtifactOptions,
  payloadAssetIds?: ReadonlySet<string>,
  requiredLocalizationAssetIds?: ReadonlySet<string>,
): Promise<
  | {
      entries: ExportFileEntry[];
      compiledAssets: PreparedRuntimeArtifact['compiledProject']['resources']['assets'];
    }
  | { message: string; path: string }
> {
  const entries: ExportFileEntry[] = [];
  const referencedAssetIds = options.profile.excludeUnusedAssets
    ? await referencedRuntimeAssetIds(options.project, options.projectRoot, options.paths)
    : null;
  if (options.profile.excludeUnusedAssets && referencedAssetIds === null)
    return {
      message:
        'Prepared asset pruning cannot be verified because current source references could not be rederived.',
      path: '/artifact/compiledProject/resources/assets',
    };
  const expectedCompiledAssets = compiledAssets.filter((asset) => {
    if (
      referencedAssetIds &&
      !referencedAssetIds.has(asset.id) &&
      !requiredLocalizationAssetIds?.has(asset.id)
    )
      return false;
    return true;
  });
  const packagePaths = new Set<string>();
  for (const asset of expectedCompiledAssets) {
    if (payloadAssetIds && !payloadAssetIds.has(asset.id)) continue;
    const authored = parseAssetData(options.project.assets[asset.id]?.data);
    if (!authored)
      return {
        message: `Compiled asset '${asset.id}' does not resolve to a current Project asset record.`,
        path: `/artifact/compiledProject/resources/assets/${asset.id}`,
      };
    if (asset.kind !== authored.kind || asset.path !== authored.source.path)
      return {
        message: `Compiled asset '${asset.id}' does not match its current Project asset record.`,
        path: `/artifact/compiledProject/resources/assets/${asset.id}`,
      };
    if (
      referencedAssetIds &&
      !referencedAssetIds.has(asset.id) &&
      !requiredLocalizationAssetIds?.has(asset.id)
    )
      continue;
    if (packagePaths.has(asset.path))
      return {
        message: `Prepared package inventory contains duplicate package path '${asset.path}'.`,
        path: '/artifact/fileEntries',
      };
    packagePaths.add(asset.path);
    entries.push({
      source: options.paths.resolveProjectSource(options.projectRoot, authored.source.path),
      packagePath: asset.path,
      storage: authored.kind === 'audio' ? 'stored' : 'auto',
      assetId: asset.id,
      kind: authored.kind,
    });
  }
  const addProjectSource = (
    packagePath: string,
    assetId: string,
    kind: 'script-source' | 'shader-source',
  ) => {
    if (packagePaths.has(packagePath)) return;
    packagePaths.add(packagePath);
    entries.push({
      source: options.paths.resolveProjectSource(options.projectRoot, packagePath),
      packagePath,
      storage: 'auto',
      assetId,
      kind,
    });
  };
  for (const [scriptId, record] of Object.entries(options.project.scripts)) {
    const source = parseScriptModuleData(record.data)?.source;
    if (source?.kind === 'project-file') addProjectSource(source.path, scriptId, 'script-source');
  }
  for (const record of Object.values(options.project.layouts)) {
    const layout = parseLayoutData(record.data);
    for (const scriptPath of layout?.dependencies.scripts ?? [])
      addProjectSource(scriptPath, `source:${scriptPath}`, 'script-source');
  }
  if (!options.profile.stripShaderSources) {
    const shaderBuild = await buildShaderMaterialProject(options.project);
    const addShaderIdentity = (identity: string) => {
      if (!identity.startsWith('project:/shaders/')) return;
      const path = identity.slice('project:/'.length);
      addProjectSource(path, `source:${path}`, 'shader-source');
    };
    for (const request of Object.values(shaderBuild.compilation.programs)) {
      addShaderIdentity(request.vertexSource);
      addShaderIdentity(request.fragmentSource);
      addShaderIdentity(request.varyingDefinition);
    }
  }
  return { entries, compiledAssets: expectedCompiledAssets };
}

function runtimePresentationForVerification(
  compiledProject: PreparedRuntimeArtifact['compiledProject'],
): Pick<PreparedRuntimePackageOptions, 'display' | 'accessibility' | 'platform'> | null {
  const display = compiledProject.settings.display;
  const displayGeometry = deriveProjectDisplayGeometry(display.referenceResolution);
  if (!displayGeometry) return null;
  const portrait = displayGeometry.orientation === 'portrait';
  return {
    display: {
      reference_resolution: { ...display.referenceResolution },
      world_raster_policy: display.worldRasterPolicy,
      bar_color: display.barColor,
    },
    accessibility: {
      ui_scale: { ...compiledProject.settings.accessibility.uiScale },
      text_scale: { ...compiledProject.settings.accessibility.textScale },
    },
    platform: {
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
    },
  };
}

function shaderMetadataWithoutCompiledOutputs(
  metadata: NonNullable<PreparedRuntimeArtifact['shaderMaterialMetadata']>,
) {
  const next = structuredClone(metadata);
  const sourceBackedShaders = new Set<string>();
  for (const [shaderId, shader] of Object.entries(next.shaders)) {
    let sourceBacked = false;
    for (const stage of Object.values(shader.stages)) {
      if (!stage) continue;
      if (stage.source !== undefined) sourceBacked = true;
      delete stage.compiled;
    }
    if (sourceBacked) {
      sourceBackedShaders.add(shaderId);
      shader.uniforms = {};
      shader.samplers = {};
    }
  }
  for (const material of Object.values(next.materials)) {
    if (!sourceBackedShaders.has(material.shader)) continue;
    material.uniforms = {};
    material.textures = {};
  }
  return next;
}

function hasShaderMaterialMetadata(
  metadata: NonNullable<PreparedRuntimeArtifact['shaderMaterialMetadata']>,
) {
  return Object.keys(metadata.shaders).length > 0 || Object.keys(metadata.materials).length > 0;
}

function rejectedEvidence(message: string, path: string): VerifyPreparedRuntimeArtifactResult {
  return {
    status: 'rejected',
    diagnostics: [
      createProjectValidationDiagnostic({
        code: 'runtime-artifact.evidence.rejected',
        severity: 'error',
        path,
        message,
        category: 'Runtime package readiness',
        boundaries: ['runtime-package'],
        ownerPaths: [path],
      }),
    ],
  };
}

export async function verifyPreparedRuntimeArtifact(
  value: unknown,
  options: VerifyPreparedRuntimeArtifactOptions,
): Promise<VerifyPreparedRuntimeArtifactResult> {
  const parsed = preparedRuntimeArtifactSchema.safeParse(value);
  if (!parsed.success)
    return rejectedEvidence('Prepared Runtime Artifact is malformed or unsupported.', '/artifact');
  const artifact = parsed.data as PreparedRuntimeArtifact;
  if (stableStringify(artifact.profile) !== stableStringify(options.profile))
    return rejectedEvidence(
      'Prepared Runtime Artifact profile does not match the requested profile.',
      '/artifact/profile',
    );
  const expected = preparedRuntimeArtifactSourceFingerprint(
    options.project,
    options.profile,
    options.recoveryFingerprint ?? null,
  );
  if (artifact.sourceFingerprint !== expected)
    return rejectedEvidence(
      'Prepared Runtime Artifact belongs to an older or different Project revision.',
      '/artifact/sourceFingerprint',
    );
  let gameplay: unknown;
  try {
    gameplay = JSON.parse(artifact.gameplayJson);
  } catch {
    return rejectedEvidence(
      'Prepared gameplay bytes are not valid JSON.',
      '/artifact/gameplayJson',
    );
  }
  if (stableStringify(gameplay) !== stableStringify(artifact.compiledProject))
    return rejectedEvidence(
      'Prepared gameplay bytes do not match the Compiled Project.',
      '/artifact/gameplayJson',
    );
  const expectedRuntimeProject = runtimeCompilationProject(options.project);
  const freshlyPublished = publishCompiledArtifact(expectedRuntimeProject);
  if (!freshlyPublished.ok)
    return rejectedEvidence(
      'Current Project cannot be freshly compiled while verifying the prepared runtime artifact.',
      '/artifact/compiledProject',
    );
  if (
    stableStringify(artifact.compiledProject.project) !==
    stableStringify({
      id: expectedRuntimeProject.project.id,
      name: expectedRuntimeProject.project.name,
      version: expectedRuntimeProject.project.version,
      author: expectedRuntimeProject.project.author,
      description: expectedRuntimeProject.project.description,
    })
  )
    return rejectedEvidence(
      'Prepared Compiled Project identity does not match the current Project.',
      '/artifact/compiledProject/project',
    );

  const localizationBaseAssetIds = await referencedRuntimeAssetIds(
    options.project,
    options.projectRoot,
    options.paths,
  );
  if (options.profile.excludeUnusedAssets && localizationBaseAssetIds === null)
    return rejectedEvidence(
      'Prepared localization closure cannot be verified because current source references could not be rederived.',
      '/artifact/localization',
    );
  const expectedLocalization = applyExportLocalizationClosure(
    options.project,
    freshlyPublished.project.project,
    options.profile.localization,
    localizationBaseAssetIds,
  );
  const expectedInventory = await expectedFileEntriesForVerification(
    expectedLocalization.project.resources.assets,
    options,
    expectedLocalization.payloadAssetIds,
    expectedLocalization.requiredLocalizationAssetIds,
  );
  if ('message' in expectedInventory)
    return rejectedEvidence(expectedInventory.message, expectedInventory.path);
  const expectedPartitioned = partitionRuntimeLocalizationCatalogs({
    ...expectedLocalization.project,
    resources: {
      ...expectedLocalization.project.resources,
      assets: expectedInventory.compiledAssets,
    },
  });
  if (
    stableStringify(artifact.compiledProject.localization) !==
      stableStringify(expectedPartitioned.project.localization) ||
    stableStringify(artifact.localization) !== stableStringify(expectedLocalization.closure)
  )
    return rejectedEvidence(
      'Prepared localization closure does not match the current Project and export profile.',
      '/artifact/localization',
    );
  if (
    stableStringify(artifact.compiledProject.resources.assets) !==
    stableStringify(expectedInventory.compiledAssets)
  )
    return rejectedEvidence(
      'Prepared Compiled Project asset resources do not match freshly derived pruning evidence.',
      '/artifact/compiledProject/resources/assets',
    );
  const actualFileEntries = normalizedExportFileEntries(artifact.fileEntries);
  const expectedFileEntries = normalizedExportFileEntries(expectedInventory.entries);
  const actualFileEntriesByPath = new Map(
    actualFileEntries.map((entry) => [entry.packagePath, entry]),
  );
  if (actualFileEntriesByPath.size !== actualFileEntries.length)
    return rejectedEvidence(
      'Prepared file inventory contains duplicate package paths.',
      '/artifact/fileEntries',
    );
  for (const expectedEntry of expectedFileEntries) {
    const actualEntry = actualFileEntriesByPath.get(expectedEntry.packagePath);
    if (!actualEntry || stableStringify(actualEntry) !== stableStringify(expectedEntry))
      return rejectedEvidence(
        'Prepared file inventory does not match the current Project and Compiled Project.',
        '/artifact/fileEntries',
      );
  }
  for (const actualEntry of actualFileEntries) {
    if (expectedFileEntries.some((entry) => entry.packagePath === actualEntry.packagePath))
      continue;
    if (
      options.profile.stripShaderSources ||
      actualEntry.kind !== 'shader-source' ||
      !actualEntry.packagePath.startsWith('shaders/') ||
      actualEntry.assetId !== `source:${actualEntry.packagePath}` ||
      actualEntry.source !==
        normalizedFilesystemPath(
          options.paths.resolveProjectSource(options.projectRoot, actualEntry.packagePath),
        )
    )
      return rejectedEvidence(
        'Prepared file inventory contains an unexpected Project source.',
        '/artifact/fileEntries',
      );
  }

  const currentShaderMetadata = (await buildShaderMaterialProject(options.project)).project;
  const currentHasShaderMetadata = hasShaderMaterialMetadata(currentShaderMetadata);
  if (currentHasShaderMetadata !== (artifact.shaderMaterialMetadata !== undefined))
    return rejectedEvidence(
      'Prepared shader/material metadata presence does not match the current Project.',
      '/artifact/shaderMaterialMetadata',
    );
  if (
    artifact.shaderMaterialMetadata &&
    stableStringify(shaderMetadataWithoutCompiledOutputs(artifact.shaderMaterialMetadata)) !==
      stableStringify(shaderMetadataWithoutCompiledOutputs(currentShaderMetadata))
  )
    return rejectedEvidence(
      'Prepared shader/material metadata does not match the current Project.',
      '/artifact/shaderMaterialMetadata',
    );

  const expectedShaderVariants = artifact.shaderMaterialMetadata
    ? options.profile.shaderVariants
    : [];
  if (artifact.shaderMaterialMetadata && options.profile.compileShadersBeforeExport) {
    for (const [shaderId, shader] of Object.entries(artifact.shaderMaterialMetadata.shaders)) {
      for (const [stageName, stage] of Object.entries(shader.stages)) {
        if (!stage) continue;
        for (const variant of expectedShaderVariants) {
          if (stage.compiled?.[variant]) continue;
          return rejectedEvidence(
            `Prepared shader output '${shaderId}:${stageName}:${variant}' is missing.`,
            `/artifact/shaderMaterialMetadata/shaders/${shaderId}/stages/${stageName}/compiled/${
              variant
            }`,
          );
        }
      }
    }
  }
  const expectedRequiredShaderBinaryPaths = artifact.shaderMaterialMetadata
    ? requiredShaderBinaryPaths(artifact.shaderMaterialMetadata, expectedShaderVariants)
    : [];
  if (
    stableStringify(artifact.requiredShaderBinaryPaths) !==
    stableStringify(expectedRequiredShaderBinaryPaths)
  )
    return rejectedEvidence(
      'Prepared required shader-binary inventory does not match validated shader metadata.',
      '/artifact/requiredShaderBinaryPaths',
    );

  const presentation = runtimePresentationForVerification(artifact.compiledProject);
  if (!presentation)
    return rejectedEvidence(
      'Prepared Compiled Project contains invalid runtime display metadata.',
      '/artifact/compiledProject/settings/display',
    );
  const expectedPackageFileEntries = artifact.fileEntries.map(
    ({ source, packagePath, storage }) => ({ source, packagePath, storage }),
  );
  const expectedSeekablePaths = artifact.fileEntries
    .filter((entry) => entry.kind === 'audio')
    .map((entry) => entry.packagePath);
  const expectedShaderAssetRoot = expectedShaderVariants.length
    ? options.paths.shaderAssetRoot(options.projectRoot)
    : undefined;
  const packageOptionsMatch =
    artifact.packageOptions.kind === options.profile.kind &&
    artifact.packageOptions.projectName === runtimeProjectName(options.project.project.name) &&
    artifact.packageOptions.projectVersion ===
      runtimeProjectVersion(options.project.project.version) &&
    artifact.packageOptions.createdBy === 'noveltea-editor' &&
    artifact.packageOptions.includeChecksums === options.profile.includeChecksums &&
    artifact.packageOptions.stripShaderSources === options.profile.stripShaderSources &&
    stableStringify(artifact.packageOptions.shaderVariants) ===
      stableStringify(expectedShaderVariants) &&
    stableStringify(artifact.packageOptions.shaderMaterialMetadata) ===
      stableStringify(artifact.shaderMaterialMetadata) &&
    stableStringify(artifact.packageOptions.requiredShaderBinaryPaths) ===
      stableStringify(expectedRequiredShaderBinaryPaths) &&
    stableStringify(normalizedPackageFileEntries(artifact.packageOptions.fileEntries)) ===
      stableStringify(normalizedPackageFileEntries(expectedPackageFileEntries)) &&
    stableStringify(artifact.packageOptions.textEntries) ===
      stableStringify(expectedPartitioned.textEntries) &&
    stableStringify(artifact.packageOptions.requiredSeekablePaths) ===
      stableStringify(expectedSeekablePaths) &&
    stableStringify(artifact.packageOptions.display) === stableStringify(presentation.display) &&
    stableStringify(artifact.packageOptions.accessibility) ===
      stableStringify(presentation.accessibility) &&
    stableStringify(artifact.packageOptions.platform) === stableStringify(presentation.platform) &&
    (expectedShaderAssetRoot === undefined
      ? artifact.packageOptions.shaderAssetRoot === undefined
      : artifact.packageOptions.shaderAssetRoot !== undefined &&
        normalizedFilesystemPath(artifact.packageOptions.shaderAssetRoot) ===
          normalizedFilesystemPath(expectedShaderAssetRoot));
  if (!packageOptionsMatch)
    return rejectedEvidence(
      'Prepared package options do not match the current Project, profile, and validated inventory.',
      '/artifact/packageOptions',
    );

  const expectedManifestPreview: ExportManifestPreview = {
    projectName: runtimeProjectName(options.project.project.name),
    projectVersion: runtimeProjectVersion(options.project.project.version),
    entryCount:
      1 +
      artifact.fileEntries.length +
      expectedPartitioned.textEntries.length +
      expectedRequiredShaderBinaryPaths.length +
      (artifact.shaderMaterialMetadata ? 1 : 0),
    assetCount: artifact.fileEntries.length,
    shaderVariants: expectedShaderVariants,
    requiredShaderBinaryPaths: expectedRequiredShaderBinaryPaths,
    display: presentation.display,
    accessibility: presentation.accessibility,
    platform: presentation.platform,
  };
  if (stableStringify(artifact.manifestPreview) !== stableStringify(expectedManifestPreview))
    return rejectedEvidence(
      'Prepared manifest preview does not match the validated package evidence.',
      '/artifact/manifestPreview',
    );

  return { status: 'verified', verified: { artifact } };
}
