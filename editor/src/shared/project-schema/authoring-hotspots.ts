import { z } from 'zod';
import { entityIdSchema } from './authoring-common';
import { conditionSchema, materialRefSchema, verbRefSchema } from './authoring-flow';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const imageNormalizedRectSchema = strict({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
  width: z.number().finite().positive().max(1),
  height: z.number().finite().positive().max(1),
}).superRefine((bounds, context) => {
  if (bounds.x + bounds.width > 1)
    context.addIssue({
      code: 'custom',
      path: ['width'],
      message: 'Rectangle exceeds image width.',
    });
  if (bounds.y + bounds.height > 1)
    context.addIssue({
      code: 'custom',
      path: ['height'],
      message: 'Rectangle exceeds image height.',
    });
});

export const hotspotHighlightSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('default') }),
  strict({ kind: z.literal('material'), material: materialRefSchema }),
  strict({ kind: z.literal('none') }),
]);

export const hotspotCommonShape = {
  id: entityIdSchema,
  label: z.string().trim().min(1),
  condition: conditionSchema,
  inputOrder: z.number().int().min(-2147483648).max(2147483647),
  highlight: hotspotHighlightSchema,
};

export const rectHotspotShapeSchema = strict({
  kind: z.literal('rect'),
  bounds: imageNormalizedRectSchema,
});

export const verbHotspotActivationSchema = strict({
  kind: z.literal('verb'),
  verb: verbRefSchema.nullable(),
});

export const roomHotspotRefSchema = strict({
  kind: z.literal('room-hotspot'),
  room: strict({ $ref: strict({ collection: z.literal('rooms'), id: entityIdSchema }) }),
  hotspotId: entityIdSchema,
});

export const interactableHotspotRefSchema = strict({
  kind: z.literal('interactable-hotspot'),
  interactable: strict({
    $ref: strict({ collection: z.literal('interactables'), id: entityIdSchema }),
  }),
  hotspotId: entityIdSchema,
});

export const hotspotRefSchema = z.discriminatedUnion('kind', [
  roomHotspotRefSchema,
  interactableHotspotRefSchema,
]);

export type ImageNormalizedRect = z.infer<typeof imageNormalizedRectSchema>;
export type HotspotHighlight = z.infer<typeof hotspotHighlightSchema>;
export type HotspotRefData = z.infer<typeof hotspotRefSchema>;

export const defaultHotspotBehavior = (label: string) => ({
  id: 'primary',
  label: label.trim() || 'Interactable',
  condition: { kind: 'always' as const },
  inputOrder: 0,
  highlight: { kind: 'default' as const },
  activation: { kind: 'verb' as const, verb: null },
});
