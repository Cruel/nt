import { z } from 'zod';
import type { ShaderCompileOutput } from '../editor-tooling';
import { sha256HexUtf8 } from '../web-crypto';
import { parseAssetData } from './authoring-assets';
import type { AuthoringProject } from './authoring-project';
import { materialContractRegistry } from './material-contract-registry.generated';
import {
  materialBlendValues,
  materialTextureFilteringValues,
  resolvedMaterialUsesCustomShader,
  resolveMaterialAuthoredOverrides,
  resolveMaterialData,
  type MaterialAuthoredOverrides,
  type MaterialTextureSource,
  type ResolvedMaterialData,
} from './authoring-materials';
import {
  isUniformValueCompatible,
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
  binding: z.enum(shaderInputBindingValues).optional(),
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
  interface_contract: z.string().min(1),
  interface_fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  stages: strict({
    vertex: runtimeShaderStageSchema.optional(),
    fragment: runtimeShaderStageSchema.optional(),
  }),
  uniforms: z.record(z.string().min(1), runtimeShaderUniformSchema),
  samplers: z.record(
    z.string().min(1),
    strict({
      type: z.literal('texture2d'),
      stage: z.number().int().min(0).max(255),
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
  shader: z.string().min(1),
  uniforms: z.record(z.string().min(1), shaderUniformValueSchema),
  textures: z.record(
    z.string().min(1),
    strict({ source: z.string().min(1), sampler: z.enum(materialTextureFilteringValues) }),
  ),
  blend: z.enum(materialBlendValues),
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
  interfaceFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
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
export interface ShaderMaterialProjectBuildOptions {
  certifyPresetPrograms?: boolean;
}
type RuntimeShaderDefinition = z.infer<typeof runtimeShaderDefinitionSchema>;
type RuntimeMaterialDefinition = z.infer<typeof runtimeMaterialDefinitionSchema>;
export interface MaterialDerivedInterface {
  uniforms: RuntimeShaderDefinition['uniforms'];
  samplers: RuntimeShaderDefinition['samplers'];
}

export function materialDerivedInterface(
  project: z.infer<typeof shaderMaterialProjectWireSchema>,
  materialId: string,
): MaterialDerivedInterface | null {
  const material = project.materials[materialId];
  if (!material) return null;
  const shader = project.shaders[material.shader];
  return shader ? { uniforms: shader.uniforms, samplers: shader.samplers } : null;
}
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
    interfaceFingerprint: resolved.interfaceFingerprint,
  };
}
async function programKey(resolved: ResolvedMaterialData): Promise<string> {
  return `program-${(await sha256HexUtf8(JSON.stringify(customProgramRequest(resolved)))).slice(0, 24)}`;
}
function isCustomProgram(resolved: ResolvedMaterialData): boolean {
  return resolvedMaterialUsesCustomShader(resolved);
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
const bgfxPredefinedUniformNames = new Set([
  'u_viewRect',
  'u_viewTexel',
  'u_view',
  'u_invView',
  'u_proj',
  'u_invProj',
  'u_viewProj',
  'u_invViewProj',
  'u_model',
  'u_modelView',
  'u_modelViewProj',
  'u_alphaRef4',
]);

function isBgfxPredefinedUniform(name: string): boolean {
  return bgfxPredefinedUniformNames.has(name);
}

function implicitUniformDefault(type: ShaderUniformType): ShaderUniformValue {
  switch (type) {
    case 'float':
    case 'int':
      return 0;
    case 'bool':
      return false;
    case 'vec2':
      return [0, 0];
    case 'vec3':
      return [0, 0, 0];
    case 'vec4':
    case 'color':
      return [0, 0, 0, 0];
  }
}

export async function buildShaderMaterialProject(
  project: AuthoringProject,
  compiledOutputs: readonly ShaderCompileOutput[] = [],
  options: ShaderMaterialProjectBuildOptions = {},
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
    const custom = isCustomProgram(resolved);
    const authoredOverrides = resolveMaterialAuthoredOverrides(project, materialId) ?? {
      parameters: {},
      textures: {},
    };
    const program = custom ? await programKey(resolved) : `preset-${resolved.preset.id}`;
    if (custom || options.certifyPresetPrograms)
      programs[program] ??= customProgramRequest(resolved);
    const shaderId = custom ? `${program}-material-${materialId}` : program;
    if (!shaders[shaderId]) {
      const built = buildRuntimeShader(
        materialId,
        resolved,
        shaderId,
        compiledByProgram.get(program) ?? [],
        authoredOverrides,
        diagnostics,
      );
      if (built) shaders[shaderId] = built;
    }
    const shader = shaders[shaderId];
    const uniforms: Record<string, ShaderUniformValue> = {};
    for (const [name, parameter] of Object.entries(
      custom ? authoredOverrides.parameters : resolved.parameters,
    )) {
      const declaration = shader?.uniforms[name];
      const value = runtimeUniformValue(parameter.value);
      if (
        declaration &&
        declaration.binding == null &&
        value !== undefined &&
        isUniformValueCompatible(declaration.type, value)
      )
        uniforms[name] = value;
    }
    const textures: RuntimeMaterialDefinition['textures'] = {};
    for (const [name, texture] of Object.entries(
      custom ? authoredOverrides.textures : resolved.textures,
    )) {
      const declaration = shader?.samplers[name];
      if (!declaration || declaration.binding != null || !texture.source) continue;
      const source = runtimeTextureSource(project, texture.source);
      if (source)
        textures[name] = {
          source,
          sampler: resolved.textures[name]?.filtering ?? 'clamp-linear',
        };
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
      shader: shaderId,
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
  authoredOverrides: MaterialAuthoredOverrides,
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
  const reflected = new Map<
    string,
    {
      kind: 'uniform' | 'sampled-image';
      type: string;
      arraySize: number;
      registerIndex?: number;
      registerCount?: number;
    }
  >();
  const reflectionConflicts = new Set<string>();
  for (const output of outputs)
    for (const input of output.reflectedInputs ?? []) {
      if (input.kind === 'uniform' && isBgfxPredefinedUniform(input.name)) continue;
      const existing = reflected.get(input.name);
      const samplerRegisterConflict =
        existing?.kind === 'sampled-image' &&
        input.kind === 'sampled-image' &&
        (existing.registerIndex !== input.registerIndex ||
          existing.registerCount !== input.registerCount);
      if (
        existing &&
        (existing.kind !== input.kind ||
          existing.type !== input.type ||
          existing.arraySize !== input.arraySize ||
          samplerRegisterConflict)
      ) {
        if (!reflectionConflicts.has(input.name))
          diagnostics.push(
            diagnostic(
              `/materials/${materialId}/data/parameters/${input.name}`,
              `Reflected input '${input.name}' has inconsistent declarations across compiled shader stages or variants.`,
            ),
          );
        reflectionConflicts.add(input.name);
        continue;
      }
      reflected.set(input.name, {
        kind: input.kind,
        type: input.type,
        arraySize: input.arraySize,
        registerIndex: input.registerIndex,
        registerCount: input.registerCount,
      });
    }

  const uniforms: RuntimeShaderDefinition['uniforms'] = {};
  const samplers: RuntimeShaderDefinition['samplers'] = {};
  if (custom) {
    const roleContract = materialContractRegistry.roles.find((role) => role.id === resolved.role);
    const rendererUniformNames = new Set(
      roleContract?.reservedInterface.rendererUniforms.map((uniform) => uniform.name) ?? [],
    );
    const migratedRendererSamplerContract =
      resolved.role === 'engine-2d' ||
      resolved.role === 'active-text' ||
      resolved.role === 'rmlui-decorator' ||
      resolved.role === 'postprocess' ||
      resolved.role === 'hotspot-overlay';
    const rendererSamplerNames = new Set(
      migratedRendererSamplerContract
        ? (roleContract?.reservedInterface.samplers
            .filter((sampler) => sampler.sourceOwnership === 'renderer')
            .map((sampler) => sampler.name) ?? [])
        : [],
    );
    const standardSemanticTypes = new Map(
      roleContract?.standardSemanticAvailability.map((entry) => [
        entry.semantic,
        entry.logicalType,
      ]) ?? [],
    );
    for (const [name, input] of reflected) {
      if (reflectionConflicts.has(name)) continue;
      if (input.arraySize !== 1) {
        diagnostics.push(
          diagnostic(
            `/materials/${materialId}/data/parameters/${name}`,
            `Reflected input '${name}' uses unsupported array size ${input.arraySize}.`,
          ),
        );
        continue;
      }
      if (input.kind === 'sampled-image') {
        const texture = authoredOverrides.textures[name];
        const binding =
          texture?.binding !== undefined
            ? texture.binding
            : (resolved.preset.samplers[name]?.binding ?? null);
        if (texture?.source !== undefined && (binding !== null || rendererSamplerNames.has(name)))
          diagnostics.push(
            diagnostic(
              `/materials/${materialId}/data/textures/${name}/source`,
              `Renderer-owned reflected texture '${name}' cannot have an authored source.`,
            ),
          );
        if (input.registerIndex === undefined) {
          diagnostics.push(
            diagnostic(
              `/materials/${materialId}/data/textures/${name}`,
              `Reflected sampler '${name}' is missing its compiled sampler stage.`,
            ),
          );
          continue;
        }
        samplers[name] = { type: 'texture2d', stage: input.registerIndex, binding };
        continue;
      }
      if (rendererUniformNames.has(name)) continue;
      if (input.type !== 'vec4') {
        diagnostics.push(
          diagnostic(
            `/materials/${materialId}/data/parameters/${name}`,
            `Author Material uniform '${name}' must use physical vec4, not '${input.type}'.`,
          ),
        );
        continue;
      }
      const parameter = authoredOverrides.parameters[name];
      const effectiveParameter = resolved.parameters[name];
      const binding = parameter?.binding ?? effectiveParameter?.binding ?? null;
      const boundLogicalType = binding ? standardSemanticTypes.get(binding) : undefined;
      if (binding && boundLogicalType === undefined)
        diagnostics.push(
          diagnostic(
            `/materials/${materialId}/data/parameters/${name}/binding`,
            `Standard semantic '${binding}' is not available to Material role '${resolved.role}'.`,
          ),
        );
      const type = (boundLogicalType ??
        effectiveParameter?.type ??
        parameter?.type ??
        'vec4') as ShaderUniformType;
      if (
        effectiveParameter?.type !== undefined &&
        boundLogicalType !== undefined &&
        effectiveParameter.type !== boundLogicalType
      )
        diagnostics.push(
          diagnostic(
            `/materials/${materialId}/data/parameters/${name}/type`,
            `Logical type '${effectiveParameter.type}' does not match standard semantic '${binding}' type '${boundLogicalType}'.`,
          ),
        );
      const value = effectiveParameter?.value;
      if (value !== undefined && !isUniformValueCompatible(type, value))
        diagnostics.push(
          diagnostic(
            `/materials/${materialId}/data/parameters/${name}/value`,
            `Material parameter '${name}' does not match logical shader type '${type}'.`,
          ),
        );
      if (value !== undefined && binding !== null)
        diagnostics.push(
          diagnostic(
            `/materials/${materialId}/data/parameters/${name}/value`,
            `Renderer-bound reflected parameter '${name}' cannot have an authored value.`,
          ),
        );
      const editor = effectiveParameter?.editor;
      uniforms[name] = {
        type,
        ...(binding === null
          ? {
              default:
                value !== undefined && isUniformValueCompatible(type, value)
                  ? value
                  : implicitUniformDefault(type),
            }
          : {}),
        ...(editor?.range ? { range: [...editor.range] as [number, number] } : {}),
        ...(binding !== null ? { binding } : {}),
        ...(editor?.label ? { editor: { label: editor.label } } : {}),
      };
    }
    if (outputs.length > 0) {
      for (const name of Object.keys(authoredOverrides.parameters))
        if (!reflected.has(name))
          diagnostics.push(
            diagnostic(
              `/materials/${materialId}/data/parameters/${name}`,
              `Material parameter '${name}' is not present in the reflected shader interface and remains orphaned.`,
              'warning',
            ),
          );
      for (const name of Object.keys(authoredOverrides.textures))
        if (!reflected.has(name))
          diagnostics.push(
            diagnostic(
              `/materials/${materialId}/data/textures/${name}`,
              `Material texture '${name}' is not present in the reflected shader interface and remains orphaned.`,
              'warning',
            ),
          );
    }
  } else {
    for (const [name, value] of Object.entries(resolved.preset.uniforms))
      uniforms[name] = {
        type: value.type,
        ...(value.default !== undefined ? { default: value.default } : {}),
        ...(value.range ? { range: [...value.range] as [number, number] } : {}),
        ...(value.binding !== undefined ? { binding: value.binding } : {}),
        ...(value.label ? { editor: { label: value.label } } : {}),
      };
    const roleContract = materialContractRegistry.roles.find((role) => role.id === resolved.role);
    for (const [name, value] of Object.entries(resolved.preset.samplers)) {
      const contractSampler = roleContract?.reservedInterface.samplers.find(
        (sampler) => sampler.name === name,
      );
      if (!contractSampler) {
        diagnostics.push(
          diagnostic(
            `/materials/${materialId}/data/textures/${name}`,
            `Preset sampler '${name}' is missing from Material role '${resolved.role}' contract.`,
          ),
        );
        continue;
      }
      samplers[name] = {
        type: 'texture2d',
        stage: contractSampler.stage,
        binding: value.binding ?? null,
      };
    }
    if (resolved.role === 'engine-2d') {
      const drawTextureSampler = roleContract?.reservedInterface.samplers.find(
        (sampler) =>
          sampler.sourceOwnership === 'renderer' && sampler.semantic === 'engine.draw_texture',
      );
      if (drawTextureSampler)
        samplers[drawTextureSampler.name] = {
          type: 'texture2d',
          stage: drawTextureSampler.stage,
          binding: null,
        };
    }
  }
  const candidate = {
    display_name: custom ? `Derived ${resolved.preset.label}` : resolved.preset.label,
    interface_contract: resolved.preset.interfaceContract,
    interface_fingerprint: resolved.preset.interfaceFingerprint,
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

export function materialPreviewRevision(project: AuthoringProject, materialId: string): string {
  const resolved = resolveMaterialData(project, materialId);
  return JSON.stringify({ record: project.materials[materialId] ?? null, resolved: resolved.data });
}
export async function buildMaterialPreviewDocumentData(
  project: AuthoringProject,
  materialId: string,
  compiledOutputs: readonly ShaderCompileOutput[] = [],
) {
  const built = await buildShaderMaterialProject(project, compiledOutputs);
  return {
    schema: SHADER_PREVIEW_SCHEMA,
    material: materialId,
    shaderMaterials: built.project,
    diagnostics: built.diagnostics,
    previewAssets: compiledOutputs
      .filter((output) => output.variant === 'essl-300')
      .map((output) => ({
        sourcePath: `.noveltea/build/${output.runtimePath.replace(/^project:\//, '')}`,
        runtimePath: output.runtimePath.replace(/^project:\//, ''),
      })),
  };
}
export function shaderForMaterial(project: AuthoringProject, materialId: string) {
  return resolveMaterialData(project, materialId).data;
}
