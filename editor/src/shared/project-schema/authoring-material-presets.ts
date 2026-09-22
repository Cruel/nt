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
import {
  materialContractPresetIds,
  materialContractRegistry,
} from './material-contract-registry.generated';

export const materialPresetIdValues = materialContractPresetIds;

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
  interfaceFingerprint: string;
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

function projectedPreset(
  preset: (typeof materialContractRegistry.presets)[number],
): MaterialPresetDefinition {
  const compatibility = preset.compatibilityProjection;
  return {
    id: preset.id as MaterialPresetId,
    label: preset.label,
    role: preset.role as ShaderRole,
    interfaceContract: preset.contractIdentity,
    interfaceFingerprint: preset.contractFingerprint,
    vertexSource: preset.shader.vertexSource,
    fragmentSource: preset.shader.fragmentSource,
    varyingDefinition: preset.shader.varyingDefinition,
    programName: preset.shader.programName,
    uniforms: compatibility.uniforms as unknown as Readonly<Record<string, MaterialPresetUniform>>,
    samplers: compatibility.samplers as unknown as Readonly<Record<string, MaterialPresetSampler>>,
    blend: compatibility.blend as 'premultiplied-alpha',
    postprocessScope: compatibility.postprocessScope as 'world' | 'full-game-viewport',
    preview: {
      geometry: preset.preview.geometry as MaterialPresetDefinition['preview']['geometry'],
      background: preset.preview.background as MaterialPresetDefinition['preview']['background'],
    },
  };
}

export const materialPresets = Object.fromEntries(
  materialContractRegistry.presets.map((preset) => [preset.id, projectedPreset(preset)]),
) as Readonly<Record<MaterialPresetId, MaterialPresetDefinition>>;

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
