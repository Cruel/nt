import { z } from 'zod';
import { parseAssetData } from './authoring-assets';
import { entityIdSchema } from './authoring-common';
import type { AuthoringProject, AuthoringRecordBase, ReferenceTarget } from './authoring-project';
import {
  materialPreset,
  materialPresetIdSchema,
  type MaterialPresetDefinition,
  type MaterialPresetId,
  type MaterialPresetUniform,
} from './authoring-material-presets';
import { materialContractRegistry } from './material-contract-registry.generated';
import {
  isUniformValueCompatible,
  shaderInputBindingValues,
  shaderSamplerBindingValues,
  shaderUniformTypeValues,
  shaderUniformValueSchema,
  type ShaderInputBinding,
  type ShaderRole,
  type ShaderSamplerBinding,
  type ShaderUniformType,
  type ShaderUniformValue,
} from './authoring-shaders';

export const materialTextureAddressValues = ['clamp', 'repeat'] as const;
export const materialTextureFilterValues = ['inherit', 'nearest', 'linear'] as const;
export const materialPreviewGeometryValues = ['quad', 'rounded-rect', 'sprite', 'glyphs'] as const;
export const materialPreviewBackgroundValues = ['transparent', 'checker', 'dark', 'light'] as const;
export type MaterialTextureAddress = (typeof materialTextureAddressValues)[number];
export type MaterialTextureFilter = (typeof materialTextureFilterValues)[number];

export const assetTextureRefSchema = z
  .object({ $ref: z.object({ collection: z.literal('assets'), id: z.string().min(1) }).strict() })
  .strict();
export const materialTextureSourceSchema = z.union([
  assetTextureRefSchema,
  z.object({ alias: z.string().min(1) }).strict(),
  z.object({ uri: z.string().min(1) }).strict(),
]);
const safeProjectShaderPath = z
  .string()
  .regex(/^shaders\/(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?!.*\/\/)[^/].*$/);
const safeEngineShaderPath = z.string().regex(/^engine:\/(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\).+$/);
export const materialShaderSourceSchema = z.union([
  z.object({ kind: z.literal('project'), path: safeProjectShaderPath }).strict(),
  z.object({ kind: z.literal('engine'), path: safeEngineShaderPath }).strict(),
]);
export const materialShaderOverrideSchema = z
  .object({
    vertex: materialShaderSourceSchema.optional(),
    fragment: materialShaderSourceSchema.optional(),
    varying: materialShaderSourceSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.vertex !== undefined || value.fragment !== undefined || value.varying !== undefined,
    { message: 'Custom shader override must select at least one source.' },
  );
export const materialBaseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('preset'), preset: materialPresetIdSchema }).strict(),
  z
    .object({
      kind: z.literal('material'),
      material: z
        .object({
          $ref: z.object({ collection: z.literal('materials'), id: entityIdSchema }).strict(),
        })
        .strict(),
    })
    .strict(),
]);
export const materialParameterOverrideSchema = z
  .object({
    type: z.enum(shaderUniformTypeValues).optional(),
    value: shaderUniformValueSchema.optional(),
    binding: z.enum(shaderInputBindingValues).nullable().optional(),
    editor: z
      .object({
        label: z.string().optional(),
        range: z.tuple([z.number().finite(), z.number().finite()]).optional(),
        control: z.enum(['number', 'slider', 'color', 'toggle', 'vector']).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.type !== undefined ||
      value.value !== undefined ||
      value.binding !== undefined ||
      value.editor !== undefined,
    { message: 'Material parameter override cannot be empty.' },
  );
export const materialTextureDataSchema = z
  .object({
    source: materialTextureSourceSchema.optional(),
    address: z.enum(materialTextureAddressValues).optional(),
    filter: z.enum(materialTextureFilterValues).optional(),
    binding: z.enum(shaderSamplerBindingValues).nullable().optional(),
    editor: z.object({ label: z.string().optional() }).strict().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.source !== undefined ||
      value.address !== undefined ||
      value.filter !== undefined ||
      value.binding !== undefined ||
      value.editor !== undefined,
    { message: 'Material texture override cannot be empty.' },
  );
export const materialDataSchema = z
  .object({
    kind: z.literal('material').default('material'),
    base: materialBaseSchema,
    displayName: z.string().optional(),
    shader: materialShaderOverrideSchema.optional(),
    parameters: z.record(z.string().min(1), materialParameterOverrideSchema).default({}),
    textures: z.record(z.string().min(1), materialTextureDataSchema).default({}),
    preview: z
      .object({
        geometry: z.enum(materialPreviewGeometryValues).optional(),
        background: z.enum(materialPreviewBackgroundValues).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type AssetTextureRef = z.infer<typeof assetTextureRefSchema>;
export type MaterialTextureSource = z.infer<typeof materialTextureSourceSchema>;
export type MaterialShaderSource = z.infer<typeof materialShaderSourceSchema>;
export type MaterialShaderOverride = z.infer<typeof materialShaderOverrideSchema>;
export type MaterialBase = z.infer<typeof materialBaseSchema>;
export type MaterialParameterOverride = z.infer<typeof materialParameterOverrideSchema>;
export type MaterialTextureData = z.infer<typeof materialTextureDataSchema>;
export type MaterialData = z.infer<typeof materialDataSchema>;
export interface EffectiveMaterialParameter {
  type?: ShaderUniformType;
  value?: ShaderUniformValue;
  binding?: ShaderInputBinding | null;
  editor?: MaterialParameterOverride['editor'];
}
export interface EffectiveMaterialTexture {
  source?: MaterialTextureSource;
  address: MaterialTextureAddress;
  filter: MaterialTextureFilter;
  binding?: ShaderSamplerBinding | null;
  editor?: MaterialTextureData['editor'];
}
export type MaterialProvenance =
  | { kind: 'preset'; id: MaterialPresetId }
  | { kind: 'material'; id: string };
export interface ResolvedMaterialData {
  preset: MaterialPresetDefinition;
  role: ShaderRole;
  vertexSource: string;
  fragmentSource: string;
  varyingDefinition: string;
  interfaceContract: string;
  interfaceFingerprint: string;
  parameters: Record<string, EffectiveMaterialParameter>;
  textures: Record<string, EffectiveMaterialTexture>;
  preview: {
    geometry: (typeof materialPreviewGeometryValues)[number];
    background: (typeof materialPreviewBackgroundValues)[number];
  };
  provenance: Record<string, MaterialProvenance>;
}
export interface MaterialSchemaDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
}
export interface MaterialAuthoredOverrides {
  parameters: Record<string, MaterialParameterOverride>;
  textures: Record<string, MaterialTextureData>;
}
function diagnostic(
  path: string,
  message: string,
  severity: 'error' | 'warning' | 'info' = 'error',
): MaterialSchemaDiagnostic {
  return { severity, path, message, category: 'Materials' };
}
export function parseMaterialData(value: unknown): MaterialData | null {
  const parsed = materialDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export function defaultMaterialData(
  label = 'Material',
  preset: MaterialPresetId = 'engine-2d',
): MaterialData {
  return materialDataSchema.parse({
    kind: 'material',
    base: { kind: 'preset', preset },
    displayName: label,
    parameters: {},
    textures: {},
  });
}

export function materialDataWithBase(data: MaterialData, base: MaterialBase): MaterialData {
  return materialDataSchema.parse({ ...data, base });
}
export function isMaterialRecord(
  record: AuthoringRecordBase | undefined | null,
): record is AuthoringRecordBase & { data: MaterialData } {
  return !!record && parseMaterialData(record.data) !== null;
}
export function materialDataFromRecord(
  record: AuthoringRecordBase | undefined | null,
): MaterialData | null {
  return parseMaterialData(record?.data);
}
export function referenceTargetForMaterial(materialId: string): ReferenceTarget {
  return { collection: 'materials', id: materialId };
}
function projectSourceIdentity(source: MaterialShaderSource): string {
  return source.kind === 'engine' ? source.path : `project:/${source.path}`;
}
function presetStandardUniform(
  preset: MaterialPresetDefinition,
  name: string,
): MaterialPresetUniform | undefined {
  const binding = preset.standardUniforms[name];
  if (!binding) return undefined;
  const role = materialContractRegistry.roles.find((candidate) => candidate.id === preset.role);
  const semantic = role?.standardSemanticAvailability.find(
    (candidate) => candidate.semantic === binding,
  );
  if (!semantic) return undefined;
  return { type: semantic.logicalType as ShaderUniformType, binding };
}

function presetUniform(
  preset: MaterialPresetDefinition,
  name: string,
): MaterialPresetUniform | undefined {
  return preset.uniforms[name] ?? presetStandardUniform(preset, name);
}

function defaultSamplerPolicy(
  role: ShaderRole,
  name: string,
): Pick<EffectiveMaterialTexture, 'address' | 'filter'> {
  const sampler = materialContractRegistry.roles
    .find((candidate) => candidate.id === role)
    ?.reservedInterface.samplers.find((candidate) => candidate.name === name);
  const address = sampler?.addressPolicy.includes('clamp')
    ? 'clamp'
    : ((sampler?.addressPolicy[0] ?? 'clamp') as MaterialTextureAddress);
  const filter = sampler?.filterPolicy.includes('inherit')
    ? 'inherit'
    : ((sampler?.filterPolicy[0] ?? 'linear') as MaterialTextureFilter);
  return { address, filter };
}

function resolvedFromPreset(preset: MaterialPresetDefinition): ResolvedMaterialData {
  const provenance: Record<string, MaterialProvenance> = {};
  const parameters: Record<string, EffectiveMaterialParameter> = {};
  for (const [name, value] of Object.entries(preset.uniforms)) {
    provenance[`parameters.${name}`] = { kind: 'preset', id: preset.id };
    parameters[name] = {
      type: value.type,
      ...(value.default !== undefined ? { value: value.default } : {}),
      ...(value.binding !== undefined ? { binding: value.binding } : {}),
      ...(value.label || value.range
        ? {
            editor: {
              ...(value.label ? { label: value.label } : {}),
              ...(value.range ? { range: [...value.range] as [number, number] } : {}),
            },
          }
        : {}),
    };
  }
  for (const name of Object.keys(preset.standardUniforms)) {
    if (parameters[name]) continue;
    const value = presetStandardUniform(preset, name);
    if (!value) continue;
    provenance[`parameters.${name}`] = { kind: 'preset', id: preset.id };
    parameters[name] = { type: value.type, binding: value.binding };
  }
  const textures: Record<string, EffectiveMaterialTexture> = {};
  const roleContract = materialContractRegistry.roles.find((role) => role.id === preset.role);
  for (const [name, capability] of Object.entries(preset.samplerCapabilities)) {
    if (capability === 'disabled') continue;
    const sampler = roleContract?.reservedInterface.samplers.find(
      (candidate) => candidate.name === name,
    );
    const binding = sampler?.semantic as ShaderSamplerBinding | undefined;
    provenance[`textures.${name}`] = { kind: 'preset', id: preset.id };
    textures[name] = {
      ...defaultSamplerPolicy(preset.role, name),
      ...(binding && shaderSamplerBindingValues.includes(binding) ? { binding } : {}),
    };
  }
  for (const key of [
    'role',
    'shader.vertex',
    'shader.fragment',
    'shader.varying',
    'preview.geometry',
    'preview.background',
  ])
    provenance[key] = { kind: 'preset', id: preset.id };
  return {
    preset,
    role: preset.role,
    vertexSource: preset.vertexSource,
    fragmentSource: preset.fragmentSource,
    varyingDefinition: preset.varyingDefinition,
    interfaceContract: preset.interfaceContract,
    interfaceFingerprint: preset.interfaceFingerprint,
    parameters,
    textures,
    preview: { ...preset.preview },
    provenance,
  };
}
function applyMaterialOverrides(
  base: ResolvedMaterialData,
  data: MaterialData,
  materialId: string,
): ResolvedMaterialData {
  const provenance = { ...base.provenance };
  const source: MaterialProvenance = { kind: 'material', id: materialId };
  const parameters = { ...base.parameters };
  const textures = { ...base.textures };
  for (const [name, override] of Object.entries(data.parameters)) {
    parameters[name] = { ...parameters[name], ...override };
    provenance[`parameters.${name}`] = source;
  }
  for (const [name, override] of Object.entries(data.textures)) {
    const inherited = textures[name] ?? { address: 'clamp' as const, filter: 'linear' as const };
    textures[name] = { ...inherited, ...override };
    provenance[`textures.${name}`] = source;
  }
  let vertexSource = base.vertexSource;
  let fragmentSource = base.fragmentSource;
  let varyingDefinition = base.varyingDefinition;
  if (data.shader?.vertex) {
    vertexSource = projectSourceIdentity(data.shader.vertex);
    provenance['shader.vertex'] = source;
  }
  if (data.shader?.fragment) {
    fragmentSource = projectSourceIdentity(data.shader.fragment);
    provenance['shader.fragment'] = source;
  }
  if (data.shader?.varying) {
    varyingDefinition = projectSourceIdentity(data.shader.varying);
    provenance['shader.varying'] = source;
  }
  const preview = {
    geometry: data.preview?.geometry ?? base.preview.geometry,
    background: data.preview?.background ?? base.preview.background,
  };
  if (data.preview?.geometry) provenance['preview.geometry'] = source;
  if (data.preview?.background) provenance['preview.background'] = source;
  return {
    ...base,
    vertexSource,
    fragmentSource,
    varyingDefinition,
    parameters,
    textures,
    preview,
    provenance,
  };
}
export function resolvedMaterialUsesCustomShader(resolved: ResolvedMaterialData): boolean {
  return (
    resolved.vertexSource !== resolved.preset.vertexSource ||
    resolved.fragmentSource !== resolved.preset.fragmentSource ||
    resolved.varyingDefinition !== resolved.preset.varyingDefinition
  );
}

export function resolveMaterialData(
  project: AuthoringProject,
  materialId: string,
): { data: ResolvedMaterialData | null; diagnostics: MaterialSchemaDiagnostic[] } {
  const diagnostics: MaterialSchemaDiagnostic[] = [];
  const seen = new Set<string>();
  const chain: Array<{ id: string; data: MaterialData }> = [];
  let currentId = materialId;
  let rootPreset: MaterialPresetDefinition | null = null;
  while (currentId) {
    if (seen.has(currentId)) {
      diagnostics.push(
        diagnostic(
          `/materials/${materialId}/data/base`,
          'Material inheritance chain contains a cycle.',
        ),
      );
      return { data: null, diagnostics };
    }
    seen.add(currentId);
    const record = project.materials[currentId];
    const data = parseMaterialData(record?.data);
    if (!record || !data) {
      diagnostics.push(
        diagnostic(
          `/materials/${currentId}/data`,
          `Material '${currentId}' has invalid material data.`,
        ),
      );
      return { data: null, diagnostics };
    }
    chain.push({ id: currentId, data });
    if (data.base.kind === 'preset') {
      rootPreset = materialPreset(data.base.preset);
      if (!rootPreset)
        diagnostics.push(
          diagnostic(
            `/materials/${currentId}/data/base/preset`,
            `Unknown Material Preset '${data.base.preset}'.`,
          ),
        );
      break;
    }
    currentId = data.base.material.$ref.id;
  }
  if (!rootPreset) {
    diagnostics.push(
      diagnostic(
        `/materials/${materialId}/data/base`,
        'Material inheritance must terminate at a built-in preset.',
      ),
    );
    return { data: null, diagnostics };
  }
  let resolved = resolvedFromPreset(rootPreset);
  for (const entry of chain.reverse())
    resolved = applyMaterialOverrides(resolved, entry.data, entry.id);
  return { data: resolved, diagnostics };
}
export function resolveMaterialAuthoredOverrides(
  project: AuthoringProject,
  materialId: string,
): MaterialAuthoredOverrides | null {
  const chain: MaterialData[] = [];
  const seen = new Set<string>();
  let currentId = materialId;
  while (currentId) {
    if (seen.has(currentId)) return null;
    seen.add(currentId);
    const data = parseMaterialData(project.materials[currentId]?.data);
    if (!data) return null;
    chain.push(data);
    if (data.base.kind === 'preset') break;
    currentId = data.base.material.$ref.id;
  }
  const parameters: Record<string, MaterialParameterOverride> = {};
  const textures: Record<string, MaterialTextureData> = {};
  for (const data of chain.reverse()) {
    for (const [name, override] of Object.entries(data.parameters))
      parameters[name] = { ...parameters[name], ...override };
    for (const [name, override] of Object.entries(data.textures))
      textures[name] = { ...textures[name], ...override };
  }
  return { parameters, textures };
}

export function validateMaterialData(
  project: AuthoringProject,
  materialId: string,
  record: AuthoringRecordBase,
): MaterialSchemaDiagnostic[] {
  const diagnostics: MaterialSchemaDiagnostic[] = [];
  const parsed = materialDataSchema.safeParse(record.data);
  const base = `/materials/${materialId}/data`;
  if (!parsed.success) {
    for (const issue of parsed.error.issues)
      diagnostics.push(diagnostic(`${base}/${issue.path.map(String).join('/')}`, issue.message));
    return diagnostics;
  }
  const data = parsed.data;
  if (data.base.kind === 'material') {
    const parent = data.base.material.$ref.id;
    if (parent === materialId)
      diagnostics.push(
        diagnostic(`${base}/base/material/$ref`, 'Material cannot inherit from itself.'),
      );
    else if (!project.materials[parent])
      diagnostics.push(
        diagnostic(`${base}/base/material/$ref`, `Missing base material '${parent}'.`),
      );
  }
  const resolution = resolveMaterialData(project, materialId);
  diagnostics.push(...resolution.diagnostics);
  const resolved = resolution.data;
  if (!resolved) return diagnostics;
  const preset = resolved.preset;
  if (data.base.kind === 'material') {
    const parent = resolveMaterialData(project, data.base.material.$ref.id).data;
    if (parent) {
      for (const [name, parameter] of Object.entries(data.parameters)) {
        const inherited = parent.parameters[name];
        if (
          parameter.type !== undefined &&
          inherited?.type !== undefined &&
          parameter.type !== inherited.type
        )
          diagnostics.push(
            diagnostic(
              `${base}/parameters/${name}/type`,
              `Material parameter '${name}' cannot reinterpret inherited logical type '${inherited.type}' as '${parameter.type}'.`,
            ),
          );
        if (
          parameter.binding !== undefined &&
          inherited?.binding !== undefined &&
          parameter.binding !== inherited.binding
        )
          diagnostics.push(
            diagnostic(
              `${base}/parameters/${name}/binding`,
              `Material parameter '${name}' cannot reinterpret its inherited renderer binding.`,
            ),
          );
      }
    }
  }
  if (resolvedMaterialUsesCustomShader(resolved)) {
    for (const [name, parameter] of Object.entries(data.parameters)) {
      const logicalType = resolved.parameters[name]?.type;
      if (
        parameter.value !== undefined &&
        logicalType !== undefined &&
        !isUniformValueCompatible(logicalType, parameter.value)
      )
        diagnostics.push(
          diagnostic(
            `${base}/parameters/${name}/value`,
            `Material parameter value does not match logical type ${logicalType}.`,
          ),
        );
      if (parameter.binding != null && parameter.value !== undefined)
        diagnostics.push(
          diagnostic(
            `${base}/parameters/${name}/value`,
            `Renderer-bound parameter '${name}' cannot have an authored value.`,
          ),
        );
    }
    for (const [name, texture] of Object.entries(data.textures)) {
      const contractSampler = materialContractRegistry.roles
        .find((role) => role.id === resolved.role)
        ?.reservedInterface.samplers.find((sampler) => sampler.name === name);
      if (
        texture.source !== undefined &&
        (texture.binding != null || contractSampler?.sourceOwnership === 'renderer')
      )
        diagnostics.push(
          diagnostic(
            `${base}/textures/${name}/source`,
            `Renderer-bound texture '${name}' cannot have an authored source.`,
          ),
        );
      if (
        texture.address !== undefined &&
        contractSampler &&
        !contractSampler.addressPolicy.includes(texture.address)
      )
        diagnostics.push(
          diagnostic(
            `${base}/textures/${name}/address`,
            `Texture address '${texture.address}' is not permitted by the '${resolved.role}' renderer contract.`,
          ),
        );
      if (
        texture.filter !== undefined &&
        contractSampler &&
        !contractSampler.filterPolicy.includes(texture.filter)
      )
        diagnostics.push(
          diagnostic(
            `${base}/textures/${name}/filter`,
            `Texture filter '${texture.filter}' is not permitted by the '${resolved.role}' renderer contract.`,
          ),
        );
      if (texture.source)
        validateTextureSource(
          project,
          texture.source,
          `${base}/textures/${name}/source`,
          diagnostics,
        );
    }
    return diagnostics;
  }
  for (const [name, parameter] of Object.entries(data.parameters)) {
    const declaration = presetUniform(preset, name);
    if (!declaration) {
      diagnostics.push(
        diagnostic(
          `${base}/parameters/${name}`,
          `Material parameter '${name}' is not present in the preset interface and is retained as orphaned configuration.`,
          'warning',
        ),
      );
      continue;
    }
    if (parameter.value !== undefined && declaration.binding !== undefined)
      diagnostics.push(
        diagnostic(
          `${base}/parameters/${name}/value`,
          `Renderer-bound parameter '${name}' cannot have an authored value.`,
        ),
      );
    if (
      parameter.value !== undefined &&
      !isUniformValueCompatible(declaration.type, parameter.value)
    )
      diagnostics.push(
        diagnostic(
          `${base}/parameters/${name}/value`,
          `Material parameter value does not match ${declaration.type}.`,
        ),
      );
    if (parameter.binding !== undefined && parameter.binding !== declaration.binding)
      diagnostics.push(
        diagnostic(
          `${base}/parameters/${name}/binding`,
          `Parameter binding does not match the '${preset.id}' preset contract.`,
        ),
      );
  }
  for (const [name, texture] of Object.entries(data.textures)) {
    const capability = preset.samplerCapabilities[name];
    const declared = capability !== undefined && capability !== 'disabled';
    const roleContract = materialContractRegistry.roles.find((role) => role.id === preset.role);
    const contractSampler = roleContract?.reservedInterface.samplers.find(
      (sampler) => sampler.name === name,
    );
    if (!declared)
      diagnostics.push(
        diagnostic(
          `${base}/textures/${name}`,
          `Material texture '${name}' is not present in the preset interface and is retained as orphaned configuration.`,
          'warning',
        ),
      );
    else {
      const rendererOwned = contractSampler?.sourceOwnership === 'renderer';
      if (texture.source !== undefined && rendererOwned)
        diagnostics.push(
          diagnostic(
            `${base}/textures/${name}/source`,
            `Renderer-bound texture '${name}' cannot have an authored source.`,
          ),
        );
      const contractBinding = contractSampler?.semantic;
      if (
        texture.binding !== undefined &&
        (!contractBinding || texture.binding !== contractBinding)
      )
        diagnostics.push(
          diagnostic(
            `${base}/textures/${name}/binding`,
            `Texture binding does not match the '${preset.id}' preset contract.`,
          ),
        );
      if (
        texture.address !== undefined &&
        contractSampler &&
        !contractSampler.addressPolicy.includes(texture.address)
      )
        diagnostics.push(
          diagnostic(
            `${base}/textures/${name}/address`,
            `Texture address '${texture.address}' is not permitted by the '${preset.role}' renderer contract.`,
          ),
        );
      if (
        texture.filter !== undefined &&
        contractSampler &&
        !contractSampler.filterPolicy.includes(texture.filter)
      )
        diagnostics.push(
          diagnostic(
            `${base}/textures/${name}/filter`,
            `Texture filter '${texture.filter}' is not permitted by the '${preset.role}' renderer contract.`,
          ),
        );
    }
    if (texture.source)
      validateTextureSource(
        project,
        texture.source,
        `${base}/textures/${name}/source`,
        diagnostics,
      );
  }
  return diagnostics;
}
function validateTextureSource(
  project: AuthoringProject,
  source: MaterialTextureSource,
  path: string,
  diagnostics: MaterialSchemaDiagnostic[],
) {
  if ('$ref' in source) {
    const asset = project.assets[source.$ref.id];
    if (!asset) {
      diagnostics.push(diagnostic(`${path}/$ref`, `Missing texture asset '${source.$ref.id}'.`));
      return;
    }
    const data = parseAssetData(asset.data);
    if (!data)
      diagnostics.push(
        diagnostic(`${path}/$ref`, `Asset '${source.$ref.id}' has invalid asset data.`),
      );
    else if (data.kind !== 'image')
      diagnostics.push(
        diagnostic(
          `${path}/$ref`,
          `Asset '${source.$ref.id}' is ${data.kind}, not image.`,
          'warning',
        ),
      );
  }
}
export function materialPresetId(
  project: AuthoringProject,
  materialId: string,
): MaterialPresetId | null {
  return resolveMaterialData(project, materialId).data?.preset.id ?? null;
}
export function materialRole(project: AuthoringProject, materialId: string): ShaderRole | null {
  return resolveMaterialData(project, materialId).data?.role ?? null;
}
export function materialRoleIsCompatible(
  project: AuthoringProject,
  materialId: string,
  role: ShaderRole,
): boolean {
  return materialRole(project, materialId) === role;
}

export function materialCanInheritFrom(
  project: AuthoringProject,
  materialId: string,
  candidateBaseId: string,
): boolean {
  if (candidateBaseId === materialId || !project.materials[candidateBaseId]) return false;
  const seen = new Set<string>();
  let currentId = candidateBaseId;
  while (currentId) {
    if (currentId === materialId || seen.has(currentId)) return false;
    seen.add(currentId);
    const data = parseMaterialData(project.materials[currentId]?.data);
    if (!data) return false;
    if (data.base.kind === 'preset') return true;
    currentId = data.base.material.$ref.id;
  }
  return false;
}
