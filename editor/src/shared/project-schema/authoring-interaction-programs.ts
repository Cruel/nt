import { z } from 'zod';
import { flowTargetSchema, gameplayCommandSchema } from './authoring-flow';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const interactionProgramSchema = strict({
  instructions: z.array(gameplayCommandSchema),
  completion: flowTargetSchema,
  outcome: z.enum(['handled', 'unhandled']),
});

export type InteractionProgram = z.infer<typeof interactionProgramSchema>;

export function defaultInteractionProgram(): InteractionProgram {
  return { instructions: [], completion: { kind: 'return' }, outcome: 'handled' };
}
