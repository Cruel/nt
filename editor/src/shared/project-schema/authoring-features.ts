import { z } from 'zod';
import { entityIdSchema } from './authoring-common';
import { characterRefSchema, interactableRefSchema, roomRefSchema } from './authoring-flow';
import { propertyAssignmentsSchema } from './authoring-properties';
import { inventoryDefinitionSchema } from './authoring-inventories';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const featureDataSchema = strict({
  id: entityIdSchema,
  label: z.string().check(z.trim(), z.minLength(1)),
  traits: z.array(entityIdSchema),
  properties: propertyAssignmentsSchema,
  inventories: z.array(inventoryDefinitionSchema),
});

export const featureRefSchema = z.discriminatedUnion('ownerKind', [
  strict({
    ownerKind: z.literal('room'),
    room: roomRefSchema,
    featureId: entityIdSchema,
  }),
  strict({
    ownerKind: z.literal('interactable'),
    interactable: interactableRefSchema,
    featureId: entityIdSchema,
  }),
]);

export const interactionSubjectSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('character'), character: characterRefSchema }),
  strict({ kind: z.literal('interactable'), interactable: interactableRefSchema }),
  strict({ kind: z.literal('feature'), feature: featureRefSchema }),
  strict({
    kind: z.literal('item-stack'),
    itemStack: strict({
      $ref: strict({ collection: z.literal('itemStacks'), id: entityIdSchema }),
    }),
  }),
]);

export const roomHotspotTargetSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('owner-feature'), featureId: entityIdSchema }),
  strict({ kind: z.literal('subject'), subject: interactionSubjectSchema }),
  strict({ kind: z.literal('exit'), exitId: entityIdSchema }),
]);

export const interactableHotspotTargetSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('owner') }),
  strict({ kind: z.literal('owner-feature'), featureId: entityIdSchema }),
  strict({ kind: z.literal('subject'), subject: interactionSubjectSchema }),
]);

export type FeatureData = z.infer<typeof featureDataSchema>;
export type FeatureRefData = z.infer<typeof featureRefSchema>;
export type InteractionSubjectData = z.infer<typeof interactionSubjectSchema>;
export type RoomHotspotTarget = z.infer<typeof roomHotspotTargetSchema>;
export type InteractableHotspotTarget = z.infer<typeof interactableHotspotTargetSchema>;

export function roomFeatureRef(roomId: string, featureId: string): FeatureRefData {
  return {
    ownerKind: 'room',
    room: { $ref: { collection: 'rooms', id: roomId } },
    featureId,
  };
}

export function interactableFeatureRef(interactableId: string, featureId: string): FeatureRefData {
  return {
    ownerKind: 'interactable',
    interactable: { $ref: { collection: 'interactables', id: interactableId } },
    featureId,
  };
}
