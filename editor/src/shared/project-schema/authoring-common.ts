import { z } from 'zod';

export const entityIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const entityIdSchema = z.string().regex(
  entityIdPattern,
  'ID must be lowercase kebab-case, start with a letter, and contain only letters, numbers, and hyphens.',
);

export type EntityId = z.infer<typeof entityIdSchema>;

export function isValidEntityId(value: string): boolean {
  return entityIdPattern.test(value);
}
