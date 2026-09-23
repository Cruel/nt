import { z } from 'zod';
import { entityIdSchema } from './authoring-common';
import { materialRefSchema } from './authoring-flow';
import { assetTextureRefSchema } from './authoring-materials';
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

export const materialApplicationParameterSourceSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('literal'), value: shaderUniformValueSchema }),
  strict({ kind: z.literal('property'), property: entityIdSchema }),
  strict({ kind: z.literal('standard-facet'), facet: z.enum(materialStandardFacetValues) }),
]);

export const materialApplicationParameterOverrideSchema = strict({
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
});

export const materialApplicationTextureOverrideSchema = strict({
  source: assetTextureRefSchema,
});

export const materialApplicationSchema = strict({
  material: materialRefSchema,
  parameters: z.record(z.string().min(1), materialApplicationParameterOverrideSchema).default({}),
  textures: z.record(z.string().min(1), materialApplicationTextureOverrideSchema).default({}),
});

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

export function emptyMaterialApplication(materialId: string): MaterialApplication {
  return {
    material: { $ref: { collection: 'materials', id: materialId } },
    parameters: {},
    textures: {},
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
