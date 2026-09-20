import type { ShaderCompileDiagnostic, ShaderCompileOutput } from '../../shared/editor-tooling';
import { parseAssetData } from '../../shared/project-schema/authoring-assets';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  resolveMaterialData,
  type MaterialSchemaDiagnostic,
  type MaterialTextureSource,
  type ResolvedMaterialData,
} from '../../shared/project-schema/authoring-materials';
import {
  buildShaderMaterialProject,
  materialDerivedInterface,
  materialPreviewRevision,
  type MaterialDerivedInterface,
  type ShaderMaterialProjectBuildResult,
  type ShaderMaterialProjectDiagnostic,
  type ShaderSourcePrograms,
} from '../../shared/project-schema/shader-material-project';

export interface MaterialPreviewTextureResource {
  key: string;
  image: TexImageSource | null;
}

export interface MaterialPreviewResource {
  materialId: string;
  revision: string;
  resolved: ResolvedMaterialData;
  derivedInterface: MaterialDerivedInterface | null;
  vertexShaderSource: string | null;
  fragmentShaderSource: string | null;
  textures: Readonly<Record<string, MaterialPreviewTextureResource>>;
  diagnostics: ReadonlyArray<MaterialSchemaDiagnostic | ShaderMaterialProjectDiagnostic>;
  compileDiagnostics: readonly ShaderCompileDiagnostic[];
  stale: boolean;
}

export interface MaterialPreviewCompileResult {
  success: boolean;
  outputs: readonly ShaderCompileOutput[];
  diagnostics: readonly ShaderCompileDiagnostic[];
}

export interface MaterialPreviewCompileOptions {
  sourceOverlays?: Readonly<Record<string, string>>;
}

export interface MaterialPreviewResourceDependencies {
  compileShaders: (
    project: unknown,
    options?: MaterialPreviewCompileOptions,
  ) => Promise<MaterialPreviewCompileResult | readonly ShaderCompileOutput[]>;
  resolveAssetUrl: (assetId: string) => Promise<string | null>;
  decodeImage: (url: string) => Promise<TexImageSource | null>;
}

export interface MaterialPreviewProjectOptions {
  materialIds?: readonly string[];
  sourceOverlays?: Readonly<Record<string, string>>;
  scopeKey?: string | null;
}

interface MaterialPreviewProjectSnapshot {
  generation: number;
  project: AuthoringProject;
  built: ShaderMaterialProjectBuildResult;
  outputs: readonly ShaderCompileOutput[];
  compileDiagnostics: readonly ShaderCompileDiagnostic[];
  stalePrograms: ReadonlySet<string>;
}

function defaultDecodeImage(url: string): Promise<TexImageSource | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

function textureAssetId(project: AuthoringProject, source: MaterialTextureSource | undefined) {
  if (!source) return null;
  if ('$ref' in source) return source.$ref.id;
  if ('alias' in source) {
    for (const [assetId, record] of Object.entries(project.assets)) {
      const asset = parseAssetData(record.data);
      if (asset?.aliases.includes(source.alias)) return assetId;
    }
    return null;
  }
  if (!source.uri.startsWith('project:/')) return null;
  const path = source.uri.slice('project:/'.length);
  for (const [assetId, record] of Object.entries(project.assets)) {
    if (parseAssetData(record.data)?.source.path === path) return assetId;
  }
  return null;
}

function normalizeCompileResult(
  result: MaterialPreviewCompileResult | readonly ShaderCompileOutput[],
): MaterialPreviewCompileResult {
  return Array.isArray(result)
    ? { success: true, outputs: result, diagnostics: [] }
    : (result as MaterialPreviewCompileResult);
}

function previewOptionsKey(options: MaterialPreviewProjectOptions): string {
  return JSON.stringify({
    materialIds: [...(options.materialIds ?? [])].sort(),
    sourceOverlays: Object.fromEntries(
      Object.entries(options.sourceOverlays ?? {}).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    scopeKey: options.scopeKey ?? null,
  });
}

function sourceProgramIdForMaterial(
  initial: ShaderMaterialProjectBuildResult,
  materialId: string,
): string | null {
  const shaderId = initial.project.materials[materialId]?.shader;
  if (!shaderId) return null;
  if (initial.compilation.programs[shaderId]) return shaderId;
  const marker = '-material-';
  const markerIndex = shaderId.indexOf(marker);
  if (markerIndex < 0) return null;
  const programId = shaderId.slice(0, markerIndex);
  return initial.compilation.programs[programId] ? programId : null;
}

function scopedCompilation(
  initial: ShaderMaterialProjectBuildResult,
  materialIds: readonly string[] | undefined,
): ShaderSourcePrograms {
  if (!materialIds) return initial.compilation;
  const programIds = new Set(
    materialIds.flatMap((materialId) => {
      const programId = sourceProgramIdForMaterial(initial, materialId);
      return programId ? [programId] : [];
    }),
  );
  return {
    ...initial.compilation,
    programs: Object.fromEntries(
      Object.entries(initial.compilation.programs).filter(([programId]) =>
        programIds.has(programId),
      ),
    ),
  };
}

/** CPU-side Material preview authority. It deliberately owns no WebGL objects. */
export class MaterialPreviewProjectResources {
  private project: AuthoringProject | null = null;
  private projectAuthorityKey: string | null = null;
  private projectOptions: MaterialPreviewProjectOptions = {};
  private projectOptionsKey = previewOptionsKey({});
  private projectGeneration = 0;
  private projectBuild: Promise<ShaderMaterialProjectBuildResult> | null = null;
  private projectSnapshots = new Map<string, Promise<MaterialPreviewProjectSnapshot | null>>();
  private materialCache = new Map<string, Promise<MaterialPreviewResource | null>>();
  private decodedTextures = new Map<string, Promise<MaterialPreviewTextureResource>>();
  private lastGoodOutputsByProgram = new Map<string, readonly ShaderCompileOutput[]>();
  private lastGoodScopeKey: string | null = null;

  constructor(private readonly dependencies: MaterialPreviewResourceDependencies) {}

  updateProject(
    project: AuthoringProject | null,
    authorityKey: string | null = null,
    options: MaterialPreviewProjectOptions = {},
  ) {
    const optionsKey = previewOptionsKey(options);
    if (
      this.project === project &&
      this.projectAuthorityKey === authorityKey &&
      this.projectOptionsKey === optionsKey
    )
      return;
    const nextScopeKey = options.scopeKey ?? null;
    if (nextScopeKey !== this.lastGoodScopeKey && this.lastGoodScopeKey !== null) {
      this.lastGoodOutputsByProgram.clear();
    }
    this.lastGoodScopeKey = nextScopeKey;
    this.project = project;
    this.projectAuthorityKey = authorityKey;
    this.projectOptions = options;
    this.projectOptionsKey = optionsKey;
    this.projectGeneration += 1;
    this.projectBuild = null;
    this.projectSnapshots.clear();
    this.materialCache.clear();
    this.decodedTextures.clear();
  }

  get generation() {
    return this.projectGeneration;
  }

  getMaterial(materialId: string): Promise<MaterialPreviewResource | null> {
    const cached = this.materialCache.get(materialId);
    if (cached) return cached;
    const generation = this.projectGeneration;
    const project = this.project;
    const promise = this.buildMaterial(project, materialId, generation);
    this.materialCache.set(materialId, promise);
    return promise;
  }

  private async getProjectSnapshot(
    project: AuthoringProject,
    generation: number,
    requestedMaterialIds: readonly string[],
  ): Promise<MaterialPreviewProjectSnapshot | null> {
    const materialIds = this.projectOptions.materialIds ?? requestedMaterialIds;
    this.projectBuild ??= buildShaderMaterialProject(project);
    const initial = await this.projectBuild;
    const compilation = scopedCompilation(initial, materialIds);
    const snapshotKey = Object.keys(compilation.programs).sort().join('\u0000');
    const cached = this.projectSnapshots.get(snapshotKey);
    if (cached) return cached;
    const snapshot = (async () => {
      const requestedPrograms = Object.keys(compilation.programs);
      let outputs: readonly ShaderCompileOutput[] = [];
      let compileDiagnostics: readonly ShaderCompileDiagnostic[] = [];
      const stalePrograms = new Set<string>();
      if (requestedPrograms.length > 0) {
        const compiled = normalizeCompileResult(
          await this.dependencies.compileShaders(compilation, {
            sourceOverlays: this.projectOptions.sourceOverlays,
          }),
        );
        compileDiagnostics = compiled.diagnostics;
        if (compiled.success) {
          outputs = compiled.outputs;
          for (const programId of requestedPrograms) {
            const programOutputs = compiled.outputs.filter(
              (output) => output.program === programId,
            );
            if (programOutputs.length > 0)
              this.lastGoodOutputsByProgram.set(programId, programOutputs);
          }
        } else {
          const recovered: ShaderCompileOutput[] = [];
          for (const programId of requestedPrograms) {
            const lastGood = this.lastGoodOutputsByProgram.get(programId);
            if (lastGood?.length) {
              recovered.push(...lastGood);
              stalePrograms.add(programId);
            } else {
              recovered.push(...compiled.outputs.filter((output) => output.program === programId));
            }
          }
          outputs = recovered;
        }
      }
      const built =
        outputs.length > 0 ? await buildShaderMaterialProject(project, outputs) : initial;
      if (generation !== this.projectGeneration || project !== this.project) return null;
      return { generation, project, built, outputs, compileDiagnostics, stalePrograms };
    })();
    this.projectSnapshots.set(snapshotKey, snapshot);
    return snapshot;
  }

  private async buildMaterial(
    project: AuthoringProject | null,
    materialId: string,
    generation: number,
  ): Promise<MaterialPreviewResource | null> {
    if (!project) return null;
    const resolution = resolveMaterialData(project, materialId);
    if (!resolution.data) return null;
    const snapshot = await this.getProjectSnapshot(project, generation, [materialId]);
    if (!snapshot) return null;

    const sourceProgramId = sourceProgramIdForMaterial(snapshot.built, materialId);
    const customOutputs = sourceProgramId
      ? snapshot.outputs.filter(
          (output) =>
            output.variant === 'essl-300' &&
            output.program === sourceProgramId &&
            typeof output.browserPayload === 'string',
        )
      : [];
    const vertexShaderSource =
      customOutputs.find((output) => output.stage === 'vertex')?.browserPayload ?? null;
    const fragmentShaderSource =
      customOutputs.find((output) => output.stage === 'fragment')?.browserPayload ?? null;
    const textures = Object.fromEntries(
      await Promise.all(
        Object.entries(resolution.data.textures).map(async ([name, texture]) => {
          const assetId = textureAssetId(project, texture.source);
          if (!assetId) {
            return [name, { key: `${materialId}:${name}:representative`, image: null }];
          }
          return [name, await this.getDecodedAsset(assetId)];
        }),
      ),
    );
    if (generation !== this.projectGeneration || project !== this.project) return null;

    return {
      materialId,
      revision: materialPreviewRevision(project, materialId),
      resolved: resolution.data,
      derivedInterface: materialDerivedInterface(snapshot.built.project, materialId),
      vertexShaderSource,
      fragmentShaderSource,
      textures,
      diagnostics: [...resolution.diagnostics, ...snapshot.built.diagnostics],
      compileDiagnostics: snapshot.compileDiagnostics,
      stale: sourceProgramId ? snapshot.stalePrograms.has(sourceProgramId) : false,
    };
  }

  private getDecodedAsset(assetId: string) {
    const cached = this.decodedTextures.get(assetId);
    if (cached) return cached;
    const promise = (async (): Promise<MaterialPreviewTextureResource> => {
      const url = await this.dependencies.resolveAssetUrl(assetId);
      if (!url) return { key: `asset:${assetId}:missing`, image: null };
      return { key: `asset:${assetId}:${url}`, image: await this.dependencies.decodeImage(url) };
    })();
    this.decodedTextures.set(assetId, promise);
    return promise;
  }
}

export const materialPreviewDefaultDecodeImage = defaultDecodeImage;
