import { z } from 'zod';
import { entityIdSchema } from './authoring-common';
import { characterRefSchema, roomRefSchema } from './authoring-flow';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const interactableInstanceRefSchema = strict({
  $ref: strict({ registry: z.literal('interactableInstances'), id: entityIdSchema }),
});

export const inventoryDefinitionSchema = strict({
  id: entityIdSchema,
  label: z.string().check(z.trim(), z.minLength(1)),
});

export const inventoryOwnerSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('project') }),
  strict({ kind: z.literal('character'), character: characterRefSchema }),
  strict({ kind: z.literal('interactable'), interactable: interactableInstanceRefSchema }),
  strict({ kind: z.literal('room-feature'), room: roomRefSchema, featureId: entityIdSchema }),
  strict({
    kind: z.literal('interactable-feature'),
    interactable: interactableInstanceRefSchema,
    featureId: entityIdSchema,
  }),
]);

export const inventoryReferenceSchema = strict({
  owner: inventoryOwnerSchema,
  inventoryId: entityIdSchema,
});

export type InventoryDefinitionData = z.infer<typeof inventoryDefinitionSchema>;
export type InventoryOwnerData = z.infer<typeof inventoryOwnerSchema>;
export type InventoryReferenceData = z.infer<typeof inventoryReferenceSchema>;

export function projectInventoryRef(inventoryId: string): InventoryReferenceData {
  return { owner: { kind: 'project' }, inventoryId };
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
