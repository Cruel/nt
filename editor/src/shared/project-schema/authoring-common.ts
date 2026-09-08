import { z } from 'zod';

export const entityIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const layoutContractIdPattern = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

export const entityIdSchema = z
  .string()
  .regex(
    entityIdPattern,
    'ID must be lowercase kebab-case, start with a letter, and contain only letters, numbers, and hyphens.',
  );

export const layoutContractIdSchema = z
  .string()
  .regex(
    layoutContractIdPattern,
    'Layout contract IDs must start with a lowercase letter and contain only lowercase letters, numbers, hyphens, and underscores.',
  );

export type EntityId = z.infer<typeof entityIdSchema>;
export type LayoutContractId = z.infer<typeof layoutContractIdSchema>;

export function isValidEntityId(value: string): boolean {
  return entityIdPattern.test(value);
}

export function isValidLayoutContractId(value: string): boolean {
  return layoutContractIdPattern.test(value);
}
