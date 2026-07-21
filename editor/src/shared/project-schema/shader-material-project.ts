import { parseAssetData } from './authoring-assets';
import type { AuthoringProject } from './authoring-project';
import {
  parseMaterialData,
  resolveMaterialData,
  type MaterialData,
  type MaterialTextureSource,
} from './authoring-materials';
import {
  parseShaderData,
  type ShaderData,
  type ShaderStageData,
  type ShaderUniformData,
} from './authoring-shaders';

export const SHADER_MATERIAL_SCHEMA = 'noveltea.shader-materials.v1' as const;
export const SHADER_PREVIEW_SCHEMA = 'noveltea.shader-preview.v1' as const;

export interface ShaderMaterialProjectDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
}

export interface ShaderMaterialProjectBuildResult {
  project: {
    schema: typeof SHADER_MATERIAL_SCHEMA;
    shaders: Record<string, unknown>;
    materials: Record<string, unknown>;
  };
  diagnostics: ShaderMaterialProjectDiagnostic[];
}

function diagnostic(
  path: string,
  message: string,
  severity: 'error' | 'warning' | 'info' = 'error',
): ShaderMaterialProjectDiagnostic {
  return { severity, path, message, category: 'shader-material-project' };
}

export function buildShaderMaterialProject(
  project: AuthoringProject,
): ShaderMaterialProjectBuildResult {
  const diagnostics: ShaderMaterialProjectDiagnostic[] = [];
  const shaders: Record<string, unknown> = {};
  const materials: Record<string, unknown> = {};

  for (const shaderId of Object.keys(project.shaders)) {
    const shader = buildShaderDefinition(project, shaderId);
    diagnostics.push(...shader.diagnostics);
    if (shader.value) shaders[shaderId] = shader.value;
  }

  for (const [materialId] of Object.entries(project.materials)) {
    const material = buildMaterialDefinition(project, materialId);
    diagnostics.push(...material.diagnostics);
    if (material.value) materials[materialId] = material.value;
  }

  return { project: { schema: SHADER_MATERIAL_SCHEMA, shaders, materials }, diagnostics };
}

export function buildShaderDefinition(
  project: AuthoringProject,
  shaderId: string,
): { value: Record<string, unknown> | null; diagnostics: ShaderMaterialProjectDiagnostic[] } {
  const diagnostics: ShaderMaterialProjectDiagnostic[] = [];
  const record = project.shaders[shaderId];
  const data = parseShaderData(record?.data);
  if (!record || !data)
    return {
      value: null,
      diagnostics: [diagnostic(`/shaders/${shaderId}/data`, 'Invalid shader data.')],
    };

  const stages: Record<string, unknown> = {};
  data.stages.forEach((stage, index) => {
    const converted = shaderStageToRuntime(project, shaderId, stage, index);
    diagnostics.push(...converted.diagnostics);
    if (converted.value) stages[stage.stage] = converted.value;
  });

  const uniforms: Record<string, unknown> = {};
  for (const uniform of data.uniforms) uniforms[uniform.name] = uniformToRuntime(uniform);

  const samplers: Record<string, unknown> = {};
  for (const sampler of data.samplers) samplers[sampler.name] = { type: sampler.type };

  const roles =
    data.roleBindings.length > 0
      ? Object.fromEntries(
          data.roleBindings.map((binding) => [
            binding.role,
            {
              ...(binding.vertexShader ? { vertex: binding.vertexShader.$ref.id } : {}),
              ...(binding.fragmentShader ? { fragment: binding.fragmentShader.$ref.id } : {}),
            },
          ]),
        )
      : data.roles;

  return {
    value: {
      display_name: data.displayName ?? record.label,
      stages,
      uniforms,
      samplers,
      roles,
    },
    diagnostics,
  };
}

function shaderStageToRuntime(
  project: AuthoringProject,
  shaderId: string,
  stage: ShaderStageData,
  index: number,
): { value: Record<string, unknown> | null; diagnostics: ShaderMaterialProjectDiagnostic[] } {
  const diagnostics: ShaderMaterialProjectDiagnostic[] = [];
  const base = `/shaders/${shaderId}/data/stages/${index}`;
  const value: Record<string, unknown> = {};
  if (stage.sourceMode === 'asset') {
    const assetId = stage.sourceAsset?.$ref.id;
    if (!assetId) {
      diagnostics.push(diagnostic(`${base}/sourceAsset`, 'Shader stage source asset is missing.'));
    } else {
      const source = assetSourcePath(project, assetId);
      if (!source)
        diagnostics.push(
          diagnostic(
            `${base}/sourceAsset/$ref`,
            `Cannot resolve shader source asset '${assetId}'.`,
          ),
        );
      else value.source = source;
    }
  } else if (stage.sourceText !== undefined) {
    value.source_text = stage.sourceText;
  }
  if (Object.keys(stage.compiled ?? {}).length > 0) value.compiled = stage.compiled;
  return { value, diagnostics };
}

function assetSourcePath(project: AuthoringProject, assetId: string): string | null {
  const record = project.assets[assetId];
  const data = parseAssetData(record?.data);
  if (!data) return null;
  return `project:/${data.source.path}`;
}

function uniformToRuntime(uniform: ShaderUniformData): Record<string, unknown> {
  return {
    type: uniform.type,
    ...(uniform.default !== undefined ? { default: uniform.default } : {}),
    ...(uniform.range ? { range: uniform.range } : {}),
    ...(uniform.binding ? { binding: uniform.binding } : {}),
    ...(uniform.label ? { editor: { label: uniform.label } } : {}),
  };
}

export function buildMaterialDefinition(
  project: AuthoringProject,
  materialId: string,
): { value: Record<string, unknown> | null; diagnostics: ShaderMaterialProjectDiagnostic[] } {
  const diagnostics: ShaderMaterialProjectDiagnostic[] = [];
  const record = project.materials[materialId];
  if (!record)
    return {
      value: null,
      diagnostics: [diagnostic(`/materials/${materialId}`, 'Missing material.')],
    };
  const resolved = resolveMaterialData(project, materialId);
  diagnostics.push(...resolved.diagnostics);
  const data = resolved.data ?? parseMaterialData(record.data);
  if (!data)
    return {
      value: null,
      diagnostics: [
        ...diagnostics,
        diagnostic(`/materials/${materialId}/data`, 'Invalid material data.'),
      ],
    };
  if (!data.shader)
    return {
      value: null,
      diagnostics: [
        ...diagnostics,
        diagnostic(`/materials/${materialId}/data/shader`, 'Material shader is missing.'),
      ],
    };

  const uniforms: Record<string, unknown> = {};
  for (const uniform of data.uniforms) uniforms[uniform.name] = uniform.value;
  const textures: Record<string, unknown> = {};
  data.textures.forEach((texture, index) => {
    const source = materialTextureSourceToRuntime(project, texture.source);
    if (!source) {
      diagnostics.push(
        diagnostic(
          `/materials/${materialId}/data/textures/${index}/source`,
          'Cannot resolve material texture source.',
        ),
      );
      return;
    }
    textures[texture.sampler] = { source, sampler: texture.filtering };
  });

  return {
    value: {
      display_name: data.displayName ?? record.label,
      role: data.role,
      ...(data.role === 'postprocess' ? { postprocess_scope: data.postprocessScope } : {}),
      shader: data.shader.$ref.id,
      uniforms,
      textures,
      blend: data.blend,
    },
    diagnostics,
  };
}

function materialTextureSourceToRuntime(
  project: AuthoringProject,
  source: MaterialTextureSource,
): string | null {
  if ('$ref' in source) return assetSourcePath(project, source.$ref.id);
  if ('alias' in source) return source.alias;
  return source.uri;
}

export function materialPreviewRevision(project: AuthoringProject, materialId: string): string {
  const material = project.materials[materialId];
  if (!material) return `${materialId}:missing`;
  const materialData = parseMaterialData(material.data);
  const shaderId = materialData?.shader?.$ref.id ?? 'no-shader';
  const shader = shaderId ? project.shaders[shaderId] : null;
  const dependencies =
    materialData?.textures.map((texture) => {
      if ('$ref' in texture.source) {
        const asset = project.assets[texture.source.$ref.id];
        const data = parseAssetData(asset?.data);
        return `${texture.sampler}:${texture.source.$ref.id}:${data?.contentHash ?? data?.source.path ?? 'missing'}`;
      }
      if ('alias' in texture.source) return `${texture.sampler}:alias:${texture.source.alias}`;
      return `${texture.sampler}:uri:${texture.source.uri}`;
    }) ?? [];
  return JSON.stringify({
    materialId,
    material: material.data,
    shaderId,
    shader: shader?.data,
    dependencies,
  });
}

export function buildMaterialPreviewDocumentData(
  project: AuthoringProject,
  materialId: string,
): Record<string, unknown> {
  const runtime = buildShaderMaterialProject(project);
  const material = parseMaterialData(project.materials[materialId]?.data);
  return {
    shaderMaterials: runtime.project,
    diagnostics: runtime.diagnostics,
    materialId,
    preview: material?.preview ?? { geometry: 'quad', background: 'checker' },
  };
}

export function shaderPreviewRevision(project: AuthoringProject, shaderId: string): string {
  const shader = project.shaders[shaderId];
  if (!shader) return `${shaderId}:missing`;
  return JSON.stringify({ shaderId, shader: shader.data });
}

export function buildShaderPreviewDocumentData(
  project: AuthoringProject,
  shaderId: string,
): Record<string, unknown> {
  const runtime = buildShaderMaterialProject(project);
  return {
    schema: SHADER_PREVIEW_SCHEMA,
    shaderMaterials: runtime.project,
    diagnostics: runtime.diagnostics,
    shaderId,
    previewMaterialId: `editor/preview/shader/${shaderId}`,
    template: {
      rml: '/editor-assets/internal-preview/shader-square-preview.rml',
      rcss: '/editor-assets/internal-preview/shader-square-preview.rcss',
      materialPlaceholder: '__NT_PREVIEW_MATERIAL_ID__',
    },
    preview: { geometry: 'square', background: 'dark' },
  };
}

export function shaderForMaterial(
  project: AuthoringProject,
  data: MaterialData | null,
): ShaderData | null {
  const shaderId = data?.shader?.$ref.id;
  return shaderId ? parseShaderData(project.shaders[shaderId]?.data) : null;
}
