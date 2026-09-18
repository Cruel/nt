import { z } from 'zod';
import type { ShaderCompileOutput } from '../editor-tooling';
import { sha256HexUtf8 } from '../web-crypto';
import { parseAssetData } from './authoring-assets';
import type { AuthoringProject } from './authoring-project';
import {
  materialBlendValues,
  materialTextureFilteringValues,
  postprocessScopeValues,
  resolveMaterialData,
  type MaterialTextureSource,
  type ResolvedMaterialData,
} from './authoring-materials';
import {
  shaderInputBindingValues,
  shaderRoleValues,
  shaderSamplerBindingValues,
  shaderUniformTypeValues,
  shaderUniformValueSchema,
  type ShaderUniformType,
  type ShaderUniformValue,
} from './authoring-shaders';

export const SHADER_MATERIAL_SCHEMA = 'noveltea.shader-materials' as const;
export const SHADER_SOURCE_PROGRAMS_SCHEMA = 'noveltea.shader-source-programs' as const;
export const SHADER_PREVIEW_SCHEMA = 'noveltea.shader-preview' as const;
const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

const runtimeTrustedSystemShaderOutputSchema = strict({
  runtimePath: z.string().regex(/^system:\/.+/),
});
const runtimeProjectShaderOutputSchema = strict({
  runtimePath: z.string().regex(/^project:\/.+/),
  byteHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  byteSize: z.number().int().nonnegative(),
});
export const runtimeShaderCompiledOutputSchema = z.union([
  runtimeTrustedSystemShaderOutputSchema,
  runtimeProjectShaderOutputSchema,
]);
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
    strict({ source: z.string().min(1), sampler: z.enum(materialTextureFilteringValues) }),
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

export const shaderSourceProgramRequestSchema = strict({
  vertexSource: z.string().min(1),
  fragmentSource: z.string().min(1),
  varyingDefinition: z.string().min(1),
  interfaceContract: z.string().min(1),
});
export const shaderSourceProgramsSchema = strict({
  schema: z.literal(SHADER_SOURCE_PROGRAMS_SCHEMA),
  programs: z.record(z.string().min(1), shaderSourceProgramRequestSchema),
});
export type ShaderSourcePrograms = z.infer<typeof shaderSourceProgramsSchema>;

export interface ShaderMaterialProjectDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
}
export interface ShaderMaterialProjectBuildResult {
  project: z.infer<typeof shaderMaterialProjectWireSchema>;
  compilation: ShaderSourcePrograms;
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

const variants = ['glsl-330', 'essl-300', 'metal'] as const;
function systemStage(program: string, stage: 'vertex' | 'fragment') {
  const suffix = stage === 'vertex' ? 'vs' : 'fs';
  return {
    compiled: Object.fromEntries(
      variants.map((variant) => [
        variant,
        { runtimePath: `system:/shaders/bgfx/${variant}/${program}.${suffix}.bin` },
      ]),
    ) as Record<string, { runtimePath: string }>,
  };
}
function customProgramRequest(resolved: ResolvedMaterialData) {
  return {
    vertexSource: resolved.vertexSource,
    fragmentSource: resolved.fragmentSource,
    varyingDefinition: resolved.varyingDefinition,
    interfaceContract: resolved.interfaceContract,
  };
}
async function programKey(resolved: ResolvedMaterialData): Promise<string> {
  return `program-${(await sha256HexUtf8(JSON.stringify(customProgramRequest(resolved)))).slice(0, 24)}`;
}
function isCustomProgram(resolved: ResolvedMaterialData): boolean {
  return (
    resolved.vertexSource.startsWith('project:/') ||
    resolved.fragmentSource.startsWith('project:/') ||
    resolved.varyingDefinition.startsWith('project:/')
  );
}
function runtimeTextureSource(
  project: AuthoringProject,
  source: MaterialTextureSource,
): string | null {
  if ('$ref' in source) {
    const asset = parseAssetData(project.assets[source.$ref.id]?.data);
    return asset ? `project:/${asset.source.path}` : null;
  }
  if ('alias' in source) return `alias:${source.alias}`;
  return source.uri;
}
function runtimeUniformValue(
  value: ShaderUniformValue | undefined,
): ShaderUniformValue | undefined {
  return value === undefined || value === null ? undefined : value;
}
function reflectedType(type: string): ShaderUniformType | null {
  if (type === 'vec4') return 'vec4';
  return null;
}

export async function buildShaderMaterialProject(
  project: AuthoringProject,
  compiledOutputs: readonly ShaderCompileOutput[] = [],
): Promise<ShaderMaterialProjectBuildResult> {
  const diagnostics: ShaderMaterialProjectDiagnostic[] = [];
  const shaders: Record<string, RuntimeShaderDefinition> = {};
  const materials: Record<string, RuntimeMaterialDefinition> = {};
  const programs: ShaderSourcePrograms['programs'] = {};
  const compiledByProgram = new Map<string, ShaderCompileOutput[]>();
  for (const output of compiledOutputs) {
    const bucket = compiledByProgram.get(output.program) ?? [];
    bucket.push(output);
    compiledByProgram.set(output.program, bucket);
  }

  for (const [materialId, record] of Object.entries(project.materials)) {
    const resolution = resolveMaterialData(project, materialId);
    diagnostics.push(...resolution.diagnostics);
    const resolved = resolution.data;
    if (!resolved) continue;
    const key = isCustomProgram(resolved)
      ? await programKey(resolved)
      : `preset-${resolved.preset.id}`;
    if (isCustomProgram(resolved)) programs[key] = customProgramRequest(resolved);
    if (!shaders[key]) {
      const built = buildRuntimeShader(
        materialId,
        resolved,
        key,
        compiledByProgram.get(key) ?? [],
        diagnostics,
      );
      if (built) shaders[key] = built;
    }
    const uniforms: Record<string, ShaderUniformValue> = {};
    for (const [name, parameter] of Object.entries(resolved.parameters)) {
      const value = runtimeUniformValue(parameter.value);
      if (value !== undefined && parameter.binding == null) uniforms[name] = value;
    }
    const textures: RuntimeMaterialDefinition['textures'] = {};
    for (const [name, texture] of Object.entries(resolved.textures)) {
      if (!texture.source || texture.binding != null) continue;
      const source = runtimeTextureSource(project, texture.source);
      if (source) textures[name] = { source, sampler: texture.filtering };
      else
        diagnostics.push(
          diagnostic(
            `/materials/${materialId}/data/textures/${name}/source`,
            'Material texture source could not be lowered.',
          ),
        );
    }
    const parsedMaterial = runtimeMaterialDefinitionSchema.safeParse({
      display_name: record.label,
      role: resolved.role,
      ...(resolved.role === 'postprocess' ? { postprocess_scope: resolved.postprocessScope } : {}),
      shader: key,
      uniforms,
      textures,
      blend: resolved.blend,
    });
    if (!parsedMaterial.success) {
      diagnostics.push(
        diagnostic(`/materials/${materialId}/data`, 'Generated Material wire data is invalid.'),
      );
      continue;
    }
    materials[materialId] = parsedMaterial.data;
  }
  return {
    project: { schema: SHADER_MATERIAL_SCHEMA, shaders, materials },
    compilation: { schema: SHADER_SOURCE_PROGRAMS_SCHEMA, programs },
    diagnostics,
  };
}

function buildRuntimeShader(
  materialId: string,
  resolved: ResolvedMaterialData,
  key: string,
  outputs: readonly ShaderCompileOutput[],
  diagnostics: ShaderMaterialProjectDiagnostic[],
): RuntimeShaderDefinition | null {
  const custom = isCustomProgram(resolved);
  const stages: RuntimeShaderDefinition['stages'] = custom
    ? {
        vertex: { source: resolved.vertexSource, compiled: {} },
        fragment: { source: resolved.fragmentSource, compiled: {} },
      }
    : {
        vertex: systemStage(resolved.preset.programName, 'vertex'),
        fragment: systemStage(resolved.preset.programName, 'fragment'),
      };
  for (const output of outputs) {
    const stage = output.stage === 'vertex' ? stages.vertex : stages.fragment;
    if (!stage) continue;
    stage.compiled ??= {};
    stage.compiled[output.variant] = {
      runtimePath: output.runtimePath,
      byteHash: output.byteHash,
      byteSize: output.byteSize,
    };
  }
  const reflected = new Map<string, { kind: 'uniform' | 'sampled-image'; type: string }>();
  for (const output of outputs)
    for (const input of output.reflectedInputs ?? [])
      reflected.set(input.name, { kind: input.kind, type: input.type });

  const uniforms: RuntimeShaderDefinition['uniforms'] = {};
  const samplers: RuntimeShaderDefinition['samplers'] = {};
  if (custom && outputs.length > 0) {
    for (const [name, input] of reflected) {
      if (input.kind === 'sampled-image') {
        samplers[name] = { type: 'texture2d', binding: resolved.textures[name]?.binding ?? null };
        continue;
      }
      const preset = resolved.preset.uniforms[name];
      const type = preset?.type ?? reflectedType(input.type);
      if (!type) {
        diagnostics.push(
          diagnostic(
            `/materials/${materialId}/data/parameters/${name}`,
            `Reflected uniform '${name}' has unsupported runtime type '${input.type}'.`,
          ),
        );
        continue;
      }
      const parameter = resolved.parameters[name];
      uniforms[name] = {
        type,
        ...(parameter?.value !== undefined
          ? { default: parameter.value }
          : preset?.default !== undefined
            ? { default: preset.default }
            : {}),
        ...(preset?.range ? { range: [...preset.range] as [number, number] } : {}),
        binding: parameter?.binding ?? preset?.binding ?? null,
        ...(parameter?.editor?.label || preset?.label
          ? { editor: { label: parameter?.editor?.label ?? preset?.label ?? name } }
          : {}),
      };
    }
    for (const name of Object.keys(resolved.parameters))
      if (!reflected.has(name))
        diagnostics.push(
          diagnostic(
            `/materials/${materialId}/data/parameters/${name}`,
            `Material parameter '${name}' is not present in the reflected shader interface and remains orphaned.`,
            'warning',
          ),
        );
    for (const name of Object.keys(resolved.textures))
      if (!reflected.has(name))
        diagnostics.push(
          diagnostic(
            `/materials/${materialId}/data/textures/${name}`,
            `Material texture '${name}' is not present in the reflected shader interface and remains orphaned.`,
            'warning',
          ),
        );
  } else {
    for (const [name, value] of Object.entries(resolved.preset.uniforms))
      uniforms[name] = {
        type: value.type,
        ...(value.default !== undefined ? { default: value.default } : {}),
        ...(value.range ? { range: [...value.range] as [number, number] } : {}),
        binding: value.binding ?? null,
        ...(value.label ? { editor: { label: value.label } } : {}),
      };
    for (const [name, value] of Object.entries(resolved.preset.samplers))
      samplers[name] = { type: 'texture2d', binding: value.binding ?? null };
  }
  const candidate = {
    display_name: custom ? `Derived ${resolved.preset.label}` : resolved.preset.label,
    stages,
    uniforms,
    samplers,
    roles: [resolved.role],
    role_bindings: { [resolved.role]: { vertex: key, fragment: key } },
  };
  const parsed = runtimeShaderDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    diagnostics.push(
      diagnostic(`/materials/${materialId}/data`, 'Generated runtime shader metadata is invalid.'),
    );
    return null;
  }
  return parsed.data;
}

export function buildMaterialDefinition(
  project: AuthoringProject,
  materialId: string,
): { value: RuntimeMaterialDefinition | null; diagnostics: ShaderMaterialProjectDiagnostic[] } {
  const record = project.materials[materialId];
  const resolution = resolveMaterialData(project, materialId);
  if (!record || !resolution.data) return { value: null, diagnostics: resolution.diagnostics };
  const resolved = resolution.data;
  const uniforms: Record<string, ShaderUniformValue> = {};
  for (const [name, parameter] of Object.entries(resolved.parameters))
    if (parameter.value !== undefined && parameter.binding == null)
      uniforms[name] = parameter.value;
  const textures: RuntimeMaterialDefinition['textures'] = {};
  for (const [name, texture] of Object.entries(resolved.textures)) {
    if (!texture.source || texture.binding != null) continue;
    const source = runtimeTextureSource(project, texture.source);
    if (source) textures[name] = { source, sampler: texture.filtering };
  }
  return {
    value: runtimeMaterialDefinitionSchema.parse({
      display_name: record.label,
      role: resolved.role,
      ...(resolved.role === 'postprocess' ? { postprocess_scope: resolved.postprocessScope } : {}),
      shader: isCustomProgram(resolved) ? `material-${materialId}` : `preset-${resolved.preset.id}`,
      uniforms,
      textures,
      blend: resolved.blend,
    }),
    diagnostics: resolution.diagnostics,
  };
}

export function materialPreviewRevision(project: AuthoringProject, materialId: string): string {
  const resolved = resolveMaterialData(project, materialId);
  return JSON.stringify({ record: project.materials[materialId] ?? null, resolved: resolved.data });
}
export async function buildMaterialPreviewDocumentData(
  project: AuthoringProject,
  materialId: string,
) {
  const built = await buildShaderMaterialProject(project);
  return {
    schema: SHADER_PREVIEW_SCHEMA,
    material: materialId,
    shaderMaterials: built.project,
    diagnostics: built.diagnostics,
  };
}
export function shaderForMaterial(project: AuthoringProject, materialId: string) {
  return resolveMaterialData(project, materialId).data;
}
