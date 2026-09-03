import { z } from 'zod';
import { entityIdSchema } from './authoring-common';

const ref = <T extends string>(collection: T) =>
  z
    .object({
      $ref: z.object({ collection: z.literal(collection), id: entityIdSchema }).strict(),
    })
    .strict();

export const prefetchHintTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('asset'), asset: ref('assets') }).strict(),
  z.object({ kind: z.literal('scene'), scene: ref('scenes') }).strict(),
  z.object({ kind: z.literal('dialogue'), dialogue: ref('dialogues') }).strict(),
  z.object({ kind: z.literal('room'), room: ref('rooms') }).strict(),
  z.object({ kind: z.literal('layout'), layout: ref('layouts') }).strict(),
]);

export const prefetchHintPointSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('scene-entry'), scene: ref('scenes') }).strict(),
  z
    .object({ kind: z.literal('scene-step'), scene: ref('scenes'), stepId: entityIdSchema })
    .strict(),
  z.object({ kind: z.literal('scene-terminal'), scene: ref('scenes') }).strict(),
  z.object({ kind: z.literal('dialogue-entry'), dialogue: ref('dialogues') }).strict(),
  z
    .object({
      kind: z.literal('dialogue-position'),
      dialogue: ref('dialogues'),
      blockId: entityIdSchema,
      segmentId: entityIdSchema.optional(),
      edgeId: entityIdSchema.optional(),
      stage: z.enum([
        'enter-block',
        'present-segment',
        'apply-segment-effects',
        'present-choices',
        'apply-choice-effects',
        'follow-edge',
      ]),
      cursor: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ kind: z.literal('dialogue-terminal'), dialogue: ref('dialogues') }).strict(),
  z
    .object({
      kind: z.literal('room-lifecycle'),
      room: ref('rooms'),
      stage: z.enum(['before-leave', 'before-enter', 'presentation', 'after-leave', 'after-enter']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('interaction-rule'),
      interaction: ref('interactions'),
      ruleId: entityIdSchema,
    })
    .strict(),
  z.object({ kind: z.literal('verb-default'), verb: ref('verbs') }).strict(),
  z.object({ kind: z.literal('undefined-interaction') }).strict(),
  z.object({ kind: z.literal('resident-layout'), layout: ref('layouts') }).strict(),
]);

export const prefetchHintAttachmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('point'), point: prefetchHintPointSchema }).strict(),
  z
    .object({
      kind: z.literal('room'),
      room: ref('rooms'),
      scope: z.enum(['entry-path', 'resident']),
    })
    .strict(),
]);

export const prefetchHintSchema = z
  .object({
    id: entityIdSchema,
    target: prefetchHintTargetSchema,
    attachment: prefetchHintAttachmentSchema,
  })
  .strict();

export type PrefetchHintTarget = z.infer<typeof prefetchHintTargetSchema>;
export type PrefetchHintPoint = z.infer<typeof prefetchHintPointSchema>;
export type PrefetchHintAttachment = z.infer<typeof prefetchHintAttachmentSchema>;
export type PrefetchHint = z.infer<typeof prefetchHintSchema>;
