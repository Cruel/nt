import { z } from 'zod';
import type { AuthoringProject, AuthoringRecordBase, ReferenceTarget } from './authoring-project';
import { parseAssetData } from './authoring-assets';

export const shaderRoleValues = [
  'engine-2d',
  'active-text',
  'rmlui-decorator',
  'rmlui-filter',
  'postprocess',
] as const;
export const shaderStageValues = ['vertex', 'fragment'] as const;
export const shaderUniformTypeValues = ['float', 'vec2', 'vec3', 'vec4', 'color', 'int', 'bool'] as const;
export const shaderInputBindingValues = [
  'engine.time',
  'engine.paint_dimensions',
  'engine.dpi_scale',
  'engine.pointer_position',
  'engine.pointer_valid',
  'rmlui.paint_dimensions',
  'rmlui.dpi_scale',
] as const;

export type ShaderRole = (typeof shaderRoleValues)[number];
export type ShaderStage = (typeof shaderStageValues)[number];
export type ShaderUniformType = (typeof shaderUniformTypeValues)[number];
export type ShaderInputBinding = (typeof shaderInputBindingValues)[number];

export const shaderRefSchema = z.object({
  $ref: z.object({ collection: z.literal('shaders'), id: z.string().min(1) }),
});
export const shaderSourceAssetRefSchema = z.object({
  $ref: z.object({ collection: z.literal('assets'), id: z.string().min(1) }),
});

export const shaderStageDataSchema = z.object({
  stage: z.enum(shaderStageValues),
  sourceMode: z.enum(['asset', 'inline']).default('inline'),
  sourceAsset: shaderSourceAssetRefSchema.nullable().optional(),
  sourceText: z.string().optional(),
  compiled: z.record(z.string(), z.string()).default({}),
});

export const shaderUniformDataSchema = z.object({
  name: z.string().min(1),
  type: z.enum(shaderUniformTypeValues),
  default: z.unknown().optional(),
  range: z.tuple([z.number(), z.number()]).optional(),
  label: z.string().optional(),
  binding: z.enum(shaderInputBindingValues).nullable().optional(),
});

export const shaderSamplerDataSchema = z.object({
  name: z.string().min(1),
  type: z.literal('texture2d').default('texture2d'),
});

export const shaderRoleBindingDataSchema = z.object({
  role: z.enum(shaderRoleValues),
  vertexShader: shaderRefSchema.nullable().optional(),
  fragmentShader: shaderRefSchema.nullable().optional(),
});

export const shaderDataSchema = z.object({
  kind: z.literal('shader').default('shader'),
  displayName: z.string().optional(),
  stages: z.array(shaderStageDataSchema).default([]),
  uniforms: z.array(shaderUniformDataSchema).default([]),
  samplers: z.array(shaderSamplerDataSchema).default([]),
  roles: z.array(z.enum(shaderRoleValues)).default(['engine-2d']),
  roleBindings: z.array(shaderRoleBindingDataSchema).default([]),
});

export type ShaderSourceAssetRef = z.infer<typeof shaderSourceAssetRefSchema>;
export type ShaderRef = z.infer<typeof shaderRefSchema>;
export type ShaderStageData = z.infer<typeof shaderStageDataSchema>;
export type ShaderUniformData = z.infer<typeof shaderUniformDataSchema>;
export type ShaderSamplerData = z.infer<typeof shaderSamplerDataSchema>;
export type ShaderRoleBindingData = z.infer<typeof shaderRoleBindingDataSchema>;
export type ShaderData = z.infer<typeof shaderDataSchema>;

export const defaultVertexShaderSource = `$input a_position, a_texcoord0, a_color0
$output v_texcoord0, v_color0

#include "bgfx_shader.sh"

void main()
{
    gl_Position = mul(u_modelViewProj, vec4(a_position.xy, 0.0, 1.0));
    v_texcoord0 = a_texcoord0;
    v_color0 = a_color0;
}
`;

export const defaultFragmentShaderSource = `$input v_texcoord0, v_color0

#include "bgfx_shader.sh"

uniform vec4 u_tint;

void main()
{
    gl_FragColor = v_color0 * u_tint;
}
`;

export interface ShaderSchemaDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
}

function diagnostic(path: string, message: string, severity: 'error' | 'warning' | 'info' = 'error'): ShaderSchemaDiagnostic {
  return { severity, path, message, category: 'authoring-shaders' };
}

export function parseShaderData(value: unknown): ShaderData | null {
  const parsed = shaderDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function defaultShaderData(label = 'Shader'): ShaderData {
  return shaderDataSchema.parse({
    kind: 'shader',
    displayName: label,
    stages: [
      { stage: 'vertex', sourceMode: 'inline', sourceText: defaultVertexShaderSource, compiled: {} },
      { stage: 'fragment', sourceMode: 'inline', sourceText: defaultFragmentShaderSource, compiled: {} },
    ],
    uniforms: [{ name: 'u_tint', type: 'color', default: [1, 1, 1, 1], label: 'Tint' }],
    samplers: [],
    roles: ['engine-2d'],
    roleBindings: [],
  });
}

export function isShaderRecord(record: AuthoringRecordBase | undefined | null): record is AuthoringRecordBase & { data: ShaderData } {
  return !!record && parseShaderData(record.data) !== null;
}

export function shaderDataFromRecord(record: AuthoringRecordBase | undefined | null): ShaderData | null {
  return parseShaderData(record?.data);
}

export function referenceTargetForShader(shaderId: string): ReferenceTarget {
  return { collection: 'shaders', id: shaderId };
}

export function shaderRef(shaderId: string): ShaderRef {
  return { $ref: referenceTargetForShader(shaderId) as { collection: 'shaders'; id: string } };
}

export function validateShaderData(project: AuthoringProject, shaderId: string, record: AuthoringRecordBase): ShaderSchemaDiagnostic[] {
  const diagnostics: ShaderSchemaDiagnostic[] = [];
  const parsed = shaderDataSchema.safeParse(record.data);
  const base = `/shaders/${shaderId}/data`;
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      diagnostics.push(diagnostic(`${base}/${issue.path.map(String).join('/')}`, issue.message));
    }
    return diagnostics;
  }

  const data = parsed.data;
  const stages = new Set<string>();
  data.stages.forEach((stage, index) => {
    const stagePath = `${base}/stages/${index}`;
    if (stages.has(stage.stage)) diagnostics.push(diagnostic(`${stagePath}/stage`, `Duplicate shader stage '${stage.stage}'.`));
    stages.add(stage.stage);
    if (stage.sourceMode === 'asset') {
      const assetId = stage.sourceAsset?.$ref.id;
      if (!assetId) {
        diagnostics.push(diagnostic(`${stagePath}/sourceAsset`, 'Stage source asset is required when sourceMode is asset.'));
      } else {
        const asset = project.assets[assetId];
        if (!asset) {
          diagnostics.push(diagnostic(`${stagePath}/sourceAsset/$ref`, `Missing shader source asset '${assetId}'.`));
        } else {
          const assetData = parseAssetData(asset.data);
          if (!assetData) diagnostics.push(diagnostic(`${stagePath}/sourceAsset/$ref`, `Asset '${assetId}' has invalid asset data.`));
          else if (assetData.kind !== 'shader-source') diagnostics.push(diagnostic(`${stagePath}/sourceAsset/$ref`, `Asset '${assetId}' is ${assetData.kind}, not shader-source.`, 'warning'));
        }
      }
    }
  });

  const uniforms = new Set<string>();
  data.uniforms.forEach((uniform, index) => {
    const path = `${base}/uniforms/${index}`;
    if (uniforms.has(uniform.name)) diagnostics.push(diagnostic(`${path}/name`, `Duplicate uniform '${uniform.name}'.`));
    uniforms.add(uniform.name);
    if (!isUniformValueCompatible(uniform.type, uniform.default)) {
      diagnostics.push(diagnostic(`${path}/default`, `Default value does not match ${uniform.type}.`));
    }
    if (uniform.range && uniform.range[0] > uniform.range[1]) {
      diagnostics.push(diagnostic(`${path}/range`, 'Range minimum must be less than or equal to maximum.'));
    }
  });

  const samplers = new Set<string>();
  data.samplers.forEach((sampler, index) => {
    if (samplers.has(sampler.name)) diagnostics.push(diagnostic(`${base}/samplers/${index}/name`, `Duplicate sampler '${sampler.name}'.`));
    samplers.add(sampler.name);
  });

  if (data.roles.length === 0) diagnostics.push(diagnostic(`${base}/roles`, 'Shader must support at least one role.'));
  return diagnostics;
}

export function isUniformValueCompatible(type: ShaderUniformType, value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (type === 'float') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'int') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'bool') return typeof value === 'boolean';
  if (type === 'vec2') return isNumberArray(value, 2);
  if (type === 'vec3') return isNumberArray(value, 3);
  if (type === 'vec4') return isNumberArray(value, 4);
  if (type === 'color') return isColorValue(value);
  return false;
}

function isNumberArray(value: unknown, length: number): boolean {
  return Array.isArray(value) && value.length === length && value.every((item) => typeof item === 'number' && Number.isFinite(item));
}

function isColorValue(value: unknown): boolean {
  if (isNumberArray(value, 4)) return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    ['r', 'g', 'b', 'a'].every((key) => typeof (value as Record<string, unknown>)[key] === 'number')
  );
}
