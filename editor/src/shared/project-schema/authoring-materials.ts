import { z } from 'zod';
import { parseAssetData } from './authoring-assets';
import { entityIdSchema } from './authoring-common';
import type { AuthoringProject, AuthoringRecordBase, ReferenceTarget } from './authoring-project';
import {
  isUniformValueCompatible,
  shaderUniformValueSchema,
  shaderRoleValues,
  type ShaderData,
  type ShaderRole,
  type ShaderUniformData,
  type ShaderRef,
  shaderRef,
  parseShaderData,
} from './authoring-shaders';

export const materialBlendValues = ['premultiplied-alpha'] as const;
export const materialTextureFilteringValues = [
  'clamp-nearest',
  'clamp-linear',
  'repeat-nearest',
  'repeat-linear',
] as const;
export const materialPreviewGeometryValues = ['quad', 'rounded-rect', 'sprite', 'glyphs'] as const;
export const materialPreviewBackgroundValues = ['transparent', 'checker', 'dark', 'light'] as const;
export const postprocessScopeValues = ['world', 'full-game-viewport'] as const;

export type MaterialBlend = (typeof materialBlendValues)[number];
export type MaterialTextureFiltering = (typeof materialTextureFilteringValues)[number];
export type PostprocessScope = (typeof postprocessScopeValues)[number];

export const assetTextureRefSchema = z
  .object({
    $ref: z.object({ collection: z.literal('assets'), id: z.string().min(1) }).strict(),
  })
  .strict();

export const materialTextureSourceSchema = z.union([
  assetTextureRefSchema,
  z.object({ alias: z.string().min(1) }).strict(),
  z.object({ uri: z.string().min(1) }).strict(),
]);

export const materialUniformOverrideSchema = z
  .object({
    name: z.string().min(1),
    value: shaderUniformValueSchema,
  })
  .strict();

export const materialTextureDataSchema = z
  .object({
    sampler: z.string().min(1),
    source: materialTextureSourceSchema,
    filtering: z.enum(materialTextureFilteringValues).default('clamp-linear'),
  })
  .strict();

export const materialDataSchema = z
  .object({
    kind: z.literal('material').default('material'),
    baseMaterialId: entityIdSchema.nullable().default(null),
    displayName: z.string().optional(),
    shader: z
      .object({
        $ref: z.object({ collection: z.literal('shaders'), id: z.string().min(1) }).strict(),
      })
      .strict()
      .nullable()
      .default(null),
    role: z.enum(shaderRoleValues).default('engine-2d'),
    postprocessScope: z.enum(postprocessScopeValues).default('world'),
    blend: z.enum(materialBlendValues).default('premultiplied-alpha'),
    uniforms: z.array(materialUniformOverrideSchema).default([]),
    textures: z.array(materialTextureDataSchema).default([]),
    preview: z
      .object({
        geometry: z.enum(materialPreviewGeometryValues).default('quad'),
        background: z.enum(materialPreviewBackgroundValues).default('checker'),
      })
      .strict()
      .default({ geometry: 'quad', background: 'checker' }),
  })
  .strict();

export type AssetTextureRef = z.infer<typeof assetTextureRefSchema>;
export type MaterialTextureSource = z.infer<typeof materialTextureSourceSchema>;
export type MaterialUniformOverride = z.infer<typeof materialUniformOverrideSchema>;
export type MaterialTextureData = z.infer<typeof materialTextureDataSchema>;
export type MaterialData = z.infer<typeof materialDataSchema>;

export interface MaterialSchemaDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
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

export function defaultMaterialData(label = 'Material', shaderId?: string): MaterialData {
  return materialDataSchema.parse({
    kind: 'material',
    baseMaterialId: null,
    displayName: label,
    shader: shaderId ? shaderRef(shaderId) : null,
    role: 'engine-2d',
    postprocessScope: 'world',
    blend: 'premultiplied-alpha',
    uniforms: [],
    textures: [],
    preview: { geometry: 'quad', background: 'checker' },
  });
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

export function resolveMaterialData(
  project: AuthoringProject,
  materialId: string,
): { data: MaterialData | null; diagnostics: MaterialSchemaDiagnostic[] } {
  const diagnostics: MaterialSchemaDiagnostic[] = [];
  const seen = new Set<string>();
  const stack: MaterialData[] = [];
  let currentId: string | null = materialId;
  while (currentId) {
    if (seen.has(currentId)) {
      diagnostics.push(
        diagnostic(
          `/materials/${materialId}/data/baseMaterialId`,
          'Material inheritance chain contains a cycle.',
        ),
      );
      break;
    }
    seen.add(currentId);
    const record = project.materials[currentId];
    if (!record) {
      diagnostics.push(
        diagnostic(
          `/materials/${materialId}/data/baseMaterialId`,
          `Missing base material '${currentId}'.`,
        ),
      );
      break;
    }
    const data = parseMaterialData(record.data);
    if (!data) {
      diagnostics.push(
        diagnostic(
          `/materials/${currentId}/data`,
          `Material '${currentId}' has invalid material data.`,
        ),
      );
      break;
    }
    stack.push(data);
    currentId = data.baseMaterialId;
  }
  if (stack.length === 0) return { data: null, diagnostics };
  const data = stack.reverse().reduce((base, next) => mergeMaterialData(base, next));
  return { data, diagnostics };
}

function mergeMaterialData(base: MaterialData, next: MaterialData): MaterialData {
  const uniformMap = new Map(base.uniforms.map((item) => [item.name, item]));
  next.uniforms.forEach((item) => uniformMap.set(item.name, item));
  const textureMap = new Map(base.textures.map((item) => [item.sampler, item]));
  next.textures.forEach((item) => textureMap.set(item.sampler, item));
  return materialDataSchema.parse({
    ...base,
    ...next,
    baseMaterialId: next.baseMaterialId,
    uniforms: [...uniformMap.values()],
    textures: [...textureMap.values()],
    preview: { ...base.preview, ...next.preview },
  });
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
  if (data.baseMaterialId) {
    if (data.baseMaterialId === materialId) {
      diagnostics.push(
        diagnostic(`${base}/baseMaterialId`, 'Material cannot inherit from itself.'),
      );
    } else if (!project.materials[data.baseMaterialId]) {
      diagnostics.push(
        diagnostic(`${base}/baseMaterialId`, `Missing base material '${data.baseMaterialId}'.`),
      );
    } else {
      const resolution = resolveMaterialData(project, materialId);
      diagnostics.push(...resolution.diagnostics);
    }
  }
  let shader: ShaderData | null = null;
  if (!data.shader) {
    diagnostics.push(diagnostic(`${base}/shader`, 'Material must reference a shader.'));
  } else {
    const shaderRecord = project.shaders[data.shader.$ref.id];
    if (!shaderRecord) {
      diagnostics.push(
        diagnostic(`${base}/shader/$ref`, `Missing shader '${data.shader.$ref.id}'.`),
      );
    } else {
      shader = parseShaderData(shaderRecord.data);
      if (!shader)
        diagnostics.push(
          diagnostic(
            `${base}/shader/$ref`,
            `Shader '${data.shader.$ref.id}' has invalid shader data.`,
          ),
        );
      else if (!shader.roles.includes(data.role))
        diagnostics.push(
          diagnostic(
            `${base}/role`,
            `Shader '${data.shader.$ref.id}' does not support role '${data.role}'.`,
          ),
        );
    }
  }

  const uniformDeclarations = new Map<string, ShaderUniformData>(
    (shader?.uniforms ?? []).map((item) => [item.name, item]),
  );
  const uniforms = new Set<string>();
  data.uniforms.forEach((uniform, index) => {
    const path = `${base}/uniforms/${index}`;
    if (uniforms.has(uniform.name))
      diagnostics.push(diagnostic(`${path}/name`, `Duplicate uniform override '${uniform.name}'.`));
    uniforms.add(uniform.name);
    const declaration = uniformDeclarations.get(uniform.name);
    if (!declaration)
      diagnostics.push(
        diagnostic(`${path}/name`, `Material assigns undeclared shader uniform '${uniform.name}'.`),
      );
    else if (!isUniformValueCompatible(declaration.type, uniform.value))
      diagnostics.push(
        diagnostic(`${path}/value`, `Uniform override does not match ${declaration.type}.`),
      );
  });

  const samplerDeclarations = new Set((shader?.samplers ?? []).map((sampler) => sampler.name));
  const textures = new Set<string>();
  data.textures.forEach((texture, index) => {
    const path = `${base}/textures/${index}`;
    if (textures.has(texture.sampler))
      diagnostics.push(
        diagnostic(`${path}/sampler`, `Duplicate texture slot '${texture.sampler}'.`),
      );
    textures.add(texture.sampler);
    if (!samplerDeclarations.has(texture.sampler))
      diagnostics.push(
        diagnostic(
          `${path}/sampler`,
          `Material assigns undeclared shader sampler '${texture.sampler}'.`,
        ),
      );
    validateTextureSource(project, texture.source, `${path}/source`, diagnostics);
  });
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

export function materialShaderId(data: MaterialData | null): string | null {
  return data?.shader?.$ref.id ?? null;
}

export function materialRoleIsCompatible(shader: ShaderData | null, role: ShaderRole): boolean {
  return !!shader && shader.roles.includes(role);
}

export function makeShaderRef(shaderId: string): ShaderRef {
  return shaderRef(shaderId);
}
