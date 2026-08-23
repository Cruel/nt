import { z } from 'zod';
import { entityIdPattern, entityIdSchema } from './authoring-common';
import { conditionSchema, textContentSchema } from './authoring-flow';
import { interactionSubjectSchema } from './authoring-features';
import { itemDefinitionRefSchema } from './authoring-items';
import {
  defaultInteractionProgram,
  interactionProgramSchema,
} from './authoring-interaction-programs';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const subjectFamilyValues = ['character', 'interactable', 'feature', 'item-stack'] as const;
export const subjectFamilySchema = z.enum(subjectFamilyValues);

const traitRefSchema = strict({
  $ref: strict({ collection: z.literal('traits'), id: entityIdSchema }),
});

const qualifiedPatternSchema = z
  .string()
  .min(2)
  .refine((value) => value.endsWith('*') && !value.slice(0, -1).includes('*'), {
    message: 'Qualified subject patterns must contain exactly one trailing wildcard.',
  });

export const subjectSelectorSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('any-subject') }),
  strict({ kind: z.literal('family'), family: subjectFamilySchema }),
  strict({ kind: z.literal('trait'), trait: traitRefSchema }),
  strict({ kind: z.literal('item-definition'), itemDefinition: itemDefinitionRefSchema }),
  strict({
    kind: z.literal('qualified-pattern'),
    family: subjectFamilySchema,
    pattern: qualifiedPatternSchema,
  }),
  strict({ kind: z.literal('exact'), subject: interactionSubjectSchema }),
]);

export const verbSlotSchema = strict({
  id: entityIdSchema,
  label: textContentSchema,
  prompt: textContentSchema,
  selectors: z.array(subjectSelectorSchema).min(1),
});

export const verbOfferSchema = strict({
  id: entityIdSchema,
  slotId: entityIdSchema,
  selectors: z.array(subjectSelectorSchema).min(1),
  condition: conditionSchema.optional(),
  rank: z.number().int(),
  primary: z.boolean(),
});

export function validateVerbNamedTemplate(
  text: string,
  slotIds: ReadonlySet<string>,
  templateName = 'Verb text',
): string | null {
  const placeholders = /\{([^{}]*)\}/g;
  for (const match of text.matchAll(placeholders)) {
    const placeholder = match[1] ?? '';
    if (!entityIdPattern.test(placeholder))
      return `${templateName} placeholder '{${placeholder}}' must use a Verb slot ID.`;
    if (!slotIds.has(placeholder))
      return `${templateName} placeholder '{${placeholder}}' does not name a Verb slot.`;
  }
  if (text.replace(placeholders, '').includes('{') || text.replace(placeholders, '').includes('}'))
    return `${templateName} placeholders must use the form {slot-id}.`;
  return null;
}

export function validateCompletedCommandTemplate(
  text: string,
  slotIds: ReadonlySet<string>,
): string | null {
  return validateVerbNamedTemplate(text, slotIds, 'Completed-command');
}

export const verbDataSchema = strict({
  kind: z.literal('verb'),
  slots: z.array(verbSlotSchema),
  bindingOrder: z.array(entityIdSchema),
  actionText: textContentSchema,
  completedCommandText: textContentSchema,
  offers: z.array(verbOfferSchema),
  availability: conditionSchema,
  defaultProgram: interactionProgramSchema,
}).superRefine((value, context) => {
  const ids = value.slots.map((slot) => slot.id);
  if (new Set(ids).size !== ids.length)
    context.addIssue({ code: 'custom', path: ['slots'], message: 'Verb slot IDs must be unique.' });
  if (
    value.bindingOrder.length !== ids.length ||
    new Set(value.bindingOrder).size !== value.bindingOrder.length ||
    value.bindingOrder.some((id) => !ids.includes(id))
  )
    context.addIssue({
      code: 'custom',
      path: ['bindingOrder'],
      message: 'Binding order must contain every Verb slot exactly once.',
    });
  const slotIds = new Set(ids);
  const offerIds = value.offers.map((offer) => offer.id);
  if (new Set(offerIds).size !== offerIds.length)
    context.addIssue({
      code: 'custom',
      path: ['offers'],
      message: 'Verb Offer IDs must be unique.',
    });
  value.offers.forEach((offer, index) => {
    if (!slotIds.has(offer.slotId))
      context.addIssue({
        code: 'custom',
        path: ['offers', index, 'slotId'],
        message: `Verb Offer slot '${offer.slotId}' must name a Verb slot.`,
      });
  });
  if (value.completedCommandText.source.kind === 'inline') {
    const message = validateCompletedCommandTemplate(
      value.completedCommandText.source.text,
      slotIds,
    );
    if (message)
      context.addIssue({
        code: 'custom',
        path: ['completedCommandText', 'source', 'text'],
        message,
      });
  }
  value.slots.forEach((slot, index) => {
    for (const [field, text] of [
      ['label', slot.label],
      ['prompt', slot.prompt],
    ] as const) {
      if (text.source.kind !== 'inline') continue;
      const message = validateVerbNamedTemplate(text.source.text, slotIds, `Slot ${field}`);
      if (message)
        context.addIssue({
          code: 'custom',
          path: ['slots', index, field, 'source', 'text'],
          message,
        });
    }
  });
});

export type SubjectSelector = z.infer<typeof subjectSelectorSchema>;
export type VerbSlot = z.infer<typeof verbSlotSchema>;
export type VerbOffer = z.infer<typeof verbOfferSchema>;
export type VerbData = z.infer<typeof verbDataSchema>;

export function parseVerbData(value: unknown): VerbData | null {
  const parsed = verbDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function defaultVerbData(label = 'Verb'): VerbData {
  return {
    kind: 'verb',
    slots: [],
    bindingOrder: [],
    actionText: { source: { kind: 'inline', text: label }, markup: 'plain' },
    completedCommandText: { source: { kind: 'inline', text: label }, markup: 'plain' },
    offers: [],
    availability: { kind: 'always' },
    defaultProgram: defaultInteractionProgram(),
  };
}
