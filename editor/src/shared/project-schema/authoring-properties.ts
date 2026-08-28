import { z } from 'zod';
import { entityIdSchema } from './authoring-common';

export const propertyOwnerKindValues = [
  'room',
  'character',
  'interactable',
  'feature',
  'item-stack',
] as const;
export const propertyValueTypeValues = ['boolean', 'integer', 'number', 'string', 'enum'] as const;

export const authoredRuntimeValueSchema = z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
]);

export const propertyDefinitionSchema = z
  .object({
    id: entityIdSchema,
    label: z.string().min(1),
    description: z.string().optional(),
    type: z.enum(propertyValueTypeValues),
    nullable: z.boolean(),
    defaultValue: authoredRuntimeValueSchema.optional(),
    enumValues: z.array(z.string().min(1)).optional(),
    ownerKinds: z.array(z.enum(propertyOwnerKindValues)).min(1),
  })
  .strict()
  .superRefine((definition, context) => {
    const enumValues = definition.enumValues ?? [];
    if (definition.type === 'enum') {
      if (enumValues.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['enumValues'],
          message: 'Enum properties require at least one enum value.',
        });
      }
      if (new Set(enumValues).size !== enumValues.length) {
        context.addIssue({
          code: 'custom',
          path: ['enumValues'],
          message: 'Enum property values must be unique.',
        });
      }
    } else if (definition.enumValues !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['enumValues'],
        message: 'enumValues is valid only for enum properties.',
      });
    }
    if (definition.defaultValue === undefined) return;
    if (!isPropertyValueCompatible(definition, definition.defaultValue)) {
      context.addIssue({
        code: 'custom',
        path: ['defaultValue'],
        message: 'Default value does not match the property declaration.',
      });
    }
  });

export const ownerLocalPropertySchema = z
  .object({
    id: entityIdSchema,
    label: z.string().min(1).optional(),
    description: z.string().optional(),
    type: z.enum(propertyValueTypeValues),
    nullable: z.boolean(),
    value: authoredRuntimeValueSchema,
    enumValues: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .superRefine((property, context) => {
    const enumValues = property.enumValues ?? [];
    if (property.type === 'enum') {
      if (enumValues.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['enumValues'],
          message: 'Enum properties require at least one enum value.',
        });
      }
      if (new Set(enumValues).size !== enumValues.length) {
        context.addIssue({
          code: 'custom',
          path: ['enumValues'],
          message: 'Enum property values must be unique.',
        });
      }
    } else if (property.enumValues !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['enumValues'],
        message: 'enumValues is valid only for enum properties.',
      });
    }
    if (!isPropertyValueCompatible(property, property.value)) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Value does not match the property declaration.',
      });
    }
  });

export const ownerLocalPropertiesSchema = z
  .array(ownerLocalPropertySchema)
  .superRefine((items, context) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      if (seen.has(item.id))
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `Property '${item.id}' is declared more than once on this owner.`,
        });
      seen.add(item.id);
    });
  });

export const propertyAssignmentsSchema = z.record(entityIdSchema, authoredRuntimeValueSchema);

export const traitPropertySchema = z
  .object({
    id: entityIdSchema,
    label: z.string().min(1).optional(),
    description: z.string().optional(),
    type: z.enum(propertyValueTypeValues),
    nullable: z.boolean(),
    defaultValue: authoredRuntimeValueSchema.optional(),
    enumValues: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .superRefine((property, context) => {
    const enumValues = property.enumValues ?? [];
    if (property.type === 'enum') {
      if (enumValues.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['enumValues'],
          message: 'Enum Trait Properties require at least one enum value.',
        });
      }
      if (new Set(enumValues).size !== enumValues.length) {
        context.addIssue({
          code: 'custom',
          path: ['enumValues'],
          message: 'Enum Trait Property values must be unique.',
        });
      }
    } else if (property.enumValues !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['enumValues'],
        message: 'enumValues is valid only for enum Trait Properties.',
      });
    }
    if (
      property.defaultValue !== undefined &&
      !isPropertyValueCompatible(property, property.defaultValue)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['defaultValue'],
        message: 'Default does not match the Trait Property declaration.',
      });
    }
  });

export const traitDefinitionSchema = z
  .object({
    id: entityIdSchema,
    label: z.string().min(1),
    description: z.string().optional(),
    ownerKinds: z.array(z.enum(propertyOwnerKindValues)).min(1),
    properties: z.array(traitPropertySchema),
  })
  .strict()
  .superRefine((trait, context) => {
    if (new Set(trait.ownerKinds).size !== trait.ownerKinds.length) {
      context.addIssue({
        code: 'custom',
        path: ['ownerKinds'],
        message: 'Trait owner kinds must be unique.',
      });
    }
    const propertyIds = trait.properties.map((property) => property.id);
    if (new Set(propertyIds).size !== propertyIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['properties'],
        message: 'Trait properties must be unique.',
      });
    }
  });

export type PropertyOwnerKind = (typeof propertyOwnerKindValues)[number];
export type PropertyDefinition = z.infer<typeof propertyDefinitionSchema>;
export type AuthoredRuntimeValue = z.infer<typeof authoredRuntimeValueSchema>;
export type OwnerLocalProperty = z.infer<typeof ownerLocalPropertySchema>;
export type PropertyAssignments = z.infer<typeof propertyAssignmentsSchema>;
export type TraitProperty = z.infer<typeof traitPropertySchema>;
export type TraitDefinition = z.infer<typeof traitDefinitionSchema>;

export function isPropertyValueCompatible(
  definition: Pick<PropertyDefinition, 'type' | 'nullable' | 'enumValues'>,
  value: AuthoredRuntimeValue,
): boolean {
  if (value === null) return definition.nullable;
  if (definition.type === 'boolean') return typeof value === 'boolean';
  if (definition.type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (definition.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (definition.type === 'string') return typeof value === 'string';
  return typeof value === 'string' && (definition.enumValues ?? []).includes(value);
}

export function arePropertySchemasCompatible(
  left: Pick<PropertyDefinition, 'type' | 'nullable' | 'enumValues'>,
  right: Pick<PropertyDefinition, 'type' | 'nullable' | 'enumValues'>,
): boolean {
  if (left.type !== right.type || left.nullable !== right.nullable) return false;
  if (left.type !== 'enum') return true;
  const leftValues = left.enumValues ?? [];
  const rightValues = right.enumValues ?? [];
  return (
    leftValues.length === rightValues.length &&
    leftValues.every((value, index) => value === rightValues[index])
  );
}

export function authoredRuntimeValuesEqual(
  left: AuthoredRuntimeValue,
  right: AuthoredRuntimeValue,
): boolean {
  return Object.is(left, right);
}
