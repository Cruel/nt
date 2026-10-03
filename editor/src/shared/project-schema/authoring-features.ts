import { z } from 'zod';
import { entityIdSchema } from './authoring-common';
import { characterRefSchema, roomRefSchema } from './authoring-flow';
import { ownerDefaultPropertiesSchema, ownerLocalPropertiesSchema } from './authoring-properties';
import { inventoryDefinitionSchema } from './authoring-inventories';
import { withSchemaDocumentation } from './schema-documentation';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const interactableInstanceRefSchema = strict({
  $ref: strict({ registry: z.literal('interactableInstances'), id: entityIdSchema }),
});

export const featureDataSchema = withSchemaDocumentation(
  strict({
    id: entityIdSchema,
    label: z.string().check(z.trim(), z.minLength(1)),
    traits: z.array(entityIdSchema),
    localProperties: ownerLocalPropertiesSchema,
    defaultProperties: ownerDefaultPropertiesSchema,
    inventories: z.array(inventoryDefinitionSchema),
  }),
  {
    constraints: [
      'Room Features are concrete gameplay identities: defaultProperties must be empty and Property values belong in localProperties.',
      'Interactable-definition Features are reusable configuration: localProperties must be empty and Property defaults belong in defaultProperties.',
    ],
    related: ['Room Feature', 'Interactable-definition Feature', 'Property'],
  },
);

export const featureRefSchema = withSchemaDocumentation(
  z.discriminatedUnion('ownerKind', [
    strict({
      ownerKind: z.literal('room'),
      room: roomRefSchema,
      featureId: entityIdSchema,
    }),
    strict({
      ownerKind: z.literal('interactable'),
      interactable: interactableInstanceRefSchema,
      featureId: entityIdSchema,
    }),
  ]),
  {
    description:
      'Owner-qualified Feature identity: the Feature must exist on the effective/live owner configuration. Room Features require their active Room; Interactable Features follow the exact owner Instance eligibility, including visible/enabled Inventory-held owners.',
  },
);

export const interactionSubjectSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('character'), character: characterRefSchema }),
  strict({ kind: z.literal('interactable'), interactable: interactableInstanceRefSchema }),
  strict({ kind: z.literal('feature'), feature: featureRefSchema }),
]);

export const roomHotspotTargetSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('none') }),
  strict({ kind: z.literal('owner-feature'), featureId: entityIdSchema }),
  strict({ kind: z.literal('subject'), subject: interactionSubjectSchema }),
  strict({ kind: z.literal('exit'), exitId: entityIdSchema }),
]);

export const interactableHotspotTargetSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('none') }),
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
    interactable: { $ref: { registry: 'interactableInstances', id: interactableId } },
    featureId,
  };
}
