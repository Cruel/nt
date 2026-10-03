import { z } from 'zod';
import { readSchemaDocumentation, validateSchemaExamples } from './schema-documentation';

export function schemaReferenceJson(schema: z.ZodType, reused: 'inline' | 'ref' = 'inline') {
  return z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
    reused,
    override: ({ zodSchema, jsonSchema }) => {
      validateSchemaExamples(
        zodSchema,
        readSchemaDocumentation(z.globalRegistry.get(zodSchema) ?? {}),
      );
      // Zod's converter omits tuple cardinality; isolate this narrow definition lookup here.
      if (zodSchema instanceof z.ZodTuple) {
        const { items, rest } = zodSchema.def;
        jsonSchema.minItems = items.reduce(
          (minimum, item, index) => (z.safeParse(item, undefined).success ? minimum : index + 1),
          0,
        );
        if (!rest) {
          jsonSchema.maxItems = items.length;
          jsonSchema.items = false;
        }
      }
    },
  });
}
