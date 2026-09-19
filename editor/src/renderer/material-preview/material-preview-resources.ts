import type { ShaderCompileOutput } from '../../shared/editor-tooling';
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
}

export interface MaterialPreviewResourceDependencies {
  compileShaders: (project: unknown) => Promise<readonly ShaderCompileOutput[]>;
  resolveAssetUrl: (assetId: string) => Promise<string | null>;
  decodeImage: (url: string) => Promise<TexImageSource | null>;
}

interface MaterialPreviewProjectSnapshot {
  generation: number;
  project: AuthoringProject;
  built: ShaderMaterialProjectBuildResult;
  outputs: readonly ShaderCompileOutput[];
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

/** CPU-side Material preview authority. It deliberately owns no WebGL objects. */
export class MaterialPreviewProjectResources {
  private project: AuthoringProject | null = null;
  private projectAuthorityKey: string | null = null;
  private projectGeneration = 0;
  private projectSnapshot: Promise<MaterialPreviewProjectSnapshot | null> | null = null;
  private materialCache = new Map<string, Promise<MaterialPreviewResource | null>>();
  private decodedTextures = new Map<string, Promise<MaterialPreviewTextureResource>>();

  constructor(private readonly dependencies: MaterialPreviewResourceDependencies) {}

  updateProject(project: AuthoringProject | null, authorityKey: string | null = null) {
    if (this.project === project && this.projectAuthorityKey === authorityKey) return;
    this.project = project;
    this.projectAuthorityKey = authorityKey;
    this.projectGeneration += 1;
    this.projectSnapshot = null;
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

  private getProjectSnapshot(
    project: AuthoringProject,
    generation: number,
  ): Promise<MaterialPreviewProjectSnapshot | null> {
    if (this.projectSnapshot) return this.projectSnapshot;
    this.projectSnapshot = (async () => {
      const initial = await buildShaderMaterialProject(project);
      let outputs: readonly ShaderCompileOutput[] = [];
      if (Object.keys(initial.compilation.programs).length > 0) {
        outputs = await this.dependencies.compileShaders(initial.compilation);
      }
      const built =
        outputs.length > 0 ? await buildShaderMaterialProject(project, outputs) : initial;
      if (generation !== this.projectGeneration || project !== this.project) return null;
      return { generation, project, built, outputs };
    })();
    return this.projectSnapshot;
  }

  private async buildMaterial(
    project: AuthoringProject | null,
    materialId: string,
    generation: number,
  ): Promise<MaterialPreviewResource | null> {
    if (!project) return null;
    const resolution = resolveMaterialData(project, materialId);
    if (!resolution.data) return null;
    const snapshot = await this.getProjectSnapshot(project, generation);
    if (!snapshot) return null;

    const runtimeMaterial = snapshot.built.project.materials[materialId];
    const customOutputs = runtimeMaterial
      ? snapshot.outputs.filter(
          (output) =>
            output.variant === 'essl-300' &&
            output.program === runtimeMaterial.shader &&
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
