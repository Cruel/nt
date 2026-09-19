import { z } from 'zod';
import type { ShaderCompileOutput } from '../editor-tooling';
import { sha256HexUtf8 } from '../web-crypto';
import { parseAssetData } from './authoring-assets';
import type { AuthoringProject } from './authoring-project';
import { materialPresets } from './authoring-material-presets';
import {
  materialBlendValues,
  materialTextureFilteringValues,
  postprocessScopeValues,
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
  activeTextSourcePrograms: ReadonlyMap<string, string>;
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

function reflectedType(type: string): ShaderUniformType | null {
  if (
    type === 'float' ||
    type === 'vec2' ||
    type === 'vec3' ||
    type === 'vec4' ||
    type === 'int' ||
    type === 'bool'
  )
    return type;
  return null;
}

function activeTextPairKey(vertexSource: string, fragmentSource: string): string {
  return `${vertexSource}\u0000${fragmentSource}`;
}

function sourceBackedShaderIdentity(value: string | undefined): value is string {
  return value?.startsWith('project:/shaders/') === true || value?.startsWith('engine:/') === true;
}

export function rewriteActiveTextSourcePrograms(
  text: string,
  programs: ReadonlyMap<string, string>,
): string {
  const preset = materialPresets['active-text'];
  return text.replace(/\[shader\b([^\]]*)\]/giu, (tag, body: string) => {
    const attributes = new Map<string, string>();
    for (const attribute of body.matchAll(/(?:^|\s)([vf])=("[^"]*"|'[^']*'|[^\s\]]+)/giu)) {
      const raw = attribute[2] ?? '';
      attributes.set(attribute[1]!.toLowerCase(), raw.replace(/^(['"])(.*)\1$/u, '$2'));
    }
    const authoredVertex = attributes.get('v');
    const authoredFragment = attributes.get('f');
    if (
      (authoredVertex !== undefined && !sourceBackedShaderIdentity(authoredVertex)) ||
      (authoredFragment !== undefined && !sourceBackedShaderIdentity(authoredFragment)) ||
      (authoredVertex === undefined && authoredFragment === undefined)
    )
      return tag;
    const vertexSource = authoredVertex ?? preset.vertexSource;
    const fragmentSource = authoredFragment ?? preset.fragmentSource;
    const program = programs.get(activeTextPairKey(vertexSource, fragmentSource));
    return program ? `[shader v=source-program:${program} f=source-program:${program}]` : tag;
  });
}

function collectActiveTextSourcePairs(project: AuthoringProject): Array<{
  vertexSource: string;
  fragmentSource: string;
}> {
  const pairs = new Map<string, { vertexSource: string; fragmentSource: string }>();
  const preset = materialPresets['active-text'];
  const visit = (value: unknown) => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\[shader\b([^\]]*)\]/giu)) {
        const attributes = new Map<string, string>();
        for (const attribute of match[1]?.matchAll(
          /(?:^|\s)([vf])=("[^"]*"|'[^']*'|[^\s\]]+)/giu,
        ) ?? []) {
          const raw = attribute[2] ?? '';
          attributes.set(attribute[1]!.toLowerCase(), raw.replace(/^(['"])(.*)\1$/u, '$2'));
        }
        const authoredVertex = attributes.get('v');
        const authoredFragment = attributes.get('f');
        if (
          (authoredVertex !== undefined && !sourceBackedShaderIdentity(authoredVertex)) ||
          (authoredFragment !== undefined && !sourceBackedShaderIdentity(authoredFragment))
        )
          continue;
        if (authoredVertex === undefined && authoredFragment === undefined) continue;
        const vertexSource = authoredVertex ?? preset.vertexSource;
        const fragmentSource = authoredFragment ?? preset.fragmentSource;
        pairs.set(activeTextPairKey(vertexSource, fragmentSource), {
          vertexSource,
          fragmentSource,
        });
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === 'object')
      for (const item of Object.values(value as Record<string, unknown>)) visit(item);
  };
  visit(project);
  return [...pairs.values()];
}

function buildSourceProgramShaderDefinition(
  request: ShaderSourcePrograms['programs'][string],
  outputs: readonly ShaderCompileOutput[],
  role: 'active-text',
): RuntimeShaderDefinition {
  const stages: RuntimeShaderDefinition['stages'] = {
    vertex: { source: request.vertexSource, compiled: {} },
    fragment: { source: request.fragmentSource, compiled: {} },
  };
  for (const output of outputs) {
    const stage = output.stage === 'vertex' ? stages.vertex : stages.fragment;
    stage!.compiled ??= {};
    stage!.compiled![output.variant] = {
      runtimePath: output.runtimePath,
      byteHash: output.byteHash,
      byteSize: output.byteSize,
    };
  }
  const reflected = new Map<string, { kind: 'uniform' | 'sampled-image'; type: string }>();
  for (const output of outputs)
    for (const input of output.reflectedInputs) {
      if (input.kind === 'uniform' && isBgfxPredefinedUniform(input.name)) continue;
      reflected.set(input.name, { kind: input.kind, type: input.type });
    }
  const uniforms: RuntimeShaderDefinition['uniforms'] = {};
  const samplers: RuntimeShaderDefinition['samplers'] = {};
  for (const [name, input] of reflected) {
    if (input.kind === 'sampled-image') samplers[name] = { type: 'texture2d', binding: null };
    else {
      const type = reflectedType(input.type);
      if (type) uniforms[name] = { type };
    }
  }
  return runtimeShaderDefinitionSchema.parse({
    display_name: 'Derived ActiveText source program',
    stages,
    uniforms,
    samplers,
    roles: [role],
    role_bindings: {},
  });
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

  const activeTextSourcePrograms = new Map<string, string>();
  for (const pair of collectActiveTextSourcePairs(project)) {
    const preset = materialPresets['active-text'];
    const request: ShaderSourcePrograms['programs'][string] = {
      vertexSource: pair.vertexSource,
      fragmentSource: pair.fragmentSource,
      varyingDefinition: preset.varyingDefinition,
      interfaceContract: preset.interfaceContract,
    };
    const key = `active-text-${(await sha256HexUtf8(JSON.stringify(request))).slice(0, 24)}`;
    programs[key] = request;
    activeTextSourcePrograms.set(activeTextPairKey(pair.vertexSource, pair.fragmentSource), key);
    shaders[key] = buildSourceProgramShaderDefinition(
      request,
      compiledByProgram.get(key) ?? [],
      'active-text',
    );
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
    if (custom) programs[program] = customProgramRequest(resolved);
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
      ...(resolved.role === 'postprocess' ? { postprocess_scope: resolved.postprocessScope } : {}),
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
    activeTextSourcePrograms,
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
    { kind: 'uniform' | 'sampled-image'; type: string; arraySize: number }
  >();
  const reflectionConflicts = new Set<string>();
  for (const output of outputs)
    for (const input of output.reflectedInputs ?? []) {
      if (input.kind === 'uniform' && isBgfxPredefinedUniform(input.name)) continue;
      const existing = reflected.get(input.name);
      if (
        existing &&
        (existing.kind !== input.kind ||
          existing.type !== input.type ||
          existing.arraySize !== input.arraySize)
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
      });
    }

  const uniforms: RuntimeShaderDefinition['uniforms'] = {};
  const samplers: RuntimeShaderDefinition['samplers'] = {};
  if (custom) {
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
        if (texture?.source !== undefined && binding !== null)
          diagnostics.push(
            diagnostic(
              `/materials/${materialId}/data/textures/${name}/source`,
              `Renderer-bound reflected texture '${name}' cannot have an authored source.`,
            ),
          );
        samplers[name] = { type: 'texture2d', binding };
        continue;
      }
      const reflected = reflectedType(input.type);
      if (!reflected) {
        diagnostics.push(
          diagnostic(
            `/materials/${materialId}/data/parameters/${name}`,
            `Reflected uniform '${name}' has unsupported runtime type '${input.type}'.`,
          ),
        );
        continue;
      }
      const preset = resolved.preset.uniforms[name];
      const presetCompatible =
        preset !== undefined &&
        (preset.type === reflected || (preset.type === 'color' && reflected === 'vec4'));
      const type: ShaderUniformType = presetCompatible ? preset.type : reflected;
      const parameter = authoredOverrides.parameters[name];
      const binding =
        parameter?.binding !== undefined
          ? parameter.binding
          : presetCompatible
            ? (preset?.binding ?? null)
            : null;
      if (parameter?.value !== undefined && !isUniformValueCompatible(type, parameter.value))
        diagnostics.push(
          diagnostic(
            `/materials/${materialId}/data/parameters/${name}/value`,
            `Material parameter '${name}' does not match reflected shader type '${type}'.`,
          ),
        );
      if (parameter?.value !== undefined && binding !== null)
        diagnostics.push(
          diagnostic(
            `/materials/${materialId}/data/parameters/${name}/value`,
            `Renderer-bound reflected parameter '${name}' cannot have an authored value.`,
          ),
        );
      uniforms[name] = {
        type,
        ...(parameter?.value !== undefined && isUniformValueCompatible(type, parameter.value)
          ? { default: parameter.value }
          : presetCompatible && preset?.default !== undefined
            ? { default: preset.default }
            : {}),
        ...(presetCompatible && preset?.range
          ? { range: [...preset.range] as [number, number] }
          : {}),
        ...(binding !== null ? { binding } : {}),
        ...(parameter?.editor?.label || (presetCompatible && preset?.label)
          ? { editor: { label: parameter?.editor?.label ?? preset?.label ?? name } }
          : {}),
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
