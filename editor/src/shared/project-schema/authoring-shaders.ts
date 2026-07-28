import { z } from 'zod';
import type { AuthoringProject, AuthoringRecordBase, ReferenceTarget } from './authoring-project';
import { parseAssetData } from './authoring-assets';
import { sha256PrefixedUtf8 } from '../sha256';

export const shaderRoleValues = [
  'engine-2d',
  'active-text',
  'rmlui-decorator',
  'rmlui-filter',
  'postprocess',
] as const;
export const shaderStageValues = ['vertex', 'fragment'] as const;
export const shaderUniformTypeValues = [
  'float',
  'vec2',
  'vec3',
  'vec4',
  'color',
  'int',
  'bool',
] as const;
export const shaderInputBindingValues = [
  'engine.time',
  'engine.paint_dimensions',
  'engine.reference_to_world_raster_scale',
  'engine.context_logical_to_ui_raster_scale',
  'engine.ui_media_query_resolution',
  'engine.viewport_pixel_dimensions',
  'engine.pointer_position',
  'engine.pointer_valid',
  'rmlui.paint_dimensions',
  'rmlui.context_logical_to_ui_raster_scale',
  'rmlui.media_query_resolution',
  'rmlui.viewport_pixel_dimensions',
] as const;

export type ShaderRole = (typeof shaderRoleValues)[number];
export type ShaderStage = (typeof shaderStageValues)[number];
export type ShaderUniformType = (typeof shaderUniformTypeValues)[number];
export type ShaderInputBinding = (typeof shaderInputBindingValues)[number];

export const shaderRefSchema = z
  .object({
    $ref: z.object({ collection: z.literal('shaders'), id: z.string().min(1) }).strict(),
  })
  .strict();
export const shaderSourceAssetRefSchema = z
  .object({
    $ref: z.object({ collection: z.literal('assets'), id: z.string().min(1) }).strict(),
  })
  .strict();

export const shaderCompiledOutputMetadataSchema = z
  .object({
    path: z.string().regex(/^project:\/shaders\/bgfx\/(?:[^/\\.][^/\\]*\/)*[^/\\.][^/\\]*$/),
    byteHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    byteSize: z.number().int().nonnegative().safe(),
    compileInputFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();
export const shaderCompiledOutputSchema = shaderCompiledOutputMetadataSchema;

export const shaderStageDataSchema = z
  .object({
    stage: z.enum(shaderStageValues),
    sourceMode: z.enum(['asset', 'inline']).default('inline'),
    sourceAsset: shaderSourceAssetRefSchema.nullable().optional(),
    sourceText: z.string().optional(),
    compiled: z.record(z.string(), shaderCompiledOutputSchema).default({}),
  })
  .strict();

export const shaderUniformValueSchema = z.union([
  z.null(),
  z.number().finite(),
  z.boolean(),
  z.tuple([z.number().finite(), z.number().finite()]),
  z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
  z
    .object({
      r: z.number().finite(),
      g: z.number().finite(),
      b: z.number().finite(),
      a: z.number().finite(),
    })
    .strict(),
]);

export const shaderUniformDataSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(shaderUniformTypeValues),
    default: shaderUniformValueSchema.optional(),
    range: z.tuple([z.number(), z.number()]).optional(),
    label: z.string().optional(),
    binding: z.enum(shaderInputBindingValues).nullable().optional(),
  })
  .strict();

export const shaderSamplerDataSchema = z
  .object({
    name: z.string().min(1),
    type: z.literal('texture2d').default('texture2d'),
  })
  .strict();

export const shaderRoleBindingDataSchema = z
  .object({
    role: z.enum(shaderRoleValues),
    vertexShader: shaderRefSchema.nullable().optional(),
    fragmentShader: shaderRefSchema.nullable().optional(),
  })
  .strict();

export const shaderDataSchema = z
  .object({
    kind: z.literal('shader').default('shader'),
    displayName: z.string().optional(),
    stages: z.array(shaderStageDataSchema).default([]),
    uniforms: z.array(shaderUniformDataSchema).default([]),
    samplers: z.array(shaderSamplerDataSchema).default([]),
    roles: z.array(z.enum(shaderRoleValues)).default(['engine-2d']),
    roleBindings: z.array(shaderRoleBindingDataSchema).default([]),
  })
  .strict()
  .superRefine((shader, context) => {
    const outputsByVariant = new Map<string, Map<string, number>>();
    shader.stages.forEach((stage, stageIndex) => {
      for (const [variant, output] of Object.entries(stage.compiled)) {
        const authoredPath = shaderCompiledOutputPath(output);
        const path = canonicalRuntimeShaderOutputPath(authoredPath);
        if (!path) {
          context.addIssue({
            code: 'custom',
            path: ['stages', stageIndex, 'compiled', variant],
            message: `Compiled output path '${authoredPath}' is not a canonical runtime Shader path.`,
          });
          continue;
        }
        const paths = outputsByVariant.get(variant) ?? new Map<string, number>();
        const previousStage = paths.get(path);
        if (previousStage !== undefined) {
          context.addIssue({
            code: 'custom',
            path: ['stages', stageIndex, 'compiled', variant],
            message: `Compiled output path duplicates stage ${previousStage} for variant '${variant}'.`,
          });
        } else {
          paths.set(path, stageIndex);
          outputsByVariant.set(variant, paths);
        }
      }
    });
  });

export type ShaderSourceAssetRef = z.infer<typeof shaderSourceAssetRefSchema>;
export type ShaderRef = z.infer<typeof shaderRefSchema>;
export type ShaderStageData = z.infer<typeof shaderStageDataSchema>;
export type ShaderCompiledOutput = z.infer<typeof shaderCompiledOutputSchema>;
export interface VerifiedShaderCompiledOutput {
  shader: string;
  stage: string;
  variant: string;
  metadata: ShaderCompiledOutput;
}
export type ShaderUniformValue = z.infer<typeof shaderUniformValueSchema>;
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

function diagnostic(
  path: string,
  message: string,
  severity: 'error' | 'warning' | 'info' = 'error',
): ShaderSchemaDiagnostic {
  return { severity, path, message, category: 'Shaders' };
}

export function parseShaderData(value: unknown): ShaderData | null {
  const parsed = shaderDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function shaderCompiledOutputPath(output: ShaderCompiledOutput): string {
  return output.path;
}

export function canonicalRuntimeShaderOutputPath(path: string): string | null {
  if (
    !path.startsWith('project:/shaders/bgfx/') ||
    path.includes('\\') ||
    path
      .slice('project:/'.length)
      .split('/')
      .some((part) => !part || part === '.' || part === '..')
  )
    return null;
  return path;
}

export function compiledShaderFetchProjectRelativePath(runtimePath: string): string | null {
  const logicalPath = canonicalRuntimeShaderOutputPath(runtimePath);
  return logicalPath ? `.noveltea/build/${logicalPath.slice('project:/'.length)}` : null;
}

function canonicalizeFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeFingerprintValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalizeFingerprintValue(child)]),
  );
}

export function shaderCompileInputFingerprint(
  project: AuthoringProject,
  shaderId: string,
  stageIndex: number,
  variant: string,
): `sha256:${string}` | null {
  const record = project.shaders[shaderId];
  const shader = parseShaderData(record?.data);
  const stage = shader?.stages[stageIndex];
  if (!record || !shader || !stage) return null;
  const sourceAsset =
    stage.sourceMode === 'asset' && stage.sourceAsset
      ? parseAssetData(project.assets[stage.sourceAsset.$ref.id]?.data)
      : null;
  const shaderInput = {
    id: shaderId,
    label: record.label,
    variant,
    stage: stage.stage,
    shader: {
      ...shader,
      stages: shader.stages.map(({ compiled: _compiled, ...value }) => value),
    },
    sourceAsset:
      stage.sourceMode === 'asset'
        ? {
            id: stage.sourceAsset?.$ref.id ?? null,
            path: sourceAsset?.source.path ?? null,
            contentHash: sourceAsset?.contentHash ?? null,
            byteSize: sourceAsset?.byteSize ?? null,
          }
        : null,
  };
  return sha256PrefixedUtf8(JSON.stringify(canonicalizeFingerprintValue(shaderInput)));
}

export function captureShaderCompileInputFingerprints(
  project: AuthoringProject,
  variants: readonly string[],
): Record<string, `sha256:${string}`> {
  const fingerprints: Record<string, `sha256:${string}`> = {};
  for (const shaderId of Object.keys(project.shaders)) {
    const shader = parseShaderData(project.shaders[shaderId]?.data);
    shader?.stages.forEach((stage, stageIndex) => {
      for (const variant of variants) {
        const fingerprint = shaderCompileInputFingerprint(project, shaderId, stageIndex, variant);
        if (fingerprint) fingerprints[`${shaderId}:${stage.stage}:${variant}`] = fingerprint;
      }
    });
  }
  return fingerprints;
}

export function shaderCompiledOutputIsFresh(
  project: AuthoringProject,
  shaderId: string,
  stageIndex: number,
  variant: string,
  output: ShaderCompiledOutput,
): boolean {
  return (
    output.compileInputFingerprint ===
    shaderCompileInputFingerprint(project, shaderId, stageIndex, variant)
  );
}

export function hasCompleteShaderCompiledOutputMetadata(
  output: ShaderCompiledOutput,
): output is ShaderCompiledOutput {
  return shaderCompiledOutputMetadataSchema.safeParse(output).success;
}

export function defaultShaderData(label = 'Shader'): ShaderData {
  return shaderDataSchema.parse({
    kind: 'shader',
    displayName: label,
    stages: [
      {
        stage: 'vertex',
        sourceMode: 'inline',
        sourceText: defaultVertexShaderSource,
        compiled: {},
      },
      {
        stage: 'fragment',
        sourceMode: 'inline',
        sourceText: defaultFragmentShaderSource,
        compiled: {},
      },
    ],
    uniforms: [{ name: 'u_tint', type: 'color', default: [1, 1, 1, 1], label: 'Tint' }],
    samplers: [],
    roles: ['engine-2d'],
    roleBindings: [],
  });
}

export function isShaderRecord(
  record: AuthoringRecordBase | undefined | null,
): record is AuthoringRecordBase & { data: ShaderData } {
  return !!record && parseShaderData(record.data) !== null;
}

export function shaderDataFromRecord(
  record: AuthoringRecordBase | undefined | null,
): ShaderData | null {
  return parseShaderData(record?.data);
}

export function referenceTargetForShader(shaderId: string): ReferenceTarget {
  return { collection: 'shaders', id: shaderId };
}

export function shaderRef(shaderId: string): ShaderRef {
  return { $ref: referenceTargetForShader(shaderId) as { collection: 'shaders'; id: string } };
}

export function validateShaderData(
  project: AuthoringProject,
  shaderId: string,
  record: AuthoringRecordBase,
): ShaderSchemaDiagnostic[] {
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
    if (stages.has(stage.stage))
      diagnostics.push(
        diagnostic(`${stagePath}/stage`, `Duplicate shader stage '${stage.stage}'.`),
      );
    stages.add(stage.stage);
    if (stage.sourceMode === 'asset') {
      const assetId = stage.sourceAsset?.$ref.id;
      if (!assetId) {
        diagnostics.push(
          diagnostic(
            `${stagePath}/sourceAsset`,
            'Stage source asset is required when sourceMode is asset.',
          ),
        );
      } else {
        const asset = project.assets[assetId];
        if (!asset) {
          diagnostics.push(
            diagnostic(
              `${stagePath}/sourceAsset/$ref`,
              `Missing shader source asset '${assetId}'.`,
            ),
          );
        } else {
          const assetData = parseAssetData(asset.data);
          if (!assetData)
            diagnostics.push(
              diagnostic(
                `${stagePath}/sourceAsset/$ref`,
                `Asset '${assetId}' has invalid asset data.`,
              ),
            );
          else if (assetData.kind !== 'shader-source')
            diagnostics.push(
              diagnostic(
                `${stagePath}/sourceAsset/$ref`,
                `Asset '${assetId}' is ${assetData.kind}, not shader-source.`,
                'warning',
              ),
            );
        }
      }
    }
  });

  const uniforms = new Set<string>();
  data.uniforms.forEach((uniform, index) => {
    const path = `${base}/uniforms/${index}`;
    if (uniforms.has(uniform.name))
      diagnostics.push(diagnostic(`${path}/name`, `Duplicate uniform '${uniform.name}'.`));
    uniforms.add(uniform.name);
    if (!isUniformValueCompatible(uniform.type, uniform.default)) {
      diagnostics.push(
        diagnostic(`${path}/default`, `Default value does not match ${uniform.type}.`),
      );
    }
    if (uniform.range && uniform.range[0] > uniform.range[1]) {
      diagnostics.push(
        diagnostic(`${path}/range`, 'Range minimum must be less than or equal to maximum.'),
      );
    }
  });

  const samplers = new Set<string>();
  data.samplers.forEach((sampler, index) => {
    if (samplers.has(sampler.name))
      diagnostics.push(
        diagnostic(`${base}/samplers/${index}/name`, `Duplicate sampler '${sampler.name}'.`),
      );
    samplers.add(sampler.name);
  });

  if (data.roles.length === 0)
    diagnostics.push(diagnostic(`${base}/roles`, 'Shader must support at least one role.'));
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
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item))
  );
}

function isColorValue(value: unknown): boolean {
  if (isNumberArray(value, 4)) return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    ['r', 'g', 'b', 'a'].every((key) => typeof (value as Record<string, unknown>)[key] === 'number')
  );
}
