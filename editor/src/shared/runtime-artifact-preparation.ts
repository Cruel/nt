import { publishCompiledArtifact } from './compiled-artifact-publication';
import type {
  PackageExportOptions,
  ShaderCompileDiagnostic,
  ShaderCompileOptions,
  ShaderCompileOutput,
  ShaderCompileResponse,
} from './editor-tooling';
import { parseAssetData } from './project-schema/authoring-assets';
import type { ExportProfileData, ExportShaderVariant } from './project-schema/authoring-export';
import type { AuthoringProject } from './project-schema/authoring-project';
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
import { buildShaderMaterialProject } from './project-schema/shader-material-project';
import {
  canonicalRuntimeShaderOutputPath,
  captureShaderCompileInputFingerprints,
  parseShaderData,
  shaderCompileInputFingerprint,
  type VerifiedShaderCompiledOutput,
} from './project-schema/authoring-shaders';
import {
  PREPARED_RUNTIME_ARTIFACT_SCHEMA,
  PREPARED_RUNTIME_ARTIFACT_SCHEMA_VERSION,
  preparedRuntimeArtifactSchema,
  type ExportFileEntry,
  type ExportManifestPreview,
  type PreparedRuntimeArtifact,
  type PreparedRuntimePackageOptions,
} from './project-schema/prepared-runtime-artifact';

export {
  PREPARED_RUNTIME_ARTIFACT_SCHEMA,
  PREPARED_RUNTIME_ARTIFACT_SCHEMA_VERSION,
  preparedRuntimeArtifactSchema,
};
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
  shaderAuthoringOutputs?: readonly VerifiedShaderCompiledOutput[];
  resolveProjectSource: (projectRoot: string | null, source: string) => string;
}

export interface RuntimeArtifactAssessment {
  ready: boolean;
  compiledArtifactAvailable: boolean;
  compiledProject?: PreparedRuntimeArtifact['compiledProject'];
  gameplayJson?: string;
  shaderMaterialMetadata?: PreparedRuntimeArtifact['shaderMaterialMetadata'];
  requiredShaderBinaryPaths: string[];
  fileEntries: ExportFileEntry[];
  manifestPreview: ExportManifestPreview;
  packageOptions: PreparedRuntimePackageOptions;
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
  runtimeProject.editor = emptyEditorProjectState();
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
  outputs: readonly VerifiedShaderCompiledOutput[],
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
    stageRecord.compiled = {
      ...compiled,
      [output.variant]: {
        runtimePath: output.metadata.path,
        byteHash: output.metadata.byteHash,
        byteSize: output.metadata.byteSize,
      },
    };
  }
  return { metadata: next, diagnostics };
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
  return Object.keys(project.shaders).length > 0 || Object.keys(project.materials).length > 0;
}

function assembleRuntimeArtifact(
  project: AuthoringProject,
  options: RuntimeArtifactAssemblyOptions,
): RuntimeArtifactAssessment {
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
        source: options.resolveProjectSource(options.projectRoot ?? null, authored.source.path),
        packagePath: asset.path,
        storage: authored.kind === 'audio' ? 'stored' : 'auto',
        assetId: asset.id,
        kind: authored.kind,
      },
    ];
  });

  const shaderBuild = buildShaderMaterialProject(project);
  const shaderAuthoringOutputs = options.shaderAuthoringOutputs ?? [];
  const preparedShaderMetadata = shaderMaterialMetadataWithOutputs(
    shaderBuild.project,
    shaderAuthoringOutputs,
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

function validateShaderOutputs(
  project: AuthoringProject,
  outputs: readonly ShaderCompileOutput[],
  capturedFingerprints: Readonly<Record<string, `sha256:${string}`>>,
): {
  outputs: ShaderCompileOutput[];
  authoringOutputs: VerifiedShaderCompiledOutput[];
  diagnostics: ProjectValidationDiagnostic[];
} {
  const accepted: ShaderCompileOutput[] = [];
  const authoringOutputs: VerifiedShaderCompiledOutput[] = [];
  const diagnostics: ProjectValidationDiagnostic[] = [];
  const seenKeys = new Set<string>();
  const acceptedKeys = new Set<string>();
  for (const output of outputs) {
    const key = `${output.shader}:${output.stage}:${output.variant}`;
    if (seenKeys.has(key)) {
      const duplicateShader = parseShaderData(project.shaders[output.shader]?.data);
      const duplicateStageIndex =
        duplicateShader?.stages.findIndex((stage) => stage.stage === output.stage) ?? -1;
      diagnostics.push(
        createProjectValidationDiagnostic({
          code: 'runtime-artifact.shader-output-duplicate',
          severity: 'error',
          path:
            duplicateStageIndex >= 0
              ? `/shaders/${output.shader}/data/stages/${duplicateStageIndex}/compiled/${
                  output.variant
                }`
              : `/shaders/${output.shader}`,
          message: `Shader compiler returned duplicate output '${key}'.`,
          category: 'shader',
          boundaries: ['runtime-package'],
          ownerPaths: [`/shaders/${output.shader}`],
        }),
      );
      continue;
    }
    seenKeys.add(key);
    const captured = capturedFingerprints[key];
    const shader = parseShaderData(project.shaders[output.shader]?.data);
    const stageIndex = shader?.stages.findIndex((stage) => stage.stage === output.stage) ?? -1;
    const current =
      stageIndex >= 0
        ? shaderCompileInputFingerprint(project, output.shader, stageIndex, output.variant)
        : null;
    const runtimePath = canonicalRuntimeShaderOutputPath(output.runtimePath);
    if (
      !captured ||
      current !== captured ||
      !runtimePath ||
      !/^sha256:[0-9a-f]{64}$/.test(output.byteHash) ||
      !Number.isSafeInteger(output.byteSize) ||
      output.byteSize < 0
    ) {
      diagnostics.push(
        createProjectValidationDiagnostic({
          code: captured
            ? 'runtime-artifact.shader-output-stale-or-invalid'
            : 'runtime-artifact.shader-request-fingerprint-missing',
          severity: 'error',
          path: `/shaders/${output.shader}`,
          message: `Compiled shader output '${key}' is stale or has invalid integrity metadata.`,
          category: 'shader',
          boundaries: ['runtime-package'],
          ownerPaths: [`/shaders/${output.shader}`],
        }),
      );
      continue;
    }
    accepted.push(output);
    acceptedKeys.add(key);
    authoringOutputs.push({
      shader: output.shader,
      stage: output.stage,
      variant: output.variant,
      metadata: {
        path: runtimePath,
        byteHash: output.byteHash,
        byteSize: output.byteSize,
        compileInputFingerprint: captured,
      },
    });
  }
  for (const key of Object.keys(capturedFingerprints).sort()) {
    if (acceptedKeys.has(key)) continue;
    const [shader = '', stage = '', variant = ''] = key.split(':');
    const shaderData = parseShaderData(project.shaders[shader]?.data);
    const stageIndex = shaderData?.stages.findIndex((item) => item.stage === stage) ?? -1;
    diagnostics.push(
      createProjectValidationDiagnostic({
        code: 'runtime-artifact.shader-output-missing',
        severity: 'error',
        path:
          shader && stageIndex >= 0
            ? `/shaders/${shader}/data/stages/${stageIndex}/compiled/${variant}`
            : shader
              ? `/shaders/${shader}`
              : '/shaders',
        message: `Shader compiler did not return required output '${key}'.`,
        category: 'shader',
        boundaries: ['runtime-package'],
        ownerPaths: [shader ? `/shaders/${shader}` : '/shaders'],
      }),
    );
  }
  return { outputs: accepted, authoringOutputs, diagnostics };
}

function effectsAllowed(intent: RuntimeArtifactPreparationIntent) {
  return intent === 'runtime-package-export' || intent === 'platform-export';
}

export async function prepareRuntimeArtifact(
  options: PrepareRuntimeArtifactOptions,
): Promise<PrepareRuntimeArtifactResult> {
  const cancelled = () => options.isCancelled?.() === true;
  if (cancelled()) return { status: 'cancelled', diagnostics: [cancelledDiagnostic()] };
  options.onStage?.('compiling-project');
  let assessment = assembleRuntimeArtifact(options.project, {
    projectRoot: options.projectRoot,
    profile: options.profile,
    recoveryFingerprint: options.recoveryFingerprint,
    resolveProjectSource: (root, source) => options.paths.resolveProjectSource(root, source),
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
      const shaderProject = buildShaderMaterialProject(options.project);
      const captured = captureShaderCompileInputFingerprints(
        options.project,
        options.profile.shaderVariants,
      );
      const response = await options.shaderCompiler.compile(shaderProject.project, {
        projectRoot: options.projectRoot ?? '',
        outputRoot: options.projectRoot ? `${options.projectRoot}/.noveltea/build` : '',
        cacheRoot: options.projectRoot ? `${options.projectRoot}/.noveltea/cache` : '',
        shaderVariants: options.profile.shaderVariants,
      });
      if (cancelled()) return { status: 'cancelled', diagnostics: [cancelledDiagnostic()] };
      const verified = validateShaderOutputs(options.project, response.outputs ?? [], captured);
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
        assessment = assembleRuntimeArtifact(options.project, {
          projectRoot: options.projectRoot,
          profile: options.profile,
          recoveryFingerprint: options.recoveryFingerprint,
          shaderAuthoringOutputs: verified.authoringOutputs,
          resolveProjectSource: (root, source) => options.paths.resolveProjectSource(root, source),
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
    schemaVersion: PREPARED_RUNTIME_ARTIFACT_SCHEMA_VERSION,
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

function expectedFileEntriesForVerification(
  artifact: PreparedRuntimeArtifact,
  options: VerifyPreparedRuntimeArtifactOptions,
): { entries: ExportFileEntry[] } | { message: string; path: string } {
  const entries: ExportFileEntry[] = [];
  const packagePaths = new Set<string>();
  for (const asset of artifact.compiledProject.resources.assets) {
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
    if (options.profile.kind === 'runtime' && authored.kind === 'shader-source') continue;
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
  return { entries };
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
  for (const shader of Object.values(next.shaders)) {
    for (const stage of Object.values(shader.stages)) {
      if (stage) delete stage.compiled;
    }
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

export function verifyPreparedRuntimeArtifact(
  value: unknown,
  options: VerifyPreparedRuntimeArtifactOptions,
): VerifyPreparedRuntimeArtifactResult {
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

  const expectedInventory = expectedFileEntriesForVerification(artifact, options);
  if ('message' in expectedInventory)
    return rejectedEvidence(expectedInventory.message, expectedInventory.path);
  if (
    stableStringify(normalizedExportFileEntries(artifact.fileEntries)) !==
    stableStringify(normalizedExportFileEntries(expectedInventory.entries))
  )
    return rejectedEvidence(
      'Prepared asset inventory does not match the current Project and Compiled Project.',
      '/artifact/fileEntries',
    );

  const currentShaderMetadata = buildShaderMaterialProject(options.project).project;
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
  const expectedPackageFileEntries = expectedInventory.entries.map(
    ({ source, packagePath, storage }) => ({ source, packagePath, storage }),
  );
  const expectedSeekablePaths = expectedInventory.entries
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
      expectedInventory.entries.length +
      expectedRequiredShaderBinaryPaths.length +
      (artifact.shaderMaterialMetadata ? 1 : 0),
    assetCount: expectedInventory.entries.length,
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
