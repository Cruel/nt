import { z } from 'zod';
import { parseAssetData } from './authoring-assets';
import type { AuthoringProject } from './authoring-project';
import {
  materialBlendValues,
  materialTextureFilteringValues,
  postprocessScopeValues,
  parseMaterialData,
  resolveMaterialData,
  type MaterialData,
  type MaterialTextureSource,
} from './authoring-materials';
import {
  shaderInputBindingValues,
  parseShaderData,
  shaderCompiledOutputIsFresh,
  shaderRoleValues,
  shaderSamplerBindingValues,
  shaderUniformTypeValues,
  shaderUniformValueSchema,
  type ShaderData,
  type ShaderStageData,
  type ShaderUniformData,
} from './authoring-shaders';

export const SHADER_MATERIAL_SCHEMA = 'noveltea.shader-materials.v2' as const;
export const SHADER_PREVIEW_SCHEMA = 'noveltea.shader-preview.v1' as const;

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
export const runtimeShaderCompiledOutputSchema = strict({
  runtimePath: z.string().regex(/^(?:project|system):\/.+/),
  byteHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  byteSize: z.number().int().nonnegative(),
});
const runtimeShaderStageSchema = strict({
  source: z.string().min(1).optional(),
  source_text: z.string().optional(),
  compiled: z.record(z.string(), runtimeShaderCompiledOutputSchema).optional(),
}).superRefine((stage, context) => {
  if (stage.source !== undefined && stage.source_text !== undefined)
    context.addIssue({
      code: 'custom',
      message: 'Runtime Shader stage cannot contain both source and source_text.',
    });
});
const runtimeShaderUniformSchema = strict({
  type: z.enum(shaderUniformTypeValues),
  default: shaderUniformValueSchema.optional(),
  range: z.tuple([z.number().finite(), z.number().finite()]).optional(),
  binding: z.enum(shaderInputBindingValues).nullable().optional(),
  editor: strict({ label: z.string() }).optional(),
});
const runtimeShaderRoleBindingSchema = strict({
  vertex: z.string().min(1).optional(),
  fragment: z.string().min(1).optional(),
}).refine((binding) => binding.vertex !== undefined || binding.fragment !== undefined, {
  message: 'Runtime Shader role binding must select at least one stage.',
});
export const runtimeShaderDefinitionSchema = strict({
  display_name: z.string(),
  stages: strict({
    vertex: runtimeShaderStageSchema.optional(),
    fragment: runtimeShaderStageSchema.optional(),
  }),
  uniforms: z.record(z.string().min(1), runtimeShaderUniformSchema),
  samplers: z.record(
    z.string().min(1),
    strict({
      type: z.literal('texture2d'),
      binding: z.enum(shaderSamplerBindingValues).nullable(),
    }),
  ),
  roles: z.array(z.enum(shaderRoleValues)),
  role_bindings: z.record(z.string(), runtimeShaderRoleBindingSchema),
}).superRefine((shader, context) => {
  const declaredRoles = new Set<string>();
  shader.roles.forEach((role, index) => {
    if (declaredRoles.has(role))
      context.addIssue({
        code: 'custom',
        path: ['roles', index],
        message: `Runtime Shader role '${role}' is duplicated.`,
      });
    declaredRoles.add(role);
  });
  for (const role of Object.keys(shader.role_bindings)) {
    if (!shaderRoleValues.includes(role as (typeof shaderRoleValues)[number]))
      context.addIssue({
        code: 'custom',
        path: ['role_bindings', role],
        message: `Runtime Shader role binding '${role}' is unknown.`,
      });
    else if (!declaredRoles.has(role))
      context.addIssue({
        code: 'custom',
        path: ['role_bindings', role],
        message: `Runtime Shader role binding '${role}' is not declared in roles.`,
      });
  }
});
export const runtimeMaterialDefinitionSchema = strict({
  display_name: z.string(),
  role: z.enum(shaderRoleValues),
  postprocess_scope: z.enum(postprocessScopeValues).optional(),
  shader: z.string().min(1),
  uniforms: z.record(z.string().min(1), shaderUniformValueSchema),
  textures: z.record(
    z.string().min(1),
    strict({
      source: z.string().min(1),
      sampler: z.enum(materialTextureFilteringValues),
    }),
  ),
  blend: z.enum(materialBlendValues),
}).superRefine((material, context) => {
  if (material.role === 'postprocess' && material.postprocess_scope === undefined)
    context.addIssue({
      code: 'custom',
      path: ['postprocess_scope'],
      message: 'Postprocess Material requires postprocess_scope.',
    });
  if (material.role !== 'postprocess' && material.postprocess_scope !== undefined)
    context.addIssue({
      code: 'custom',
      path: ['postprocess_scope'],
      message: 'Only a postprocess Material may specify postprocess_scope.',
    });
});
export const shaderMaterialProjectWireSchema = strict({
  schema: z.literal(SHADER_MATERIAL_SCHEMA),
  shaders: z.record(z.string().min(1), runtimeShaderDefinitionSchema),
  materials: z.record(z.string().min(1), runtimeMaterialDefinitionSchema),
});

export interface ShaderMaterialProjectDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
}

export interface ShaderMaterialProjectBuildResult {
  project: z.infer<typeof shaderMaterialProjectWireSchema>;
  diagnostics: ShaderMaterialProjectDiagnostic[];
}

type RuntimeShaderDefinition = z.infer<typeof runtimeShaderDefinitionSchema>;
type RuntimeMaterialDefinition = z.infer<typeof runtimeMaterialDefinitionSchema>;

function diagnostic(
  path: string,
  message: string,
  severity: 'error' | 'warning' | 'info' = 'error',
): ShaderMaterialProjectDiagnostic {
  return { severity, path, message, category: 'shader-material-project' };
}

export async function buildShaderMaterialProject(
  project: AuthoringProject,
): Promise<ShaderMaterialProjectBuildResult> {
  const diagnostics: ShaderMaterialProjectDiagnostic[] = [];
  const shaders: Record<string, RuntimeShaderDefinition> = {};
  const materials: Record<string, RuntimeMaterialDefinition> = {};

  for (const shaderId of Object.keys(project.shaders)) {
    const shader = await buildShaderDefinition(project, shaderId);
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

export async function buildShaderDefinition(
  project: AuthoringProject,
  shaderId: string,
): Promise<{
  value: RuntimeShaderDefinition | null;
  diagnostics: ShaderMaterialProjectDiagnostic[];
}> {
  const diagnostics: ShaderMaterialProjectDiagnostic[] = [];
  const record = project.shaders[shaderId];
  const data = parseShaderData(record?.data);
  if (!record || !data)
    return {
      value: null,
      diagnostics: [diagnostic(`/shaders/${shaderId}/data`, 'Invalid shader data.')],
    };

  const stages: Record<string, unknown> = {};
  for (const [index, stage] of data.stages.entries()) {
    const converted = await shaderStageToRuntime(project, shaderId, stage, index);
    diagnostics.push(...converted.diagnostics);
    if (converted.value) stages[stage.stage] = converted.value;
  }

  const uniforms: Record<string, unknown> = {};
  for (const uniform of data.uniforms) uniforms[uniform.name] = uniformToRuntime(uniform);

  const samplers: Record<string, unknown> = {};
  for (const sampler of data.samplers)
    samplers[sampler.name] = { type: sampler.type, binding: sampler.binding };

  const roleBindings = Object.fromEntries(
    data.roleBindings.map((binding) => [
      binding.role,
      {
        ...(binding.vertexShader ? { vertex: binding.vertexShader.$ref.id } : {}),
        ...(binding.fragmentShader ? { fragment: binding.fragmentShader.$ref.id } : {}),
      },
    ]),
  );

  const runtime = runtimeShaderDefinitionSchema.safeParse({
    display_name: data.displayName ?? record.label,
    stages,
    uniforms,
    samplers,
    roles: data.roles,
    role_bindings: roleBindings,
  });
  if (!runtime.success)
    diagnostics.push(
      diagnostic(`/shaders/${shaderId}/data`, 'Generated Shader wire data is invalid.'),
    );
  return { value: runtime.success ? runtime.data : null, diagnostics };
}

async function shaderStageToRuntime(
  project: AuthoringProject,
  shaderId: string,
  stage: ShaderStageData,
  index: number,
): Promise<{
  value: Record<string, unknown> | null;
  diagnostics: ShaderMaterialProjectDiagnostic[];
}> {
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
  const compiledEntries: [string, unknown][] = [];
  for (const [variant, output] of Object.entries(stage.compiled ?? {})) {
    const fresh = await shaderCompiledOutputIsFresh(project, shaderId, index, variant, output);
    if (!fresh)
      diagnostics.push(
        diagnostic(
          `${base}/compiled/${variant}`,
          `Compiled Shader output for '${variant}' is stale. Recompile the Shader.`,
        ),
      );
    if (fresh)
      compiledEntries.push([
        variant,
        {
          runtimePath: output.path,
          byteHash: output.byteHash,
          byteSize: output.byteSize,
        },
      ]);
  }
  const compiled = Object.fromEntries(compiledEntries);
  if (Object.keys(compiled).length > 0) value.compiled = compiled;
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
): { value: RuntimeMaterialDefinition | null; diagnostics: ShaderMaterialProjectDiagnostic[] } {
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

  const runtime = runtimeMaterialDefinitionSchema.safeParse({
    display_name: data.displayName ?? record.label,
    role: data.role,
    ...(data.role === 'postprocess' ? { postprocess_scope: data.postprocessScope } : {}),
    shader: data.shader.$ref.id,
    uniforms,
    textures,
    blend: data.blend,
  });
  if (!runtime.success)
    diagnostics.push(
      diagnostic(`/materials/${materialId}/data`, 'Generated Material wire data is invalid.'),
    );
  return { value: runtime.success ? runtime.data : null, diagnostics };
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

export async function buildMaterialPreviewDocumentData(
  project: AuthoringProject,
  materialId: string,
): Promise<Record<string, unknown>> {
  const runtime = await buildShaderMaterialProject(project);
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

export async function buildShaderPreviewDocumentData(
  project: AuthoringProject,
  shaderId: string,
): Promise<Record<string, unknown>> {
  const runtime = await buildShaderMaterialProject(project);
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
