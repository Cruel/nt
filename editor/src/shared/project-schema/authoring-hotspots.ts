import { z } from 'zod';
import { entityIdSchema } from './authoring-common';
import { conditionSchema } from './authoring-flow';
import { materialApplicationSchema } from './authoring-material-applications';

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

export const hotspotMotionInterpolationSchema = z.enum(['hold', 'linear']);
export const hotspotMotionKeyframeSchema = strict({
  timeMs: z.number().int().nonnegative(),
  interpolation: hotspotMotionInterpolationSchema,
  active: z.boolean(),
  bounds: imageNormalizedRectSchema,
});
export const hotspotMotionTrackSchema = strict({
  motionId: entityIdSchema,
  keyframes: z.array(hotspotMotionKeyframeSchema).min(1),
}).superRefine((track, context) => {
  for (let index = 1; index < track.keyframes.length; index += 1) {
    if (track.keyframes[index]!.timeMs <= track.keyframes[index - 1]!.timeMs)
      context.addIssue({
        code: 'custom',
        path: ['keyframes', index, 'timeMs'],
        message: 'Hotspot motion keyframe times must be strictly increasing.',
      });
  }
});

export const hotspotHighlightSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('default') }),
  strict({ kind: z.literal('material'), materialApplication: materialApplicationSchema }),
  strict({ kind: z.literal('none') }),
]);

export const hotspotCommonShape = {
  id: entityIdSchema,
  label: z.string().check(z.trim(), z.minLength(1)),
  condition: conditionSchema,
  inputOrder: z.number().int().min(-2147483648).max(2147483647),
  highlight: hotspotHighlightSchema,
};

export const rectHotspotShapeSchema = strict({
  kind: z.literal('rect'),
  bounds: imageNormalizedRectSchema,
});

export const motionTrackedRectHotspotShapeSchema = strict({
  kind: z.literal('rect'),
  bounds: imageNormalizedRectSchema,
  motionTracks: z.array(hotspotMotionTrackSchema).optional(),
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
export type HotspotMotionTrack = z.infer<typeof hotspotMotionTrackSchema>;
export type HotspotHighlight = z.infer<typeof hotspotHighlightSchema>;
export type HotspotRefData = z.infer<typeof hotspotRefSchema>;

export function sampleHotspotMotionTrack(
  bounds: ImageNormalizedRect,
  tracks: readonly HotspotMotionTrack[] | undefined,
  motionId: string,
  timeMs: number,
): ImageNormalizedRect | null {
  const track = tracks?.find((candidate) => candidate.motionId === motionId);
  if (!track) return bounds;
  const nextIndex = track.keyframes.findIndex((keyframe) => timeMs < keyframe.timeMs);
  if (nextIndex === 0) return bounds;
  const current = track.keyframes[nextIndex < 0 ? track.keyframes.length - 1 : nextIndex - 1]!;
  if (!current.active) return null;
  const next = nextIndex < 0 ? undefined : track.keyframes[nextIndex];
  if (current.interpolation !== 'linear' || !next?.active || next.timeMs <= current.timeMs)
    return current.bounds;
  const amount = Math.max(
    0,
    Math.min(1, (timeMs - current.timeMs) / (next.timeMs - current.timeMs)),
  );
  const lerp = (from: number, to: number) => from + (to - from) * amount;
  return {
    x: lerp(current.bounds.x, next.bounds.x),
    y: lerp(current.bounds.y, next.bounds.y),
    width: lerp(current.bounds.width, next.bounds.width),
    height: lerp(current.bounds.height, next.bounds.height),
  };
}

export const defaultHotspotBehavior = (label: string) => ({
  id: 'primary',
  label: label.trim() || 'Interactable',
  condition: { kind: 'always' as const },
  inputOrder: 0,
  highlight: { kind: 'default' as const },
  target: { kind: 'owner' as const },
});
