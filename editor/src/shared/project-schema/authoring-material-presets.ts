import { z } from 'zod';
import {
  shaderInputBindingValues,
  shaderRoleValues,
  shaderSamplerBindingValues,
  shaderUniformTypeValues,
  type ShaderInputBinding,
  type ShaderRole,
  type ShaderSamplerBinding,
  type ShaderUniformType,
  type ShaderUniformValue,
} from './authoring-shaders';

export const materialPresetIdValues = [
  'engine-2d',
  'active-text',
  'rmlui-decorator',
  'postprocess-tint',
  'hotspot-overlay-alpha',
  'hotspot-overlay-custom',
] as const;

export const materialPresetIdSchema = z.enum(materialPresetIdValues);
export type MaterialPresetId = (typeof materialPresetIdValues)[number];

export interface MaterialPresetUniform {
  type: ShaderUniformType;
  default?: ShaderUniformValue;
  binding?: ShaderInputBinding;
  label?: string;
  range?: readonly [number, number];
}

export interface MaterialPresetSampler {
  binding?: ShaderSamplerBinding;
}

export interface MaterialPresetDefinition {
  id: MaterialPresetId;
  label: string;
  role: ShaderRole;
  interfaceContract: string;
  vertexSource: string;
  fragmentSource: string;
  varyingDefinition: string;
  programName: string;
  uniforms: Readonly<Record<string, MaterialPresetUniform>>;
  samplers: Readonly<Record<string, MaterialPresetSampler>>;
  blend: 'premultiplied-alpha';
  postprocessScope: 'world' | 'full-game-viewport';
  preview: {
    geometry: 'quad' | 'rounded-rect' | 'sprite' | 'glyphs';
    background: 'transparent' | 'checker' | 'dark' | 'light';
  };
}

function preset(
  value: Omit<MaterialPresetDefinition, 'interfaceContract' | 'varyingDefinition' | 'blend'>,
): MaterialPresetDefinition {
  return {
    ...value,
    interfaceContract: `noveltea.material-preset:${value.id}:1`,
    varyingDefinition: 'engine:/varying.def.sc',
    blend: 'premultiplied-alpha',
  };
}

const engineTime: MaterialPresetUniform = {
  type: 'float',
  binding: 'engine.time',
  label: 'Time',
};

export const materialPresets: Readonly<Record<MaterialPresetId, MaterialPresetDefinition>> = {
  'engine-2d': preset({
    id: 'engine-2d',
    label: 'Engine 2D',
    role: 'engine-2d',
    vertexSource: 'engine:/vs_quad.sc',
    fragmentSource: 'engine:/fs_quad.sc',
    programName: 'quad',
    uniforms: { u_useTexture: { type: 'float', default: 1, label: 'Use Texture' } },
    samplers: { s_texColor: {} },
    postprocessScope: 'world',
    preview: { geometry: 'quad', background: 'checker' },
  }),
  'active-text': preset({
    id: 'active-text',
    label: 'ActiveText',
    role: 'active-text',
    vertexSource: 'engine:/vs_text.sc',
    fragmentSource: 'engine:/fs_text.sc',
    programName: 'text',
    uniforms: {},
    samplers: { s_textAtlas: {} },
    postprocessScope: 'world',
    preview: { geometry: 'glyphs', background: 'dark' },
  }),
  'rmlui-decorator': preset({
    id: 'rmlui-decorator',
    label: 'RmlUi Decorator',
    role: 'rmlui-decorator',
    vertexSource: 'engine:/vs_rmlui.sc',
    fragmentSource: 'engine:/fs_rmlui.sc',
    programName: 'rmlui',
    uniforms: {},
    samplers: { s_texColor: {} },
    postprocessScope: 'world',
    preview: { geometry: 'rounded-rect', background: 'checker' },
  }),
  'postprocess-tint': preset({
    id: 'postprocess-tint',
    label: 'Postprocess Tint',
    role: 'postprocess',
    vertexSource: 'engine:/vs_postprocess_tint.sc',
    fragmentSource: 'engine:/fs_postprocess_tint.sc',
    programName: 'postprocess_tint',
    uniforms: { u_tint: { type: 'color', default: [1, 1, 1, 1], label: 'Tint' } },
    samplers: { s_texColor: {} },
    postprocessScope: 'world',
    preview: { geometry: 'quad', background: 'checker' },
  }),
  'hotspot-overlay-alpha': preset({
    id: 'hotspot-overlay-alpha',
    label: 'Hotspot Overlay (Alpha)',
    role: 'hotspot-overlay',
    vertexSource: 'engine:/vs_quad.sc',
    fragmentSource: 'engine:/fs_hotspot_alpha.sc',
    programName: 'hotspot_alpha',
    uniforms: {
      u_time: engineTime,
      u_hotspotBounds: { type: 'vec4', binding: 'engine.hotspot_bounds' },
      u_hotspotHovered: { type: 'bool', binding: 'engine.hotspot_hovered' },
      u_hotspotPressed: { type: 'bool', binding: 'engine.hotspot_pressed' },
      u_hotspotImageDimensions: { type: 'vec2', binding: 'engine.hotspot_image_dimensions' },
      u_hotspotMaskDimensions: { type: 'vec2', binding: 'engine.hotspot_mask_dimensions' },
    },
    samplers: { s_hotspotImage: { binding: 'engine.hotspot_image' } },
    postprocessScope: 'world',
    preview: { geometry: 'sprite', background: 'checker' },
  }),
  'hotspot-overlay-custom': preset({
    id: 'hotspot-overlay-custom',
    label: 'Hotspot Overlay (Custom Mask)',
    role: 'hotspot-overlay',
    vertexSource: 'engine:/vs_quad.sc',
    fragmentSource: 'engine:/fs_hotspot_custom.sc',
    programName: 'hotspot_custom',
    uniforms: {
      u_time: engineTime,
      u_hotspotBounds: { type: 'vec4', binding: 'engine.hotspot_bounds' },
      u_hotspotHovered: { type: 'bool', binding: 'engine.hotspot_hovered' },
      u_hotspotPressed: { type: 'bool', binding: 'engine.hotspot_pressed' },
      u_hotspotImageDimensions: { type: 'vec2', binding: 'engine.hotspot_image_dimensions' },
      u_hotspotMaskDimensions: { type: 'vec2', binding: 'engine.hotspot_mask_dimensions' },
    },
    samplers: {
      s_hotspotImage: { binding: 'engine.hotspot_image' },
      s_hotspotMask: { binding: 'engine.hotspot_mask' },
    },
    postprocessScope: 'world',
    preview: { geometry: 'sprite', background: 'checker' },
  }),
};

export function materialPreset(id: string): MaterialPresetDefinition | null {
  const parsed = materialPresetIdSchema.safeParse(id);
  return parsed.success ? materialPresets[parsed.data] : null;
}

export function isMaterialPresetRole(value: unknown): value is ShaderRole {
  return z.enum(shaderRoleValues).safeParse(value).success;
}
export function isMaterialPresetUniformType(value: unknown): value is ShaderUniformType {
  return z.enum(shaderUniformTypeValues).safeParse(value).success;
}
export function isMaterialPresetInputBinding(value: unknown): value is ShaderInputBinding {
  return z.enum(shaderInputBindingValues).safeParse(value).success;
}
export function isMaterialPresetSamplerBinding(value: unknown): value is ShaderSamplerBinding {
  return z.enum(shaderSamplerBindingValues).safeParse(value).success;
}
