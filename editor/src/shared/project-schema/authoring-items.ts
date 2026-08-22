import { z } from 'zod';
import { entityIdSchema } from './authoring-common';
import { assetRefSchema, materialRefSchema } from './authoring-flow';
import { inventoryReferenceSchema } from './authoring-inventories';
import { interactableLocationSchema } from './authoring-interactables';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const MAX_ITEM_STACK_QUANTITY = Number.MAX_SAFE_INTEGER;

export const itemDefinitionRefSchema = strict({
  $ref: strict({ collection: z.literal('itemDefinitions'), id: entityIdSchema }),
});

export const itemStackRefSchema = strict({
  $ref: strict({ collection: z.literal('itemStacks'), id: entityIdSchema }),
});

export const itemDefinitionDataSchema = strict({
  kind: z.literal('item-definition'),
  displayName: z.string(),
  description: z.string(),
  presentation: strict({
    sprite: assetRefSchema.nullable(),
    material: materialRefSchema.nullable(),
  }),
  stackLimit: z.number().int().positive().max(MAX_ITEM_STACK_QUANTITY).nullable(),
});

export const itemStackDataSchema = strict({
  kind: z.literal('item-stack'),
  definition: itemDefinitionRefSchema,
  quantity: z.number().int().positive().max(MAX_ITEM_STACK_QUANTITY),
  location: interactableLocationSchema,
});

export type ItemDefinitionData = z.infer<typeof itemDefinitionDataSchema>;
export type ItemStackData = z.infer<typeof itemStackDataSchema>;
export type ItemDefinitionRef = z.infer<typeof itemDefinitionRefSchema>;
export type ItemStackRef = z.infer<typeof itemStackRefSchema>;

export function defaultItemDefinitionData(label = 'Item'): ItemDefinitionData {
  return {
    kind: 'item-definition',
    displayName: label,
    description: '',
    presentation: { sprite: null, material: null },
    stackLimit: null,
  };
}

export function defaultItemStackData(definitionId: string): ItemStackData {
  return {
    kind: 'item-stack',
    definition: { $ref: { collection: 'itemDefinitions', id: definitionId } },
    quantity: 1,
    location: { kind: 'unplaced' },
  };
}

export function parseItemDefinitionData(value: unknown): ItemDefinitionData | null {
  const parsed = itemDefinitionDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseItemStackData(value: unknown): ItemStackData | null {
  const parsed = itemStackDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function itemStackInventoryReference(
  stack: ItemStackData,
): z.infer<typeof inventoryReferenceSchema> | null {
  return stack.location.kind === 'inventory' ? stack.location.inventory : null;
}
