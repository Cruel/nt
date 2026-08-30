import { z } from 'zod';
import { entityIdSchema } from './authoring-common';
import {
  inventoryOwnerSchema,
  inventoryReferenceSchema,
  type InventoryOwner,
  type InventoryReference,
} from './authoring-flow';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const inventoryDefinitionSchema = strict({
  id: entityIdSchema,
  label: z.string().check(z.trim(), z.minLength(1)),
});

export type InventoryDefinitionData = z.infer<typeof inventoryDefinitionSchema>;
export type InventoryOwnerData = InventoryOwner;
export type InventoryReferenceData = InventoryReference;

export { inventoryOwnerSchema, inventoryReferenceSchema };

export const PROJECT_INVENTORY_ID = 'inventory';
export const PROJECT_INVENTORY_LABEL = 'Inventory';
export const DEFAULT_PROJECT_INVENTORY: InventoryDefinitionData = Object.freeze({
  id: PROJECT_INVENTORY_ID,
  label: PROJECT_INVENTORY_LABEL,
});

export function projectInventoryRef(): InventoryReferenceData {
  return { owner: { kind: 'project' }, inventoryId: PROJECT_INVENTORY_ID };
}

export function characterInventoryRef(
  characterId: string,
  inventoryId: string,
): InventoryReferenceData {
  return {
    owner: {
      kind: 'character',
      character: { $ref: { collection: 'characters', id: characterId } },
    },
    inventoryId,
  };
}

export function interactableInventoryRef(
  interactableId: string,
  inventoryId: string,
): InventoryReferenceData {
  return {
    owner: {
      kind: 'interactable',
      interactable: { $ref: { registry: 'interactableInstances', id: interactableId } },
    },
    inventoryId,
  };
}
