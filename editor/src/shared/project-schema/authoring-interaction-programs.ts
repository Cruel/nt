import { z } from 'zod';
import {
  conditionSchema,
  dialogueRefSchema,
  effectSchema,
  flowTargetSchema,
  interactableRefSchema,
  roomRefSchema,
  sceneRefSchema,
  textContentSchema,
} from './authoring-flow';
import { entityIdSchema } from './authoring-common';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const interactionRoomPlacementRefSchema = strict({
  room: entityIdSchema,
  placement: entityIdSchema,
});

export const interactionMoveTargetSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('inventory') }),
  strict({ kind: z.literal('nowhere') }),
  strict({ kind: z.literal('room-placement'), placement: interactionRoomPlacementRefSchema }),
]);

const instructionBase = { id: entityIdSchema };

export const interactionInstructionSchema = z.discriminatedUnion('kind', [
  strict({ ...instructionBase, kind: z.literal('apply-effect'), effect: effectSchema }),
  strict({ ...instructionBase, kind: z.literal('move-interactable'), interactable: interactableRefSchema, target: interactionMoveTargetSchema }),
  strict({ ...instructionBase, kind: z.literal('set-interactable-state'), interactable: interactableRefSchema, enabled: z.boolean().optional(), visible: z.boolean().optional() }),
  strict({ ...instructionBase, kind: z.literal('notify'), message: textContentSchema }),
  strict({ ...instructionBase, kind: z.literal('call-scene'), scene: sceneRefSchema }),
  strict({ ...instructionBase, kind: z.literal('call-dialogue'), dialogue: dialogueRefSchema }),
]);

export const interactionProgramSchema = strict({
  instructions: z.array(interactionInstructionSchema),
  completion: flowTargetSchema,
  outcome: z.enum(['handled', 'unhandled']),
});

export const interactionContextSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('any') }),
  strict({ kind: z.literal('active-room'), room: roomRefSchema }),
  strict({ kind: z.literal('room-placement'), placement: interactionRoomPlacementRefSchema }),
  strict({ kind: z.literal('predicate'), condition: conditionSchema }),
]);

export type InteractionRoomPlacementRef = z.infer<typeof interactionRoomPlacementRefSchema>;
export type InteractionMoveTarget = z.infer<typeof interactionMoveTargetSchema>;
export type InteractionInstruction = z.infer<typeof interactionInstructionSchema>;
export type InteractionProgram = z.infer<typeof interactionProgramSchema>;
export type InteractionContext = z.infer<typeof interactionContextSchema>;

export function defaultInteractionProgram(): InteractionProgram {
  return { instructions: [], completion: { kind: 'return' }, outcome: 'handled' };
}
