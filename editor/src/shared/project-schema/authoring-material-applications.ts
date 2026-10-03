import { z } from 'zod';
import { entityIdSchema } from './authoring-common';
import { materialRefSchema } from './authoring-flow';
import { assetTextureRefSchema } from './authoring-materials';
import { withSchemaDocumentation } from './schema-documentation';
import {
  isUniformValueCompatible,
  shaderUniformTypeValues,
  shaderUniformValueSchema,
  type ShaderUniformType,
  type ShaderUniformValue,
} from './authoring-shaders';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const materialStandardFacetValues = [
  'occurrence-time',
  'paint-width',
  'paint-height',
  'viewport-width',
  'viewport-height',
  'camera-zoom',
] as const;

export const materialApplicationParameterSourceSchema = withSchemaDocumentation(
  z.discriminatedUnion('kind', [
    strict({ kind: z.literal('literal'), value: shaderUniformValueSchema }),
    strict({ kind: z.literal('property'), property: entityIdSchema }),
    strict({ kind: z.literal('standard-facet'), facet: z.enum(materialStandardFacetValues) }),
  ]),
  { name: 'MaterialParameterSource' },
);

export const materialApplicationParameterOverrideSchema = withSchemaDocumentation(
  strict({
    type: z.enum(shaderUniformTypeValues),
    source: materialApplicationParameterSourceSchema,
  }).superRefine((override, context) => {
    if (
      override.source.kind === 'literal' &&
      !isUniformValueCompatible(override.type, override.source.value)
    )
      context.addIssue({
        code: 'custom',
        path: ['source', 'value'],
        message: `Literal value is incompatible with Material parameter type '${override.type}'.`,
      });
  }),
  { name: 'MaterialParameterOverride' },
);

export const materialApplicationTextureOverrideSchema = withSchemaDocumentation(
  strict({ source: assetTextureRefSchema }),
  { name: 'MaterialTextureOverride' },
);

export const materialApplicationSchema = withSchemaDocumentation(
  strict({
    material: materialRefSchema,
    parameters: z.record(z.string().min(1), materialApplicationParameterOverrideSchema).default({}),
    textures: z.record(z.string().min(1), materialApplicationTextureOverrideSchema).default({}),
  }),
  { name: 'MaterialApplication' },
);

export const materialApplicationSpecializationSchema = withSchemaDocumentation(
  strict({
    material: materialRefSchema.nullable(),
    parameters: z.record(z.string().min(1), materialApplicationParameterOverrideSchema).default({}),
    textures: z.record(z.string().min(1), materialApplicationTextureOverrideSchema).default({}),
  }),
  { name: 'MaterialApplicationSpecialization' },
);

export type MaterialStandardFacet = (typeof materialStandardFacetValues)[number];
export type MaterialApplicationParameterSource = z.infer<
  typeof materialApplicationParameterSourceSchema
>;
export type MaterialApplicationParameterOverride = z.infer<
  typeof materialApplicationParameterOverrideSchema
>;
export type MaterialApplicationTextureOverride = z.infer<
  typeof materialApplicationTextureOverrideSchema
>;
export type MaterialApplication = z.infer<typeof materialApplicationSchema>;
export type MaterialApplicationSpecialization = z.infer<
  typeof materialApplicationSpecializationSchema
>;

export function emptyMaterialApplication(materialId: string): MaterialApplication {
  return {
    material: { $ref: { collection: 'materials', id: materialId } },
    parameters: {},
    textures: {},
  };
}

export function emptyMaterialApplicationSpecialization(): MaterialApplicationSpecialization {
  return { material: null, parameters: {}, textures: {} };
}

export function effectiveMaterialApplication(
  inherited: MaterialApplication | null,
  specialization: MaterialApplicationSpecialization,
): MaterialApplication | null {
  const material = specialization.material ?? inherited?.material ?? null;
  if (!material) return null;
  return {
    material,
    parameters: { ...inherited?.parameters, ...specialization.parameters },
    textures: { ...inherited?.textures, ...specialization.textures },
  };
}

export function materialApplicationLiteral(
  type: ShaderUniformType,
  value: ShaderUniformValue,
): MaterialApplicationParameterOverride {
  return materialApplicationParameterOverrideSchema.parse({
    type,
    source: { kind: 'literal', value },
  });
}
