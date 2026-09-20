import { z } from 'zod';

export const shaderRoleValues = [
  'engine-2d',
  'active-text',
  'rmlui-decorator',
  'rmlui-filter',
  'postprocess',
  'hotspot-overlay',
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
  'engine.hotspot_bounds',
  'engine.hotspot_hovered',
  'engine.hotspot_pressed',
  'engine.hotspot_image_dimensions',
  'engine.hotspot_mask_dimensions',
] as const;
export const shaderSamplerBindingValues = ['engine.hotspot_image', 'engine.hotspot_mask'] as const;

export type ShaderRole = (typeof shaderRoleValues)[number];
export type ShaderStage = (typeof shaderStageValues)[number];
export type ShaderUniformType = (typeof shaderUniformTypeValues)[number];
export type ShaderInputBinding = (typeof shaderInputBindingValues)[number];
export type ShaderSamplerBinding = (typeof shaderSamplerBindingValues)[number];

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

/** Editor/runtime semantics decorating a compiler-reflected uniform. */
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

/** Editor/runtime semantics decorating a compiler-reflected sampled image. */
export const shaderSamplerDataSchema = z
  .object({
    name: z.string().min(1),
    type: z.literal('texture2d').default('texture2d'),
    binding: z.enum(shaderSamplerBindingValues).nullable().optional(),
  })
  .strict();

export type ShaderUniformValue = z.infer<typeof shaderUniformValueSchema>;
export type ShaderUniformData = z.infer<typeof shaderUniformDataSchema>;
export type ShaderSamplerData = z.infer<typeof shaderSamplerDataSchema>;

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

export function canonicalRuntimeShaderOutputPath(path: string): string | null {
  if (
    !path.startsWith('project:/shaders/derived/') ||
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

export function isUniformValueCompatible(type: ShaderUniformType, value: unknown): boolean {
  if (value === null || value === undefined) return true;
  switch (type) {
    case 'float':
      return typeof value === 'number' && Number.isFinite(value);
    case 'int':
      return typeof value === 'number' && Number.isInteger(value);
    case 'bool':
      return typeof value === 'boolean';
    case 'vec2':
      return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
    case 'vec3':
      return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
    case 'vec4':
      return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite);
    case 'color':
      return (
        (Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)) ||
        (!!value &&
          typeof value === 'object' &&
          ['r', 'g', 'b', 'a'].every(
            (key) =>
              typeof (value as Record<string, unknown>)[key] === 'number' &&
              Number.isFinite((value as Record<string, number>)[key]),
          ))
      );
  }
}
