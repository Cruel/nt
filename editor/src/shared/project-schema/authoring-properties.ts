import { z } from 'zod';
import { entityIdSchema } from './authoring-common';

export const propertyOwnerKindValues = [
  'room',
  'scene',
  'dialogue',
  'character',
  'interactable',
  'verb',
  'interaction',
  'map',
] as const;
export const propertyValueTypeValues = ['boolean', 'integer', 'number', 'string', 'enum'] as const;
export const propertyPersistenceValues = ['Session', 'Save'] as const;

export const authoredRuntimeValueSchema = z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
]);

export const propertyDefinitionSchema = z.object({
  id: entityIdSchema,
  label: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(propertyValueTypeValues),
  nullable: z.boolean(),
  defaultValue: authoredRuntimeValueSchema.optional(),
  enumValues: z.array(z.string().min(1)).optional(),
  ownerKinds: z.array(z.enum(propertyOwnerKindValues)).min(1),
  persistence: z.enum(propertyPersistenceValues),
}).strict().superRefine((definition, context) => {
  const enumValues = definition.enumValues ?? [];
  if (definition.type === 'enum') {
    if (enumValues.length === 0) {
      context.addIssue({ code: 'custom', path: ['enumValues'], message: 'Enum properties require at least one enum value.' });
    }
    if (new Set(enumValues).size !== enumValues.length) {
      context.addIssue({ code: 'custom', path: ['enumValues'], message: 'Enum property values must be unique.' });
    }
  } else if (definition.enumValues !== undefined) {
    context.addIssue({ code: 'custom', path: ['enumValues'], message: 'enumValues is valid only for enum properties.' });
  }
  if (definition.defaultValue === undefined) return;
  if (!isPropertyValueCompatible(definition, definition.defaultValue)) {
    context.addIssue({ code: 'custom', path: ['defaultValue'], message: 'Default value does not match the property declaration.' });
  }
});

export const propertyAssignmentsSchema = z.record(entityIdSchema, authoredRuntimeValueSchema);

export type PropertyOwnerKind = (typeof propertyOwnerKindValues)[number];
export type PropertyDefinition = z.infer<typeof propertyDefinitionSchema>;
export type AuthoredRuntimeValue = z.infer<typeof authoredRuntimeValueSchema>;
export type PropertyAssignments = z.infer<typeof propertyAssignmentsSchema>;

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
