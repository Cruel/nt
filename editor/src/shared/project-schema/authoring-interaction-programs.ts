import { z } from 'zod';
import { flowTargetSchema, gameplayCommandSchema } from './authoring-flow';
import { withSchemaDocumentation } from './schema-documentation';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const interactionProgramSchema = strict({
  instructions: z.array(gameplayCommandSchema),
  completion: flowTargetSchema,
  outcome: withSchemaDocumentation(z.enum(['handled', 'unhandled']), {
    description:
      'Handled stops fallback. Unhandled requires empty behavior with no committed work and advances to the next fallback stage for the host of this program. The complete chain is selected rule → Verb defaultProgram → Project undefinedInteractionProgram → engine response. Runtime failure aborts without fallback and does not rewind earlier observable boundaries.',
  }),
});

export const undefinedInteractionProgramSchema = withSchemaDocumentation(
  interactionProgramSchema.nullable(),
  {
    description:
      'Project-owned fallback in project.json, tried after the selected Verb defaultProgram returns Unhandled. Null skips to the engine undefined-interaction response; a handled Project program stops the chain.',
    examples: [
      {
        title: 'Project fallback that declines to the engine response',
        value: { instructions: [], completion: { kind: 'return' }, outcome: 'unhandled' },
      },
    ],
  },
);

export type InteractionProgram = z.infer<typeof interactionProgramSchema>;

export function defaultInteractionProgram(): InteractionProgram {
  return { instructions: [], completion: { kind: 'return' }, outcome: 'handled' };
}
