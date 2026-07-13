import { z } from 'zod';
import { conditionSchema, textContentSchema } from './authoring-flow';
import { defaultInteractionProgram, interactionProgramSchema } from './authoring-interaction-programs';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const verbArityValues = [0, 1, 2] as const;
export const verbDataSchema = strict({
  kind: z.literal('verb'),
  arity: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  operandRoles: z.array(z.string().min(1)).max(2),
  actionText: textContentSchema,
  quickAction: z.boolean(),
  availability: conditionSchema,
  defaultProgram: interactionProgramSchema,
}).refine((value) => value.operandRoles.length === value.arity, {
  path: ['operandRoles'],
  message: 'Operand role count must match verb arity.',
});

export type VerbData = z.infer<typeof verbDataSchema>;

export function parseVerbData(value: unknown): VerbData | null {
  const parsed = verbDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function defaultVerbData(label = 'Verb'): VerbData {
  return {
    kind: 'verb',
    arity: 0,
    operandRoles: [],
    actionText: { source: { kind: 'inline', text: label }, markup: 'plain' },
    quickAction: false,
    availability: { kind: 'always' },
    defaultProgram: defaultInteractionProgram(),
  };
}
